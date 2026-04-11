import * as vscode from 'vscode';

import { ExplorerProvider } from './Explorer';
import { ZipFileSystem } from './ArchiveFilesystem';

export function activate(context: vscode.ExtensionContext) {
	new ExplorerProvider(context);
	new ZipFileSystem(context);
}

export function deactivate() {
}
