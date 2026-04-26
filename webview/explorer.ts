import { vscode, modKey2, RPC, handleResult, createElement, fixupIcons, ScrollBar, generateSelector, RpcMessage } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Tree } from '@isopodlabs/vscode_utils/webview/tree.js';

export type MessageOut =
	| {command: 'ready'}
	| {command: 'copyFile', target: string, data: ArrayBuffer | string, mtime?: number, move?: boolean}
	| {command: 'drag_start', source: string, selector: string}
	| {command: 'load', entry: string, requestId: number}
	| {command: 'open', entry: string, isSelected: boolean, selection: string[]}
	| {command: 'delete'}

export type MessageIn =
	| {command: 'update', selector: string}
	| {command: 'add_class', selector: string, class: string, enable: boolean}
	| {command: 'scroll_to', selector: string}

export type MessageRpc =
	| {command: 'context', result: Context}
	| {command: 'edit', selector: string, result: string};

export interface Context {
	entry:			string,
	isSelected:		boolean;
	selectionCount:	number;
	selection?:		string[];
}

interface State {
	scroll:		number;
	open:		Set<string>;
	selected:	Set<string>;
};

function postMessage(message: MessageOut) {
	vscode.postMessage(message);
}
function getState(): State {
	const state = { open:[], selected:[], scroll: 0, ...vscode.getState() };
	return {scroll: state.scroll, open: new Set(state.open), selected: new Set(state.selected)};
}

const	state	= getState();
let		stateTimer: number | undefined;

function setState(state: State) {
	if (stateTimer !== undefined)
		clearTimeout(stateTimer);

	stateTimer = window.setTimeout(() => {
		stateTimer = undefined;
		vscode.setState({scroll: state.scroll, open: Array.from(state.open), selected: Array.from(state.selected)});
	}, 150);

}

function nextFrame() {
	return new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
}

const INTERNAL_DND_MIME = 'application/x-vscode-zip-entries';
const treeRoot		= document.querySelector<HTMLElement>('.tree')!;
const vscroll 		= new ScrollBar(document.body, {
	get clientOffset()          { return Math.round(treeRoot.getBoundingClientRect().top + Math.max(treeRoot.clientTop, 0)); },
	get clientPixels()          { return treeRoot.clientHeight; },
	get clientSize()            { return treeRoot.clientHeight; },
	get scrollOffset()          { return treeRoot.scrollTop; },
	get scrollSize()            { return treeRoot.scrollHeight; },
	set scrollOffset(x: number) { treeRoot.scrollTop = x; },
}, false);

//-----------------------------------------------------------------------------
// tree helpers
//-----------------------------------------------------------------------------

let rowHeightInitialized = false;
function initRowHeight() {
	if (rowHeightInitialized)
		return;

	const row = treeRoot.querySelector<HTMLElement>('.leaf, .folder');
	if (row) {
		const height = Math.ceil(row.getBoundingClientRect().height);
		if (height > 0) {
			treeRoot.style.setProperty('--row-height', `${height}px`);
			rowHeightInitialized = true;
		}
	}
}

function rowFromEventTarget(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element ? target.closest<HTMLElement>('.select') : null;
}

function elementFromEntry(entry: string) {
	return document.querySelector(`.select[data-entry="${entry}"]`);
}

let layoutFrame = 0;
function scheduleLayoutUpdate() {
	tree.updateStuck();

	if (layoutFrame)
		return;

	layoutFrame = requestAnimationFrame(() => {
		layoutFrame = 0;
		vscroll.update();
	});
}

const tree	= new Tree(treeRoot, (element, open) => {
	const row	= element.querySelector<HTMLElement>('.select');
	const entry = row?.dataset.entry;
	if (!entry)
		return;
	if (open) {
		state.open.add(entry);
		const children = element.querySelector<HTMLElement>('.children');
		if (children?.childElementCount === 0)
			load(children, entry);

	} else {
		state.open.delete(entry);
	}
	setState(state);
	scheduleLayoutUpdate();
});

const baseToggle = tree.toggle.bind(tree);
tree.toggle = (caret: HTMLElement) => {
	const willOpen = !tree.is_open(caret);
	if (!willOpen) {
		baseToggle(caret);
		return;
	}

	const children = caret.querySelector<HTMLElement>(':scope > .children');
	const alreadyLoaded = !!children && children.childElementCount > 0;
	if (!alreadyLoaded) {
		baseToggle(caret);
		return;
	}

	void (async () => {
		caret.classList.add('expanding');
		try {
			// Give the browser a full paint turn so the spinner is visible before heavy expand work.
			await nextFrame();
			await nextFrame();
			baseToggle(caret);
		} finally {
			caret.classList.remove('expanding');
		}
	})();
};

//-----------------------------------------------------------------------------
// rename
//-----------------------------------------------------------------------------

function beginEditElement(target: HTMLElement): Promise<string> {
	const original		= target.textContent || '';
	const originalHtml	= target.innerHTML;
	const input			= createElement('input', {type: 'text', value: original});

	target.innerHTML	= '';
	target.appendChild(input);
	target.classList.add('editing');
	const targetRect	= target.getBoundingClientRect();
	const inputRect		= input.getBoundingClientRect();
	const inputOffset	= Math.max(0, Math.floor(inputRect.left - targetRect.left));
	input.style.setProperty('--edit-input-offset', `${inputOffset}px`);

	input.focus();
	input.select();

	return new Promise<string>(resolve => {
		let finish = (commit: boolean) => {
			finish = undefined as any;
			const newValue = input.value.trim();
			target.classList.remove('editing');
			target.innerHTML = originalHtml;
			resolve(commit && newValue && newValue !== original ? newValue : '');
		};

		input.addEventListener('keydown', event => {
			event.stopPropagation();
			if (event.key === 'Enter' || event.key === 'Escape') {
				event.preventDefault();
				finish(event.key === 'Enter');
			}
		});
		input.addEventListener('blur', () => finish?.(true), {once: true});
	});
}

//-----------------------------------------------------------------------------
// drag and drop
//-----------------------------------------------------------------------------

async function copyFiles(entry: FileSystemEntry, path = '') {
	if (entry.isFile) {
		const file		= await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
		postMessage({command: 'copyFile', target: `${path + entry.name}`, data: await file.arrayBuffer(), mtime: file.lastModified});

	} else {
		const dir		= entry as FileSystemDirectoryEntry;
		const reader	= dir.createReader();
		while (true) {
			const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
			if (batch.length === 0)
				break;
			for (const entry of batch)
				await copyFiles(entry, path + dir.name + '/');
		}
	}
}

tree.dragAndDrop({
	start(target, data) {
		const row	= rowFromEventTarget(target);
		const entry = row?.dataset.entry;
		if (!row || !entry || !(target instanceof Node && (row === target || row.contains(target))))
			return;

		const entries = state.selected.has(entry) ? Array.from(state.selected) : [entry];
		if (data) {
			data.setData(INTERNAL_DND_MIME, JSON.stringify(entries));
			data.setData('resourceurls', JSON.stringify(entries));
			data.effectAllowed = 'copyMove';

			const ghost = createElement('div', {className: 'drag-image'});
			ghost.appendChild(entries.length === 1
				? createElement('div', {className: 'drag-lozenge', textContent: entry.split('/').filter(Boolean).at(-1) ?? entry})
				: createElement('div', {className: 'drag-badge', textContent: String(entries.length)})
			);
			document.body.appendChild(ghost);
			data.setDragImage(ghost, -10, -10);
			requestAnimationFrame(() => ghost!.remove());
		}
		postMessage({command: 'drag_start', source: entry, selector: generateSelector(row)});
		return entries;
	},
	over(ctx: string[], target, data, modifierKey) {
		const row = target.closest<HTMLElement>('.caret')?.querySelector<HTMLElement>('.folder')
				?? (target === treeRoot/* || treeRoot.contains(target)*/ ? treeRoot : undefined);
		if (row) {
			data.dropEffect = 'copy';

			if (data.types.includes(INTERNAL_DND_MIME)) {
				if (row !== treeRoot && row.dataset.entry?.startsWith(ctx[0]))
					data.dropEffect = 'none';
				else if (!modifierKey)
					data.dropEffect = 'move';
			}

			return row;
		}

		data.dropEffect = 'none';
	},
	drop(ctx: string[], target, data, effect) {
		const entry = target.dataset.entry ?? '';
		const dir	= target === treeRoot && entry && !entry.endsWith('/') ? `${entry}/` : entry;
		const resourceUrls	= data.getData(INTERNAL_DND_MIME) || data.getData('resourceurls');

		if (resourceUrls) {
			const files = JSON.parse(resourceUrls) as string[];
			for (const file of files) {
				let sep = file.lastIndexOf('/');
				if (sep === file.length - 1) {
					sep = file.lastIndexOf('/', sep - 1);
					postMessage({command: 'copyFile', target: dir + file.slice(sep + 1, -1), data: file.slice(0, -1), move: effect === 'move'});
				} else {
					postMessage({command: 'copyFile', target: dir + file.slice(sep + 1), data: file, move: effect === 'move'});
				}
			}
		} else {
			for (const item of Array.from(data.items)) {
				const entry = item.webkitGetAsEntry();
				if (entry)
					copyFiles(entry, dir);
			}
		}

	},
	changeTarget(from: HTMLElement|undefined, to: HTMLElement|undefined) {
		if (from)
			from.classList.remove('drop-target');
		if (to)
			to.classList.add('drop-target');
	}

});

//-----------------------------------------------------------------------------
// selection handling
//-----------------------------------------------------------------------------

function clearSelection() {
	state.selected.forEach(i => elementFromEntry(i)?.classList.remove('selected'));
	state.selected.clear();
}

function singleSelection(target: HTMLElement) {
	const entry = target.dataset.entry!;
	clearSelection();
	target.classList.add('selected');
	state.selected.add(entry);
	setState(state);
}

function toggleSelection(target: HTMLElement) {
	const entry = target.dataset.entry!;
	if (state.selected.has(entry)) {
		target.classList.remove('selected');
		state.selected.delete(entry);
	} else {
		target.classList.add('selected');
		state.selected.add(entry);
	}
	setState(state);
}

function addSelection(from: HTMLElement, to: HTMLElement) {
	const selects	= Array.from(document.querySelectorAll<HTMLElement>('.select'));
	let index0		= selects.indexOf(from);
	let index1		= selects.indexOf(to);
	const elements	= index0 < 0 || index1 < 0 ? [to]
		: index0 < index1 ? selects.slice(index0, index1 + 1)
		: selects.slice(index1, index0 + 1);

	elements.forEach(i => {
		i.classList.add('selected');
		state.selected.add(i.dataset.entry!);
	});
	setState(state);
}

tree.enableKeyboardNavigation((cursorTo, shiftKey, _modKey) => {
	if (shiftKey && tree.cursor)
		addSelection(tree.cursor, cursorTo);
});


async function load(dest: HTMLElement, entry: string) {
	const caret = dest.parentElement instanceof HTMLElement && dest.parentElement.classList.contains('caret')
		? dest.parentElement
		: undefined;

	try {
		if (caret) {
			caret.classList.add('expanding');
			// Ensure first-time expansion paints the busy indicator before the RPC starts.
			await nextFrame();
		}
		const result = await RPC<{html: string}>({command: 'load', entry});
		dest.innerHTML = result.html;
		tree.fixup(dest);
		fixupIcons(dest);
		initRowHeight();

	} finally {
		caret?.classList.remove('expanding');
	}
}

async function reloadTreeRoot() {
	await load(treeRoot, treeRoot.dataset.entry!);

	async function loadRecursive(entry: string): Promise<HTMLElement | null> {
		let dest = document.querySelector<HTMLElement>(`[data-entry="${entry}"]`);
		if (!dest) {
			const sep = entry.lastIndexOf('/', entry.length - 2);
			if (sep !== -1) {
				if (await loadRecursive(entry.slice(0, sep + 1)))
					dest = document.querySelector<HTMLElement>(`[data-entry="${entry}"]`);
			}
			if (!dest)
				return null;
		}
		const caret = dest.parentElement!;
		const children = caret.querySelector<HTMLElement>('.children');
		if (children) {
			if (children.childElementCount === 0)
				await load(children, entry);
			return caret;
		}
		return null;
	}

	for (const i of state.open) {
		const caret = await loadRecursive(i);
		if (caret)
			tree.open(caret);
	}
	state.selected.forEach(entry => elementFromEntry(entry)?.classList.add('selected'));
}

//-----------------------------------------------------------------------------
// event listeners
//-----------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
	await reloadTreeRoot();
	treeRoot.scrollTop = state.scroll;
	scheduleLayoutUpdate();
});

window.addEventListener('resize', () => {
	scheduleLayoutUpdate();
});

treeRoot.addEventListener("scroll", _event => {
	state.scroll = treeRoot.scrollTop;
	scheduleLayoutUpdate();
	setState(state);
});

treeRoot.addEventListener('contextmenu', event => {
	const row	= rowFromEventTarget(event.target);
	const entry = row?.dataset.entry;
	if (!entry)
		return;

	tree.setCursor(row);
	const isSelected = state.selected.has(entry);
	const payload: Context = {
		entry,
		isSelected,
		selectionCount: isSelected ? state.selected.size : 1,
	};

	row.dataset.vscodeContext = JSON.stringify(payload);
}, true);

treeRoot.addEventListener('click', event => {
	const row	= rowFromEventTarget(event.target);
	const entry = row?.dataset.entry!;
	if (!entry || event.target !== row)
		return;

	if (event.shiftKey) {
		if (tree.cursor)
			addSelection(tree.cursor, row);

	} else if (event[modKey2]) {
		toggleSelection(row);

	} else {
		singleSelection(row);
		postMessage({
			command:	'open',
			entry,
			isSelected:	true,
			selection:	[entry],
		});
	}

	tree.setCursor(row);
	event.stopPropagation();
});

treeRoot.addEventListener('keydown', event => {
	switch (event.key) {
		case 'Enter':
			event.preventDefault();
			if (tree.cursor) {
				const entry 		= tree.cursor?.dataset.entry!;
				const isSelected	= state.selected.has(entry);
				postMessage({
					command: 	'open',
					entry,
					isSelected,
					selection:	isSelected ? Array.from(state.selected) : [entry],
				});
			}
			break;
			
		case ' ':
			event.preventDefault();
			if (tree.cursor)
				toggleSelection(tree.cursor);
			break;

		case 'Backspace':
			event.preventDefault();
			postMessage({command: 'delete'});
			break;
	}
});

window.addEventListener('message', event => {
	if (handleResult(event.data))
		return;

	const e = event.data as MessageIn | RpcMessage<MessageRpc>;

    switch (e.command) {
		case 'update': {
			const dest = document.querySelector<HTMLElement>(e.selector);
			if (!dest || dest === treeRoot) {
				void reloadTreeRoot();

			} else {
				const caret = dest.parentElement;
				const children = caret?.querySelector<HTMLElement>(':scope > .children');
				if (children && children.childElementCount !== 0)
					load(children, dest.dataset.entry!);
			}
			break;
		}

		case 'add_class':
			document.querySelectorAll(e.selector).forEach(i => {
				if (e.enable)
					i.classList.add(e.class);
				else
					i.classList.remove(e.class);
			});
			break;

		case 'scroll_to':
			tree.reveal(document.querySelector(e.selector));
			break;

	//RPC commands
		case 'context': {
			const entry 		= tree.cursor?.dataset.entry!;
			const isSelected	= state.selected.has(entry);
			vscode.postMessage({
				resultId: e.requestId,
				result: {
					entry,
					isSelected,
					selectionCount: isSelected ? state.selected.size : 1,
					selection:		isSelected ? Array.from(state.selected) : [entry],
				}
			});
			break;
		}

		case 'edit': {
			const target = document.querySelector<HTMLElement>(e.selector);
			if (!target) {
				vscode.postMessage({
					resultId: e.requestId,
					result: '',
				});
			} else {
				beginEditElement(target).then((value: string) => {
					vscode.postMessage({
						resultId: e.requestId,
						result: value,
					});
				});
			}
			break;
		}

	}
});