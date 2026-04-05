import * as vscode from 'vscode';
import { JSX, CSP, CSPdefault, ImportMap, Nonce } from "@isopodlabs/vscode_utils/jsx-runtime";
import { iconAttributes, IconType } from "@isopodlabs/vscode_utils/codicon";
import { IconTheme, loadIconTheme } from "@isopodlabs/vscode_utils/icon-theme";
import * as fs from '@isopodlabs/vscode_utils/fs';
import * as main from "./extension";
import * as webview from "@isopodlabs/vscode_utils/webview";
import type { MessageIn, MessageOut, MessageRpc, Context } from "../webview/explorer";
import { ZipFileSystem } from './ZipFilesystem';

type ExtendedStats = vscode.FileStat & {[key: string]: any};

class RootDocument implements vscode.CustomDocument {
	constructor(readonly uri: vscode.Uri, readonly rootUri: vscode.Uri = uri) {}
	dispose() {}
}

const folderIcon	= new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.blue'));
const fileIcon		= new vscode.ThemeIcon('file', new vscode.ThemeColor('charts.blue'));

function themedIconAttributes(webview: vscode.Webview, theme: IconTheme | undefined, iconId: string | undefined, fallback: IconType) {
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
	return iconAttributes(fallback);
}

function formatSize(size: number) {
	return size.toLocaleString();
}

function formatModified(time: Date | undefined) {
	return time ? time.toLocaleString() : '';
}

class Explorer extends webview.Panel<MessageOut, MessageIn, MessageRpc> {
	selected = new Set<string>();
	anchor?: string;
	contextEntry?: string;
	watcher: vscode.FileSystemWatcher;

	constructor(
		public rootUri: vscode.Uri,
		public webviewPanel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		private theme?: IconTheme,
	) {
		super(webviewPanel);

		this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootUri, '**/*'));
		this.watcher.onDidChange(uri => {
			this.updateEntry(uri);
		});
		this.watcher.onDidCreate(uri => {
			this.updateEntry(uri);
		});
		this.watcher.onDidDelete(uri => {
			this.updateEntry(uri);
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

		webview.html = '<!DOCTYPE html>' + JSX.render(
			<html lang="en">
				<head>
					<meta charset="UTF-8"/>
					<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
					<CSP csp={[CSPdefault(extensionUri), CSP.self, CSP.unsafe_inline]} script={nonce}/>
					<ImportMap nonce={nonce} webview={webview} map={{
						"@isopodlabs/vscode_utils/webview/":	vscode.Uri.joinPath(extensionUri, 'node_modules/@isopodlabs/vscode_utils/dist/webview/'),
					}}/>
					<link rel="stylesheet" type="text/css" href={webviewUri('node_modules/@isopodlabs/vscode_utils/assets/shared.css')}/>
					<link rel="stylesheet" type="text/css" href={webviewUri('node_modules/@isopodlabs/vscode_utils/assets/tree.css')}/>
					<link rel="stylesheet" type="text/css" href={webviewUri('assets/explorer.css')}/>
					{theme ? <style type="text/css">{theme.style(webview)}</style> : undefined}
					<script type="module" nonce={nonce} src={webviewUri('out/webview/explorer.js')}></script>

				</head>
			<body>
				<template id="directory-template">
					<div class="caret">
						<span class="zip-folder select" draggable="true" data-entry="$(entry)" data-attrs="icon">$(name)</span>
						<div class="children"/>
					</div>
				</template>
				<template id="entry-template">
					<div class="zip-leaf select" data-entry="$(entry)" draggable="true">
						<span class="zip-col-name" data-attrs="icon">$(name)</span>
						<span class="zip-col-size">$(uncompressed)</span>
						<span class="zip-col-size">$(compressed)</span>
						<span class="zip-col-time">$(modified)</span>
					</div>
				</template>
				<div class="zip-header">
					<span>Name</span>
					<span class="zip-col-size">Uncompressed</span>
					<span class="zip-col-size">Compressed</span>
					<span class="zip-col-time">Modified</span>
				</div>

				<div class="tree" data-entry={rootUri.toString()}/>
			</body></html>);
	}

	private updateEntry(uri: vscode.Uri) {
		this.postMessage({command: 'update', selector: `[data-entry="${uri.with({path: fs.dirname(uri)}).toString() + '/'}"]`});
	}

	private addClass(selector: string, clss: string, enable:boolean) {
		this.postMessage({command: 'add_class', selector, class: clss, enable});
	}
	async command(message: MessageOut) {
		switch (message.command) {
			case 'load': {
				console.log(`Load requested: ${message.entry}`);
				const entry		= message.entry ? vscode.Uri.parse(decodeURI(message.entry)) : this.rootUri;
				const children	= await vscode.workspace.fs.readDirectory(entry);
				const dirs		= children.filter(i => i[1] === vscode.FileType.Directory);
				const files		= children.filter(i => i[1] === vscode.FileType.File);

				const result = {
					dirs: dirs.map(i =>  {
						const name = i[0];
						return {
							name,
							entry: vscode.Uri.joinPath(entry, name).toString() + '/',
							icon: themedIconAttributes(this.webviewPanel.webview, this.theme, this.theme?.getFolderIcon(name, true), folderIcon),
						};
					}),
					files: await Promise.all(files.map(async i => {
						const name = i[0];
						const stats = (await vscode.workspace.fs.stat(vscode.Uri.joinPath(entry, name)))! as ExtendedStats;
						return {
							name,
							compressed: formatSize(stats.compressedSize ?? stats.size),
							uncompressed: formatSize(stats.size),
							modified: formatModified(new Date(stats.mtime)),
							entry: vscode.Uri.joinPath(entry, name).toString(),
							icon: themedIconAttributes(this.webviewPanel.webview, this.theme, this.theme?.getFileIcon(name), fileIcon),
						};
					})),
				};
				return result;
			}

			case 'drag_start':
				if (!this.selected.has(message.selector)) {
					this.selected.forEach(selector => this.addClass(selector, 'selected', false));
					this.selected.clear();
					this.addClass(message.selector, 'selected', true);
					this.selected.add(message.selector);
				}
				this.anchor = message.selector;
				break;

			case 'copyFile': {
				const target = vscode.Uri.parse(message.target);
				console.log(`copyFile requested: ${message.data} -> ${target}`);
				if (typeof message.data === 'string') {
					const source = vscode.Uri.parse(message.data);
					if (message.move)
						await vscode.workspace.fs.rename(source, target, { overwrite: true });
					else
						await vscode.workspace.fs.copy(source, target, { overwrite: true });

				} else {
					await fs.writeFile(target, new Uint8Array(message.data));
					if (message.mtime)
						fs.setStats(target, { mtime: message.mtime });
				}
				break;
			}

			case 'select':
				if (message.shiftKey) {
					this.selected.forEach(selector => this.addClass(selector, 'selected', false));
					this.selected.clear();
					if (this.anchor) {
						const selectors = await this.RPC({command: 'get_select_range', from: this.anchor, to: message.selector});
						selectors.forEach((selector: string) => this.addClass(selector, 'selected', true));
						this.selected = new Set(selectors);
					}
				} else if (message.ctrlKey) {
					if (this.selected.has(message.selector)) {
						this.addClass(message.selector, 'selected', false);
						this.selected.delete(message.selector);
					} else {
						this.addClass(message.selector, 'selected', true);
						this.selected.add(message.selector);
					}
				} else {
					this.selected.forEach(selector => this.addClass(selector, 'selected', false));
					this.selected.clear();
					this.addClass(message.selector, 'selected', true);
					this.selected.add(message.selector);
					const uri	= vscode.Uri.parse(message.entry);
					const stat	= await fs.getStat(uri);
					if (stat && stat.type === vscode.FileType.File)
						vscode.commands.executeCommand('vscode.open', uri, {viewColumn: vscode.ViewColumn.Beside, preview: true});
				}
				this.anchor = message.selector;
				this.contextEntry = message.entry;
				break;
		}
	}

	getContext(): Context | undefined {
		if (!this.contextEntry)
			return;
		return {
			entry: this.contextEntry,
			isSelected: true,
			selectionCount: Math.max(this.selected.size, 1),
		};
	}

	beginEdit(entry: string): Promise<string> {
		return this.RPC({command: 'edit', selector: entry.endsWith('/')
			? `[data-entry="${entry}"]`
			: `[data-entry="${entry}"] .zip-col-name`
		});
	}
}

export class ExplorerProvider implements vscode.CustomReadonlyEditorProvider {
	private theme:	Promise<IconTheme|undefined>;
	private editors = new Set<Explorer>();
	private extensionUri: vscode.Uri;

	private getActiveEditor() {
		for (const editor of this.editors) {
			if (editor.webviewPanel.active)
				return editor;
		}
	}

	private getContext(ctx?: Context) {
		if (ctx?.entry)
			return ctx;
		return this.getActiveEditor()?.getContext();
	}

	constructor(context: vscode.ExtensionContext) {
		this.extensionUri	= context.extensionUri;
		this.theme			= loadIconTheme();
		
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider('zip.view', this),

			vscode.commands.registerCommand('zip.rename', async (ctx?: Context) => {
				ctx = this.getContext(ctx);
				if (!ctx)
					return;

				const active = this.getActiveEditor();
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
						active.contextEntry = newUri.toString();
					} catch (e: any) {
						vscode.window.showErrorMessage(e?.message || String(e));
					}
				}
			}),
			vscode.commands.registerCommand('zip.delete', async (ctx?: Context) => {
				ctx = this.getContext(ctx);
				if (!ctx)
					return;

				const uri	= vscode.Uri.parse(ctx.entry);
				const name	= fs.basename(uri);
				const target = ctx.selectionCount > 1 ? `${ctx.selectionCount} selected entries` : `'${name}'`;
				const choice = await vscode.window.showWarningMessage(
					`Delete ${target}?`,
					{modal: true},
					'Delete'
				);
				if (choice === 'Delete') {
					if (ctx.selectionCount > 1) {
						for (const selector of this.getActiveEditor()?.selected ?? []) {
							const entryUri = vscode.Uri.parse(selector);
							await vscode.workspace.fs.delete(entryUri, {recursive: true, useTrash: false});
						}
					} else {
						await vscode.workspace.fs.delete(uri, {recursive: true, useTrash: false});
					}
				}
			}),

			vscode.commands.registerCommand('zip.explore', async (uri: vscode.Uri) => {
				await vscode.commands.executeCommand('vscode.openWith', uri, 'zip.view', { preview: true });
			}),

		);
	}

	async openCustomDocument(uri: vscode.Uri, _openContext: vscode.CustomDocumentOpenContext, _token: vscode.CancellationToken): Promise<vscode.CustomDocument> {
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.type & vscode.FileType.Directory)
			return new RootDocument(uri);
		return ZipFileSystem.getDoc(uri);
	}

	async resolveCustomEditor(doc: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, _token?: vscode.CancellationToken): Promise<void> {
		const rootUri = (doc as RootDocument).rootUri;
		const editor = new Explorer(rootUri, webviewPanel, this.extensionUri, await this.theme);
		this.editors.add(editor);
		webviewPanel.onDidDispose(() => this.editors.delete(editor));
	}
}
