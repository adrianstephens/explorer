import * as vscode from 'vscode';
import * as fs from '@isopodlabs/vscode_utils/fs';
import * as path from 'path';
import { zip, tar, UnixMode } from "@isopodlabs/binary_libs";
import * as bin from "@isopodlabs/binary";
import * as utils from "@isopodlabs/utilities";

type ArchiveEntry = zip.Entry | tar.Entry;

function resolveArchiveLink(entryPath: string, target: string) {
	return path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
}

function fileType(entry: ArchiveEntry) {
	return (entry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File) | (entry.isSymbolicLink ? vscode.FileType.SymbolicLink : 0);
}

export class RootDocument implements vscode.CustomDocument {
	constructor(readonly uri: vscode.Uri, public readonly: boolean, readonly rootUri: vscode.Uri = uri) {}
	dispose() {}
}

abstract class ArchiveDocument extends RootDocument {
	static supportedStat(): string[] {
		return [];
	}

	watchers	= new fs.FileSystemWatchers;

	constructor(uri: vscode.Uri, rootUri: vscode.Uri, readonly: boolean) {
		super(uri, readonly, rootUri);
	}
	dispose() {}

	abstract resolveLink(entry?: ArchiveEntry): ArchiveEntry | undefined | Promise<ArchiveEntry | undefined>;
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
	private extractQueue = Promise.resolve<any>(undefined);
	private writer		= new utils.CallCombiner(this.flush.bind(this), 1000);
	private cancellation = {cancel: false};
	private flushing: Promise<boolean> | undefined;

	constructor(uri: vscode.Uri, readonly: boolean, public doc: zip.Document, private stream?: bin.async.stream) {
		super(uri, vscode.Uri.from({scheme: 'zip', path: `${uri.path}!/`}), readonly);
	}
	dispose() {
		this.stream?.terminate();
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
		const result = this.extractQueue = this.extractQueue.then(() => entry.extract());
		this.extractQueue = result;//.then(() => {}, () => {});
		return result;
	}
	async writeEntry(entry: zip.Entry, data: Uint8Array) {
		const entry2 = await this.resolveLink(entry);
		if (!entry2)
			return false;
		entry2.set(data);
		return true;
	}

	static supportedStat() {
		return ['size', 'compressedSize', 'type', 'mtime', 'ctime', 'permissions', 'extPermissions', 'link'];
	}
	async statEntry(entry?: zip.Entry) {
		if (!entry)
			return undefined;

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
			compressedSize:	entry.compressed_size,
			permissions:	this.readonly ? vscode.FilePermission.Readonly : undefined,
			extPermissions:	entry.attributes,
			link,
		};
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

	static async load(uri: vscode.Uri) {
		const stat		= await fs.stat(uri);
		const readonly	= isReadonly(stat);
		const file		= await fs.openFile(uri, readonly ? {} : {create: true});
		const stream	= asyncStream(file, stat.size);
		const doc		= new zip.Document(stream);

		try {
			await doc.ready;
		} catch(e) {
			throw e;
		}
		return new this(uri, readonly, doc, stream);
	}
}

class TarDocument extends ArchiveDocument {
	private writer		= new utils.CallCombiner(this.flush.bind(this), 1000);
	private cancellation = {cancel: false};
	private flushing: Promise<boolean> | undefined;

	constructor(uri: vscode.Uri, readonly: boolean, public doc: tar.Document, private stream?: bin.async.stream) {
		super(uri, vscode.Uri.from({scheme: 'zip', path: `${uri.path}!/`}), readonly);
	}
	dispose() {
		if (this.stream)
			this.stream.terminate();
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
		entry = this.resolveLink();
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
	static supportedStat() {
		return ['size', 'type', 'mtime', 'uid', 'gid', 'uname', 'gname', 'link', 'permissions'];
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

		if (this.uri.path.endsWith('.tgz')) {
			this.flushing = this.doc.saveTGZ(this.cancellation).then(async data => {
				if (data) {
					await vscode.workspace.fs.writeFile(this.uri, data);
					return true;
				}
				return false;
			});
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
		}
	}

	static async load(uri: vscode.Uri) {
		const stat		= await fs.stat(uri);
		const readonly	= isReadonly(stat);
		const file		= await fs.openFile(uri, readonly ? {} : {create: true});
		const doc		= new tar.Document(asyncStream(file, stat.size));
		try {
			await doc.ready;
		} catch(e) {
			throw e;
		}
		return new this(uri, readonly, doc, readonly ? undefined : asyncStream(file, stat.size, true));
	}
	static async loadTGZ(uri: vscode.Uri) {
		const data = await fs.loadFile(uri);
		if (data)
			return new this(uri, isReadonly(await fs.stat(uri)), await tar.Document.loadTGZ(data));
		throw new Error("Unable to load TGZ file");
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

	static docs = new Map<string, Promise<ArchiveDocument>>();

	constructor(context: vscode.ExtensionContext) {
		super(context, 'zip');
	}

	private static getSplit(uri: vscode.Uri) {
		const sep = uri.path.lastIndexOf('!/');
		if (sep < 0)
			throw vscode.FileSystemError.FileNotFound(uri);
		return sep;
	}

	static getDocType(uri: vscode.Uri) {
		const ext = uri.path.slice(uri.path.lastIndexOf('.') + 1).toLowerCase();
		if (ext === 'tar' || ext === 'tgz' || ext === 'tar.gz')
			return TarDocument;
		else
			return ZipDocument;
	}
	static getDoc(uri: vscode.Uri) {
		let doc = this.docs.get(uri.path.toLowerCase());
		if (!doc) {
			const ext = uri.path.slice(uri.path.lastIndexOf('.') + 1).toLowerCase();
			if (ext === 'tar')
				doc = TarDocument.load(uri);
			else if (ext === 'tgz' || ext === 'tar.gz')
				doc = TarDocument.loadTGZ(uri);
			else
				doc = ZipDocument.load(uri);
			this.docs.set(uri.path.toLowerCase(), doc);
		}
		return doc;
	}

	private static getDocAndName(uri: vscode.Uri) {
		const sep = this.getSplit(uri);
		return { doc: this.getDoc(vscode.Uri.file(uri.path.slice(0, sep))), name: uri.path.slice(sep + 2) };
	}
	private static getDocAndEntry(uri: vscode.Uri) {
		const {doc, name} = this.getDocAndName(uri);
		return { doc, name, entry: doc.then(doc => doc.findEntry(name)) };
	}

	private changed(doc: ArchiveDocument, name: string, type: vscode.FileChangeType) {
		if (doc.watchers.check(name))
			this._onDidChangeFile.fire([{ uri: vscode.Uri.joinPath(doc.rootUri, name), type }]);
	}

	watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
		const {doc, name} = ZipFileSystem.getDocAndName(uri);
		const watcher = doc.then(doc => doc.watchers.add(name, options));
		return {
			dispose() {
				watcher.then(w => w.dispose());
			}
		};
  	}

	async stat(uri: vscode.Uri): Promise<fs.ExtStat> {
		const {doc, name}	= ZipFileSystem.getDocAndName(uri);
		const stats = await doc.then(async doc => doc.statEntry(doc.findEntry(name)));
		if (stats)
			return stats;
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const {doc, name}	= ZipFileSystem.getDocAndName(uri);
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

		const {doc, name, entry}	= ZipFileSystem.getDocAndEntry(uri);
		const [doc2, entry2]		= await Promise.all([doc, entry]);
		if (entry2)
			throw vscode.FileSystemError.FileExists(uri);
		if (doc2.readonly)
			throw vscode.FileSystemError.NoPermissions(uri);
		doc2.addEntry(name + '/', undefined, true);
		this.changed(doc2, name, vscode.FileChangeType.Created);
	}

	async readFile(uri: vscode.Uri) {
		const {doc, name} = ZipFileSystem.getDocAndName(uri);
		const data = await doc.then(async doc => doc.readEntry(doc.findEntry(name)));
		if (data)
			return data;
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): Promise<void> {
		const {doc, name, entry} = ZipFileSystem.getDocAndEntry(uri);
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
		const {doc, name, entry} = ZipFileSystem.getDocAndEntry(uri);
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
		const {doc, name: oldName, entry} = ZipFileSystem.getDocAndEntry(oldUri);
		const {name: newName} = ZipFileSystem.getDocAndName(newUri);
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
		const s	= ZipFileSystem.getDocAndEntry(source);
		const t	= ZipFileSystem.getDocAndName(target);
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
	supportedStat(uri: vscode.Uri) {
		const type = ZipFileSystem.getDocType(vscode.Uri.file(uri.path.slice(0, ZipFileSystem.getSplit(uri))));
		return type.supportedStat();
	}
	async setStat(uri: vscode.Uri, stat: Partial<vscode.FileStat>): Promise<void> {
		const {doc, entry, name} = ZipFileSystem.getDocAndEntry(uri);
		const [doc2, entry2] = await Promise.all([doc, entry]);
		if (doc2.readonly)
			throw vscode.FileSystemError.NoPermissions(uri);
		if (!entry2)
			throw vscode.FileSystemError.FileNotFound(uri);
		doc2.setStat(entry2, stat);
		this.changed(doc2, name, vscode.FileChangeType.Changed);
	}
}
