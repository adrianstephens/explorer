import * as vscode from 'vscode';

import { ExplorerProvider } from './Explorer';
import { ZipFileSystem } from './ArchiveFilesystem';

export function activate(context: vscode.ExtensionContext) {
	const zipFileSystem = new ZipFileSystem(context);
	new ExplorerProvider(context, zipFileSystem);
}

export function deactivate() {
}
