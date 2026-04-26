import * as vscode from 'vscode';
import * as fs from '@isopodlabs/vscode_utils/fs';
import { zip, tar, UnixMode } from "@isopodlabs/binary_libs";
import * as bin from "@isopodlabs/binary";
import * as utils from "@isopodlabs/utilities";

type ArchiveEntry = zip.Entry | tar.Entry;

function fileType(entry: ArchiveEntry) {
	return (entry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File) | (entry.isSymbolicLink ? vscode.FileType.SymbolicLink : 0);
}

export class RootDocument implements vscode.CustomDocument {
	static supportedStat = ['size', 'type', 'mtime', 'permissions'];
	constructor(readonly uri: vscode.Uri, public readonly: boolean, readonly rootUri: vscode.Uri = uri) {}
	dispose() {}
}

abstract class ArchiveDocument extends RootDocument {
	readonly watchers = new fs.FileSystemWatchers();
	private sourceWatcher: vscode.FileSystemWatcher;
	private refreshTimer?: ReturnType<typeof setTimeout>;
	ready: Promise<void>;

	constructor(uri: vscode.Uri, rootUri: vscode.Uri, public onDidChange?: (type: vscode.FileChangeType) => void) {
		super(uri, false, rootUri);
		const dir = vscode.Uri.file(fs.dirname(this.uri));
		const pattern = new vscode.RelativePattern(dir, fs.basename(this.uri));
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		watcher.onDidChange(() => this.sourceChanged(vscode.FileChangeType.Changed));
		watcher.onDidCreate(() => this.sourceChanged(vscode.FileChangeType.Created));
		watcher.onDidDelete(() => this.sourceChanged(vscode.FileChangeType.Deleted));
		this.sourceWatcher = watcher;
		this.ready = Promise.resolve().then(() => this.reload());
	}

	dispose() {
		if (this.refreshTimer)
			clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		this.sourceWatcher.dispose();
	}

	watch(name: string, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }) {
		return this.watchers.add(name, options);
	}

	private sourceChanged(type: vscode.FileChangeType) {
		if (this.refreshTimer)
			clearTimeout(this.refreshTimer);

		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			if (type !== vscode.FileChangeType.Deleted)
				this.ready = this.ready.then(() => this.reload());
			this.onDidChange?.(type);
		}, 150);
	}

	abstract reload(): Promise<void>;
	abstract findEntry(filename: string): ArchiveEntry | undefined;
	abstract statEntry(entry?: ArchiveEntry): Promise<fs.ExtStat | undefined>;
	abstract setStat(entry: ArchiveEntry, stat: Partial<fs.ExtStat>): void;
	abstract readEntry(entry?: ArchiveEntry): Promise<Uint8Array | null>;
	abstract writeEntry(entry: ArchiveEntry, data: Uint8Array): Promise<boolean>;
	abstract addEntry(filename: string, data?: Uint8Array, directory?: boolean): void;
	abstract deleteEntry(filename: string): boolean;
	abstract renameEntry(oldName: string, newName: string): boolean;
	abstract copyEntry(filename: string, data: ArchiveEntry): void;
}

function asyncStream(file: fs.File, length: number, write = false) {
	return new bin.async.stream(
		async (offset: number, chunk: Uint8Array) => {
			const read = await file.read(offset, chunk.byteLength);
			chunk.set(read);
			return read.byteLength;
		},
		write ? async (offset: number, chunk: Uint8Array) => {
			await file.write(offset, chunk);
		} : undefined,
		async _s => file.dispose(),
		length
	);
}

function isReadonly(stat: vscode.FileStat) {
	return !!(stat.permissions && stat.permissions & vscode.FilePermission.Readonly);
}

class ZipDocument extends ArchiveDocument {
	static supportedStat	= ['size', 'compressedSize', 'type', 'mtime', 'permissions', 'extPermissions', 'link'];
	private extractQueue	= Promise.resolve<any>(undefined);
	private writer			= new utils.CallCombiner(this.flush.bind(this), 1000);
	private cancellation	= {cancel: false};
	private flushing:		Promise<boolean> | undefined;
	private stream?:		bin.async.stream;
	public doc				= new zip.Document;

	async reload() {
		if (this.flushing) {
			this.cancellation.cancel = true;
			await this.flushing;
		}
		await this.extractQueue.catch(() => undefined);

		const stat		= await fs.stat(this.uri);
		const readonly	= isReadonly(stat);
		let nextStream: bin.async.stream | undefined;

		try {
			const nextDoc = !readonly && stat.size === 0
				? new zip.Document()
				: new zip.Document(nextStream = asyncStream(
					await fs.openFile(this.uri, readonly ? {shared: true} : {shared: true, create: true}),
					stat.size
				));

			await nextDoc.ready;
			this.stream?.terminate();
			this.readonly	= readonly;
			this.doc		= nextDoc;
			this.stream		= nextStream;
		} catch (e) {
			nextStream?.terminate();
			throw e;
		}
	}
	dispose() {
		super.dispose();
		this.stream?.terminate();
		this.stream = undefined;
	}

	dirty() {
		this.writer.trigger();
	}
	findEntry(name: string) {
		return this.doc.findEntry(name);
	}
	async resolveLink(entry?: zip.Entry) {
		return entry?.isSymbolicLink
			? this.findEntry(this.doc.relative(entry, bin.utils.decodeText(await entry.extract())))
			: entry;
	}
	async readEntry(entry?: zip.Entry) {
		entry = await this.resolveLink(entry);
		if (!entry)
			return null;
		return this.extractQueue = this.extractQueue.catch(() => undefined).then(() => entry.extract());
	}
	async writeEntry(entry: zip.Entry, data: Uint8Array) {
		const entry2 = await this.resolveLink(entry);
		if (!entry2)
			return false;
		entry2.set(data);
		return true;
	}

	async statEntry(entry?: zip.Entry) {
		if (!entry)
			return undefined;

		try {
			const type = fileType(entry);
			let link: string | undefined;
			if (entry.isSymbolicLink) {
				entry = await this.resolveLink(entry);
				if (!entry)
					return undefined;
				link = entry.filename;
			}

			return {
				type,
				mtime:			entry.mtime.getTime(),
				ctime:			entry.ctime?.getTime() ?? 0,
				size:			entry.uncompressed_size,
				compressedSize:	await entry.compressed_size,
				permissions:	this.readonly ? vscode.FilePermission.Readonly : undefined,
				extPermissions:	entry.attributes,
				link,
			};
		} catch (e) {
			console.error(e);
		}
	}

	setStat(entry: zip.Entry, stat: Partial<fs.ExtStat>) {
		if (stat.ctime)
			entry.ctime = new Date(stat.ctime);
		if (stat.mtime)
			entry.mtime = new Date(stat.mtime);
		this.dirty();
	}
	addEntry(filename: string, data?: Uint8Array, directory = false) {
		this.doc.addEntry(filename, data, directory ? zip.METHOD.NO_COMPRESSION : zip.METHOD.DEFLATED);
		this.dirty();
	}
	deleteEntry(filename: string) {
		const result = this.doc.deleteEntry(filename);
		if (result)
			this.dirty();
		return result;
	}
	renameEntry(oldName: string, newName: string) {
		const result = this.doc.renameEntry(oldName, newName);
		if (result)
			this.dirty();
		return !!result;
	}
	copyEntry(filename: string, data: ArchiveEntry) {
		this.doc.copyEntry(filename, data as zip.Entry);
		this.dirty();
	}
	private async flush() {
		if (this.flushing) {
			this.cancellation.cancel = true;
			await this.flushing;
		}

		//this.stream.terminate();
		try {
			const stream = new bin.growingStream();
			this.cancellation.cancel = false;
			this.flushing = this.doc.writeAll(stream, true, this.cancellation);
			if (await this.flushing) {
				const buffer = stream.terminate();
				await vscode.workspace.fs.writeFile(this.uri, buffer);
			}
		} catch(e) {
			console.error("Error writing ZIP file:", e);

		} finally {
			this.flushing = undefined;
		}
	}
}

class TarDocument extends ArchiveDocument {
	static supportedStat	= ['size', 'type', 'mtime', 'uid', 'gid', 'uname', 'gname', 'link', 'permissions'];
	private writer			= new utils.CallCombiner(this.flush.bind(this), 1000);
	private cancellation	= {cancel: false};
	private flushing:		Promise<boolean> | undefined;
	private stream?:		bin.async.stream;
	public	doc				= new tar.Document;

	async reload() {
		if (this.flushing) {
			this.cancellation.cancel = true;
			await this.flushing;
		}

		const stat		= await fs.stat(this.uri);
		const readonly	= isReadonly(stat);
		let nextStream: bin.async.stream | undefined;

		try {
			let nextDoc: tar.Document;
			if (!readonly && stat.size === 0) {
				nextDoc = new tar.Document();
			} else if (this.uri.path.endsWith('.tgz')) {
				nextDoc = await tar.Document.loadTGZ((await fs.loadFile(this.uri))!);
			} else {
				const file	= await fs.openFile(this.uri, readonly ? {shared: true} : {shared: true, create: true});
				nextDoc		= new tar.Document(asyncStream(file, stat.size));
				nextStream	= readonly ? undefined : asyncStream(file, stat.size, true);
			}

			await nextDoc.ready;
			this.stream?.terminate();
			this.readonly	= readonly;
			this.doc		= nextDoc;
			this.stream		= nextStream;
		} catch (e) {
			nextStream?.terminate();
			throw e;
		}
	}

	dispose() {
		super.dispose();
		if (this.stream)
			this.stream.terminate();
		this.stream = undefined;
	}

	dirty() {
		if (this.stream)
			this.doc.flush(this.stream);
		else
			this.writer.trigger();
	}

	findEntry(name: string) {
		return this.doc.findEntry(name);
	}
	resolveLink(entry?: tar.Entry) {
		return entry?.isSymbolicLink
			? this.doc.findEntry(this.doc.relative(entry, entry.linkpath))
			: entry;
	}
	async readEntry(entry?: tar.Entry) {
		entry = this.resolveLink(entry);
		if (!entry)
			return null;
		return entry.extract();
	}
	async writeEntry(entry: tar.Entry, data: Uint8Array) {
		const entry2 = this.resolveLink(entry);
		if (!entry2)
			return false;
		entry2.set(data);
		return true;
	}
	async statEntry(entry?: tar.Entry) {
		if (!entry)
			return undefined;

		const type = fileType(entry);
		let link: string | undefined;
		if (entry.isSymbolicLink) {
			entry = this.resolveLink(entry);
			if (!entry)
				return undefined;
			link = entry.filename;
		}

		return {
			type,
			ctime:		0,
			mtime:		entry.mtime?.getTime() ?? 0,
			size:		entry.size,
			tarType:	entry.typeflag,
			uid:		entry.uid,
			gid:		entry.gid,
			uname:		entry.uname,
			gname:		entry.gname,
			permissions: !(entry.mode & (UnixMode.W * UnixMode.USER)) || this.readonly ? vscode.FilePermission.Readonly : 0,
			link,
		};
	}
	
	setStat(entry: tar.Entry, stat: Partial<fs.ExtStat>) {
		if (stat.mtime)
			entry.mtime = new Date(stat.mtime);
		this.dirty();
	}

	addEntry(name: string, data?: Uint8Array, directory = false) {
		this.doc.addEntry(directory && !name.endsWith('/') ? `${name}/` : name, data);
		this.dirty();
	}
	deleteEntry(name: string) {
		const result = this.doc.deleteEntry(name);
		if (result)
			this.dirty();
		return result;
	}
	renameEntry(oldName: string, newName: string) {
		const result = this.doc.renameEntry(oldName, newName);
		if (result)
			this.dirty();
		return !!result;
	}
	copyEntry(name: string, data: ArchiveEntry) {
		this.doc.copyEntry(name, data as tar.Entry);
		this.dirty();
	}
	private async flush() {
		if (this.flushing) {
			this.cancellation.cancel = true;
			await this.flushing;
		}

		try {
			if (this.uri.path.endsWith('.tgz')) {
				this.flushing = this.doc.saveTGZ(this.cancellation).then(async data => {
					if (data) {
						await vscode.workspace.fs.writeFile(this.uri, data);
						return true;
					}
					return false;
				});
				await this.flushing;
			} else {
				const stream = new bin.growingStream();
				this.flushing = this.doc.writeAll(stream, this.cancellation).then(async success => {
					if (success) {
						const buffer = stream.terminate();
						await vscode.workspace.fs.writeFile(this.uri, buffer);
						return true;
					}
					return false;
				});
				await this.flushing;
			}
		} catch(e) {
			console.error("Error writing TAR/TGZ file:", e);

		} finally {
			this.flushing = undefined;
		}
	}
}

export class ZipFileSystem extends fs.BaseFileSystem {
	static makeUri(doc: vscode.Uri, filename: string) {
		const archivePath = doc.path.endsWith('/') ? doc.path.slice(0, -1) : doc.path;
		const entryPath = filename.startsWith('/') ? filename.slice(1) : filename;
		return vscode.Uri.from({
			scheme: 'zip',
			path: `${archivePath}!/${entryPath}`,
		});
	}

	docs = new Map<string, ArchiveDocument>();

	constructor(context: vscode.ExtensionContext) {
		super(context, 'zip');
		context.subscriptions.push({
			dispose: () => {
				for (const doc of this.docs.values())
					doc.dispose();
				this.docs.clear();
			}
		});
	}

	static splitUri(uri: vscode.Uri) {
		const sep = uri.path.lastIndexOf('!/');
		if (sep < 0)
			throw vscode.FileSystemError.FileNotFound(uri);
		return {doc: vscode.Uri.file(uri.path.slice(0, sep)), name: uri.path.slice(sep + 2) };
	}

	invalidate(uri: vscode.Uri) {
		const key = uri.path.toLowerCase();
		const doc = this.docs.get(key);
		if (doc) {
			this.docs.delete(key);
			doc.dispose();
		}
	}

	private getCachedDoc(uri: vscode.Uri) {
		const key = uri.path.toLowerCase();
		let doc = this.docs.get(key);
		if (!doc) {
			const ext = uri.path.slice(uri.path.lastIndexOf('.') + 1).toLowerCase();
			const rooturi = vscode.Uri.from({scheme: 'zip', path: `${uri.path}!/`});
			const onDidChange = (type: vscode.FileChangeType) => {
				if (type === vscode.FileChangeType.Deleted)
					this.invalidate(uri);
				else
					this._onDidChangeFile.fire([{ uri: vscode.Uri.joinPath(rooturi, '.__archive_refresh__'), type }]);
			};

			doc = ext === 'tar' || ext === 'tgz' || ext === 'tar.gz'
				? new TarDocument(uri, rooturi, onDidChange)
				: new ZipDocument(uri, rooturi, onDidChange);

			this.docs.set(key, doc);
		}
		return doc;
	}
	getDoc(uri: vscode.Uri) {
		const doc = this.getCachedDoc(uri);
		return doc.ready.then(() => doc, error => {
			const key = uri.path.toLowerCase();
			if (this.docs.get(key) === doc)
				this.docs.delete(key);
			doc.dispose();
			throw error;
		});
	}

	private getDocAndName(uri: vscode.Uri) {
		const {doc, name} = ZipFileSystem.splitUri(uri);
		return { doc: this.getDoc(doc), name };
	}
	private getDocAndEntry(uri: vscode.Uri) {
		const {doc, name} = this.getDocAndName(uri);
		return { doc, name, entry: doc.then(doc => doc.findEntry(name)) };
	}

	private changed(doc: ArchiveDocument, name: string, type: vscode.FileChangeType) {
		if (doc.watchers.check(name))
			this._onDidChangeFile.fire([{ uri: vscode.Uri.joinPath(doc.rootUri, name), type }]);
	}

	watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
		const {doc, name} = ZipFileSystem.splitUri(uri);
		return this.getCachedDoc(doc).watch(name, options);
  	}

	async stat(uri: vscode.Uri): Promise<fs.ExtStat> {
		const {doc, name}	= this.getDocAndName(uri);
		const stats = await doc.then(async doc => doc.statEntry(doc.findEntry(name)));
		if (stats)
			return stats;
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const {doc, name}	= this.getDocAndName(uri);
		const entry			= await doc.then(doc => doc.findEntry(name));
		if (entry) {
			const children = entry.children as Map<string, ArchiveEntry>;
			if (children)
				return Array.from(children.entries()).map(([name, child]) => {
					return [name, fileType(child)] as [string, vscode.FileType];
				});
		}
		return [];
	}

	async createDirectory(uri: vscode.Uri): Promise<void> {
		if (!uri.path.includes('!/'))
			return;

		const {doc, name, entry}	= this.getDocAndEntry(uri);
		const [doc2, entry2]		= await Promise.all([doc, entry]);
		if (entry2)
			throw vscode.FileSystemError.FileExists(uri);
		if (doc2.readonly)
			throw vscode.FileSystemError.NoPermissions(uri);
		doc2.addEntry(name + '/', undefined, true);
		this.changed(doc2, name, vscode.FileChangeType.Created);
	}

	async readFile(uri: vscode.Uri) {
		const {doc, name} = this.getDocAndName(uri);
		const data = await doc.then(async doc => doc.readEntry(doc.findEntry(name)));
		if (data)
			return data;
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): Promise<void> {
		const {doc, name, entry} = this.getDocAndEntry(uri);
		const [doc2, entry2] = await Promise.all([doc, entry]);
		if (doc2.readonly)
			throw vscode.FileSystemError.NoPermissions(uri);

		if (!entry2) {
			if (!options.create)
				throw vscode.FileSystemError.FileNotFound(uri);
			doc2.addEntry(name, content, false);
		} else {
			if (!options.overwrite)
				throw vscode.FileSystemError.FileExists(uri);
			doc2.writeEntry(entry2, content);
		}
		this.changed(doc2, name, vscode.FileChangeType.Changed);
	}

	async delete(uri: vscode.Uri, options: { readonly recursive: boolean; }): Promise<void> {
		const {doc, name, entry} = this.getDocAndEntry(uri);
		const [doc2, entry2] = await Promise.all([doc, entry]);
		if (!entry2)
			throw vscode.FileSystemError.FileNotFound(uri);
		if (entry2.isDirectory && !options.recursive && entry2.children!.size > 0)
			throw vscode.FileSystemError.FileIsADirectory(uri);
		if (doc2.readonly)
			throw vscode.FileSystemError.NoPermissions(uri);
		doc2.deleteEntry(name);
		this.changed(doc2, name, vscode.FileChangeType.Deleted);
	}

	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean; }): Promise<void> {
		const {doc, name: oldName, entry} = this.getDocAndEntry(oldUri);
		const {name: newName} = this.getDocAndName(newUri);
		const [doc2, entry2] = await Promise.all([doc, entry]);
		if (!entry2)
			throw vscode.FileSystemError.FileNotFound(oldUri);
		if (doc2.readonly)
			throw vscode.FileSystemError.NoPermissions(oldUri);
		if (doc2.findEntry(newName)) {
			if (!options.overwrite)
				throw vscode.FileSystemError.FileExists(newUri);
			doc2.deleteEntry(newName);
			this.changed(doc2, newName, vscode.FileChangeType.Deleted);
		}
		doc2.renameEntry(oldName, newName);
		this.changed(doc2, oldName, vscode.FileChangeType.Deleted);
		this.changed(doc2, newName, vscode.FileChangeType.Created);
	}

	async copy(source: vscode.Uri, target: vscode.Uri, options: { readonly overwrite: boolean; }): Promise<void> {
		const s	= this.getDocAndEntry(source);
		const t	= this.getDocAndName(target);
		const sentry	= await s.entry;
		const tdoc 		= await t.doc;

		if (!sentry)
			throw vscode.FileSystemError.FileNotFound(source);
		if (tdoc.readonly)
			throw vscode.FileSystemError.NoPermissions(target);
		if (tdoc.findEntry(t.name)) {
			if (!options.overwrite)
				throw vscode.FileSystemError.FileExists(target);
			tdoc.deleteEntry(t.name);
			this.changed(tdoc, t.name, vscode.FileChangeType.Deleted);
		}

		const recurse = (sourceEntry: ArchiveEntry, targetName: string) => {
			tdoc.copyEntry(targetName, sourceEntry);
			this.changed(tdoc, targetName, vscode.FileChangeType.Created);
			const children = sourceEntry.children;
			if (children) {
				for (const [name, child] of children)
					recurse(child, targetName + '/' + name);
			}
		};

		recurse(sentry, t.name);
	}
	async setStat(uri: vscode.Uri, stat: Partial<vscode.FileStat>): Promise<void> {
		const {doc, entry, name} = this.getDocAndEntry(uri);
		const [doc2, entry2] = await Promise.all([doc, entry]);
		if (doc2.readonly)
			throw vscode.FileSystemError.NoPermissions(uri);
		if (!entry2)
			throw vscode.FileSystemError.FileNotFound(uri);
		doc2.setStat(entry2, stat);
		this.changed(doc2, name, vscode.FileChangeType.Changed);
	}
}
