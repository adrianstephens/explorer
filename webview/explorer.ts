import { vscode, RPC, handleResult, createElement, fixupElements, ScrollBar, generateSelector, selectorsBetween, MessageOut as MessageOut0, RpcMessage, template } from '@isopodlabs/vscode_utils/webview/shared.js';
import { Tree, updateStuck } from '@isopodlabs/vscode_utils/webview/tree.js';

export type MessageOut = MessageOut0
	| {command: 'ready'}
	| {command: 'copyFile', target: string, data: ArrayBuffer | string, mtime?: number, move?: boolean}
	| {command: 'drag_start', source: string, selector: string}
	| {command: 'load', entry: string, requestId: number}

export type MessageIn =
	| {command: 'update', selector: string}
	| {command: 'add_class', selector: string, class: string, enable: boolean}
	| {command: 'scroll_to', selector: string}

export type MessageRpc =
	| {command: 'get_select_range', from: string, to: string, result: string[]}
	| {command: 'edit', selector: string, result: string};

export interface Context {
	entry:			string,
	isSelected:		boolean;
	selectionCount:	number;
}

interface State {
	scroll: number;
	open: string[];
};

function postMessage(message: MessageOut) {
	vscode.postMessage(message);
}

const state: State	= { open:[], scroll: 0, ...vscode.getState() };
const vscroll 		= new ScrollBar(document.body, document.documentElement, false);
const treeRoot		= document.querySelector<HTMLElement>('.tree')!;

function getSelectedEntries() {
	return Array.from(
		treeRoot.querySelectorAll<HTMLElement>('.select.selected[data-entry]'),
		el => el.dataset.entry!
	);
}

function rowFromEventTarget(target: EventTarget | null): HTMLElement | null {
	return target instanceof Element ? target.closest<HTMLElement>('.select') : null;
}

const tree	= new Tree(treeRoot, (element, open) => {
	const row	= element.querySelector<HTMLElement>('.select');
	const entry = row?.dataset.entry;
	if (!entry)
		return;
	if (open) {
		state.open.push(entry);
		const children = element.querySelector<HTMLElement>('.children');
		if (children?.childElementCount === 0)
			load(children, entry);

	} else {
		const index = state.open.indexOf(entry);
		if (index !== -1)
			state.open.splice(index, 1);
	}
	vscode.setState(state);
	vscroll.update();
	updateStuck();
});

document.addEventListener('DOMContentLoaded', async () => {
	await load(treeRoot, treeRoot.dataset.entry!);

	if (state.open.length) {
		for (const i of state.open) {
			const caret = await loadRecursive(i);
			if (caret)
				tree.open(caret);
		}
	} else {
		state.open = tree.all_open().map(e => e.dataset.entry!);
		vscode.setState(state);
	}
	window.scrollTo(0, state.scroll);
	vscroll.update();
	updateStuck();
});

document.addEventListener("scroll", _event => {
	vscroll.update();
	updateStuck();
	state.scroll = window.scrollY;
	vscode.setState(state);
});

function beginEditElement(target: HTMLElement): Promise<string> {
	const original		= target.textContent || '';
	const originalHtml	= target.innerHTML;
	const input			= createElement('input', {className: 'zip-edit-input', type: 'text', value: original});

	target.innerHTML	= '';
	target.appendChild(input);
	target.classList.add('editing');

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
			if (event.key === 'Enter' || event.key === 'Escape') {
				event.preventDefault();
				finish(event.key === 'Enter');
			}
		});
		input.addEventListener('blur', () => finish?.(true), {once: true});
	});
}

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

const INTERNAL_DND_MIME = 'application/x-vscode-zip-entries';

tree.dragAndDrop({
	start(target, data) {
		const row	= rowFromEventTarget(target);
		const entry = row?.dataset.entry;
		if (!row || !entry || !(target instanceof Node && (row === target || row.contains(target))))
			return;

		const selectedEntries = getSelectedEntries();
		const entries = selectedEntries.includes(entry) && selectedEntries.length > 0 ? selectedEntries : [entry];
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
		console.log('over', target);

		const row = target.closest<HTMLElement>('.caret')?.querySelector<HTMLElement>('.zip-folder');
//		const row = rowFromEventTarget(target);
		if (row?.classList.contains('zip-folder')) {
			data.dropEffect = 'copy';

			if (data.types.includes(INTERNAL_DND_MIME)) {

				if (row?.dataset.entry?.startsWith(ctx[0]))
					data.dropEffect = 'none';

				else if (!modifierKey)
					data.dropEffect = 'move';
			}

			return row;
		}

		data.dropEffect = 'none';
	},
	drop(ctx: string[], target, data, effect) {
		const dir			= target.dataset.entry ?? '';
		const resourceUrls	= data.getData(INTERNAL_DND_MIME) ?? data.getData('resourceurls');

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

treeRoot.addEventListener('contextmenu', event => {
	const row = rowFromEventTarget(event.target);
	if (!row?.dataset.entry)
		return;

	const selectedEntries	= getSelectedEntries();
	const isSelected		= selectedEntries.includes(row.dataset.entry);
	const payload: Context = {
		entry:			row.dataset.entry,
		isSelected,
		selectionCount: isSelected ? selectedEntries.length : 1,
	};

	row.dataset.vscodeContext = JSON.stringify(payload);
}, true);

function add(dest: HTMLElement, template_id: string, values: Record<string, any>[]) {
	const source = document.getElementById(template_id) as HTMLTemplateElement;
	if (!source)
		return;

	const templateSource = source instanceof HTMLTemplateElement
		? source.content.firstElementChild as HTMLElement | null
		: source;
	if (!templateSource)
		return;

	const children = template(templateSource, dest, values);
	for (const child of children) {
		tree.fixup(child);
		fixupElements(child);
	}
}

async function load(dest: HTMLElement, entry: string) {
	const result = await RPC<{dirs: Record<string, any>[], files: Record<string, any>[]}>({command: 'load', entry});
	dest.innerHTML = '';
	add(dest, 'directory-template', result.dirs);
	add(dest, 'entry-template', result.files);
}

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


window.addEventListener('message', event => {
	if (handleResult(event.data))
		return;

	const e = event.data as MessageIn | RpcMessage<MessageRpc>;

    switch (e.command) {
		case 'update': {
			const dest = document.querySelector<HTMLElement>(e.selector);
			if (!dest) {
				load(treeRoot, '');

			} else {
				const children = dest.parentElement!.querySelector<HTMLElement>('.children');
				if (children && children.childElementCount !== 0)
					load(children, dest.dataset.entry!);
			}

			vscroll.update();
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
		case 'get_select_range': {
			vscode.postMessage({
				resultId: e.requestId,
				result: selectorsBetween(document, e.from, e.to),
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