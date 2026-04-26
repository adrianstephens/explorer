import * as vscode from 'vscode';

import { ExplorerProvider } from './Explorer';
import { BitmapViewerProvider } from './BitmapViewer';
import { ZipFileSystem } from './ArchiveFilesystem';

export function activate(context: vscode.ExtensionContext) {
	const zipFileSystem = new ZipFileSystem(context);
	new ExplorerProvider(context, zipFileSystem);
	new BitmapViewerProvider(context);
}

export function deactivate() {
}
