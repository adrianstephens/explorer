import * as vscode from 'vscode';
import { JSX, CSP, CSPdefault, ImportMap, Nonce } from "@isopodlabs/vscode_utils/jsx-runtime";
import { iconAttributes, IconType } from "@isopodlabs/vscode_utils/codicon";
import { IconTheme, loadIconTheme } from "@isopodlabs/vscode_utils/icon-theme";
import { RootDocument, ZipFileSystem } from './ArchiveFilesystem';
import * as fs from '@isopodlabs/vscode_utils/fs';
import * as webview from "@isopodlabs/vscode_utils/webview";
import type { MessageIn, MessageOut, MessageRpc, Context } from "../webview/explorer";

const folderIcon	= new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.blue'));
const fileIcon		= new vscode.ThemeIcon('file', new vscode.ThemeColor('charts.blue'));

function themedIconAttributes(webview: vscode.Webview, theme: IconTheme | undefined, iconId: string | undefined, fallback?: IconType) {
	if (theme && iconId) {
		const def = theme.get_def(webview, iconId);
		if (def) {
			if (def.icon instanceof vscode.Uri) {
				return {
					imgicon: true,
					style: `--icon: url('${def.icon.toString()}')`,
				};
			}
			return def;
		}
	}
	if (fallback)
		return iconAttributes(fallback);
}

const NameColumn = {
	weight: 2.6,
};

const ColumnType: Record<string, {fr: number, format: (x: any) => string}> = {
	string:		{fr: 1.2, format: (x: string) => x},
	number:		{fr: 1,   format: x => x.toLocaleString()},
	boolean:	{fr: 0.8, format: x => x ? 'true' : 'false'},
	time:		{fr: 1.6, format: x => x ? new Date(x).toLocaleString() : ''},
	path:		{fr: 2,   format: x => x},
};
type ColumnType = keyof typeof ColumnType;

interface ColumnDescriptor {
	label:		string;
	type:		ColumnType;
}

const DefaultColumnDescriptors: Record<string, ColumnDescriptor> = {
	size:			{label: 'Size',            type: 'number'},
	compressedSize:	{label: 'Compressed Size', type: 'number'},
	mtime:			{label: 'Modified',        type: 'time'},
	ctime:			{label: 'Created',         type: 'time'},
	owner:			{label: 'Owner',           type: 'string'},
}

function discoverColumns(supported: string[]): Record<string, ColumnDescriptor> {
	const columns: Record<string, ColumnDescriptor> = {};
	const keys		= new Set<string>(supported);
	for (const key in DefaultColumnDescriptors) {
		if (keys.has(key))
			columns[key] = DefaultColumnDescriptors[key];
	}
	return columns;
}

/*
function findOpenTab(uri: vscode.Uri, viewType?: string): vscode.Tab | undefined {
	const key = uri.toString();
	for (const group of vscode.window.tabGroups.all) {
		for (const tab of group.tabs) {
			const input = tab.input;
			if (viewType) {
				if (input instanceof vscode.TabInputCustom && input.viewType === viewType && input.uri.toString() === key)
					return tab;
			} else if (input instanceof vscode.TabInputText && input.uri.toString() === key) {
				return tab;
			}
		}
	}
}

*/

class Explorer extends webview.Panel<MessageOut, MessageIn, MessageRpc> {

	constructor(
		public rootUri: vscode.Uri,
		public webviewPanel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		public readonly: boolean,
		private columns: Record<string, ColumnDescriptor>,
		private theme?: IconTheme,
	) {
		super(webviewPanel);

		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootUri, '**/*'));
		watcher.onDidChange(uri => this.updateEntry(uri));
		watcher.onDidCreate(uri => this.updateEntry(uri));
		watcher.onDidDelete(uri => this.updateEntry(uri));

		webviewPanel.onDidDispose(() => {
			watcher.dispose();
		});

		const webview = webviewPanel.webview;

		webview.options = {
			enableScripts: true,
			localResourceRoots: [
				extensionUri,
				...(theme ? [theme.themeFolder] : []),
			],
		};

		function webviewUri(name: string) {
			return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, name));
		}

		const nonce = Nonce();
		const cols = Object.values(columns).map(i => ColumnType[i.type]);
		const namefr = NameColumn.weight / (NameColumn.weight + cols.reduce((sum, i) => sum + i.fr, 0));

		webview.html = '<!DOCTYPE html>' + JSX.render(
			<html lang="en">
				<head>
					<meta charset="UTF-8"/>
					<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
					<CSP
						csp={[CSPdefault(extensionUri), CSP.self, CSP.unsafe_inline]}
						script={nonce}
						img={[CSPdefault(extensionUri), CSP.self, vscode.Uri.parse('data:')]}
					/>
					<ImportMap nonce={nonce} webview={webview} map={{
						"@isopodlabs/vscode_utils/webview/":	vscode.Uri.joinPath(extensionUri, 'node_modules/@isopodlabs/vscode_utils/dist/webview/'),
					}}/>
					<link rel="stylesheet" type="text/css" href={webviewUri('node_modules/@isopodlabs/vscode_utils/assets/shared.css')}/>
					<link rel="stylesheet" type="text/css" href={webviewUri('node_modules/@isopodlabs/vscode_utils/assets/tree.css')}/>
					<link rel="stylesheet" type="text/css" href={webviewUri('assets/explorer.css')}/>
					{theme ? <style type="text/css">{theme.style(webview)}</style> : undefined}
					<script type="module" nonce={nonce} src={webviewUri('out/webview/explorer.js')}></script>

				</head>
			<body style={`
				--name-fr: ${namefr};
				--stat-columns: ${cols.map(i => `minmax(0, ${i.fr}fr)`).join(' ')};`
				}>
				<div class="header">
					<span>Name</span>
					{Object.entries(this.columns).map(([key, col]) =>
						<span class={`col-${col.type} col-key-${key}`}>{col.label}</span>
					)}
				</div>

				<div class="tree" data-entry={rootUri.toString()}/>
			</body></html>);
	}

	private updateEntry(uri: vscode.Uri) {
		this.postMessage({command: 'update', selector: `[data-entry="${uri.with({path: fs.dirname(uri)}).toString() + '/'}"]`});
	}

	async command(message: MessageOut) {
		switch (message.command) {
			case 'load': {
				const entry		= message.entry ? vscode.Uri.parse(decodeURI(message.entry)) : this.rootUri;
				const children	= await vscode.workspace.fs.readDirectory(entry);
				const symlinks	= new Set(children.filter(i => i[1] & vscode.FileType.SymbolicLink).map(i => i[0]));
				const dirs		= children.filter(i => i[1] & vscode.FileType.Directory).map(i => i[0]);
				const files		= children.filter(i => i[1] & vscode.FileType.File).map(i => i[0]);
				return {
					html: JSX.render(<>{[
						... await Promise.all(dirs.map(async name => {
							const symlink = symlinks.has(name) ? (await fs.stat(vscode.Uri.joinPath(entry, name))).link : undefined;
							return <div class="caret">
								<span class="folder select" draggable="true"
									data-entry={vscode.Uri.joinPath(entry, name).toString() + '/'}
									data-link={symlink}
									{...themedIconAttributes(this.webviewPanel.webview, this.theme, this.theme?.getFolderIcon(name, true), symlink ? folderIcon : undefined)}
								>{name}</span>
								<div class="children"/>
							</div>
						})),
						...	await Promise.all(files.map(async name => {
							const stats = await fs.stat(vscode.Uri.joinPath(entry, name));
							const symlink = symlinks.has(name) ? stats.link : undefined;
							return <div class="leaf select" draggable="true"
								data-entry={vscode.Uri.joinPath(entry, name).toString()}
							>
								<span class="file"
									data-link={symlink}
									{...themedIconAttributes(this.webviewPanel.webview, this.theme, this.theme?.getFileIcon(name), fileIcon)}
								>{name}</span>
								{Object.entries(this.columns).map(([key, col]) =>
									<span class={`col-${col.type} col-key-${key}`}>{ColumnType[col.type].format(stats[key])}</span>
								)}
							</div>
						}))
					]}</>)
				};
			}
/*
			case 'drag_start':
				if (!this.selected.has(message.selector)) {
					this.selected.forEach(selector => this.addClass(selector, 'selected', false));
					this.selected.clear();
					this.addClass(message.selector, 'selected', true);
					this.selected.add(message.selector);
				}
				this.anchor = message.selector;
				break;
*/
			case 'copyFile': {
				const target = vscode.Uri.parse(message.target);
				if (typeof message.data === 'string') {
					const source = vscode.Uri.parse(message.data);
					if (message.move)
						await vscode.workspace.fs.rename(source, target, { overwrite: true });
					else
						await vscode.workspace.fs.copy(source, target, { overwrite: true });

				} else {
					await fs.writeFile(target, new Uint8Array(message.data));
					if (message.mtime)
						fs.setStat(target, { mtime: message.mtime });
				}
				break;
			}

			case 'open':
				const uri	= vscode.Uri.parse(message.entry);
				const stat	= await fs.getStat(uri);
				if (stat && (stat.type & vscode.FileType.File))
					vscode.commands.executeCommand('vscode.open', uri, {viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true});
				break;
		}
	}

	getContext(): Promise<Context | undefined> {
		return this.RPC({command: 'context'});
	}

	beginEdit(entry: string): Promise<string> {
		return this.RPC({command: 'edit', selector: entry.endsWith('/')
			? `[data-entry="${entry}"]`
			: `[data-entry="${entry}"] .file`
		});
		//return this.RPC({command: 'edit', selector: `[data-entry="${entry}"]`});
	}
}

export class ExplorerProvider implements vscode.CustomReadonlyEditorProvider {
	private theme:	Promise<IconTheme|undefined>;
	private active: Explorer | undefined;
	private extensionUri: vscode.Uri;

	private setActive(editor: Explorer) {
		this.active = editor;
		vscode.commands.executeCommand('setContext', 'zip.readonly', editor.readonly);
	}

	private getContext(ctx?: Context) {
		//if (ctx?.entry)
		//	return ctx;
		return this.active?.getContext();
	}

	constructor(context: vscode.ExtensionContext, public zipFileSystem: ZipFileSystem) {
		this.extensionUri	= context.extensionUri;
		this.theme			= loadIconTheme();
		
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('zip.view', this),

			vscode.commands.registerCommand('zip.rename', async (ctx?: Context) => {
				if (this.active?.readonly) {
					vscode.window.showWarningMessage('Archive is read-only.');
					return;
				}

				ctx = await this.getContext(ctx);
				if (!ctx)
					return;

				const active = this.active;
				if (active) {
					const newName = await active.beginEdit(ctx.entry);
					if (!newName)
						return;

					const oldUri	= vscode.Uri.parse(ctx.entry);
					const oldName	= fs.basename(oldUri);
					if (newName === oldName)
						return;

					const newUri	= oldUri.with({path: fs.dirname(oldUri) + '/' + newName});
					try {
						await vscode.workspace.fs.rename(oldUri, newUri, {overwrite: false});
						//active.contextEntry = newUri.toString();
					} catch (e: any) {
						vscode.window.showErrorMessage(e?.message || String(e));
					}
				}
			}),
			vscode.commands.registerCommand('zip.delete', async (ctx?: Context) => {
				if (this.active?.readonly) {
					vscode.window.showWarningMessage('Archive is read-only.');
					return;
				}

				ctx = await this.getContext(ctx);
				if (!ctx)
					return;

				const uri	= vscode.Uri.parse(ctx.entry);
				const name	= fs.basename(uri);
				const target = ctx.selectionCount > 1 ? `${ctx.selectionCount} selected entries` : `'${name}'`;
				const choice = await vscode.window.showWarningMessage(
					`Delete ${target}?`,
					{ modal: true },
					'Delete'
				);
				if (choice === 'Delete') {
					if (ctx.selectionCount > 1) {
						for (const selector of ctx.selection ?? []) {
							const entryUri = vscode.Uri.parse(selector);
							await vscode.workspace.fs.delete(entryUri, {recursive: true, useTrash: false});
						}
					} else {
						await vscode.workspace.fs.delete(uri, {recursive: true, useTrash: false});
					}
				}
			}),

			vscode.commands.registerCommand('zip.explore', async (uri: vscode.Uri) => {
				await vscode.commands.executeCommand('vscode.openWith',
					uri,
					'zip.view',
					{
						preview: true
					}
				);
			}),
		);
	}

	async openCustomDocument(uri: vscode.Uri, _openContext: vscode.CustomDocumentOpenContext, _token: vscode.CancellationToken): Promise<vscode.CustomDocument> {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.type & vscode.FileType.Directory)
			return new RootDocument(uri, false);
		return this.zipFileSystem.getDoc(uri);
	}

	async resolveCustomEditor(doc: RootDocument, webviewPanel: vscode.WebviewPanel, _token?: vscode.CancellationToken): Promise<void> {
		const supported = (doc.constructor as typeof RootDocument).supportedStat;	
		const editor = new Explorer(doc.rootUri, webviewPanel, this.extensionUri, doc.readonly, discoverColumns(supported), await this.theme);
		this.setActive(editor);

		webviewPanel.onDidChangeViewState(event => {
			if (event.webviewPanel.active)
				this.setActive(editor);
		});
	}
}
