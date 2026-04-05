import * as vscode from 'vscode';
import * as fs from '@isopodlabs/vscode_utils/fs';
import {zip} from "@isopodlabs/binary_libs";
import {tar} from "@isopodlabs/binary_libs";
import * as bin from "@isopodlabs/binary";
import * as utils from "@isopodlabs/utilities";

type ArchiveEntry = zip.Entry | tar.Entry;
type ArchiveEntryStats = vscode.FileStat & {[key: string]: any};

abstract class ArchiveDocument implements vscode.CustomDocument {
	watchers	= new fs.FileSystemWatchers;
	writer		= new utils.CallCombiner(this.flush.bind(this), 1000);

	constructor(readonly uri: vscode.Uri, public rootUri: vscode.Uri) {
	}
	dispose() {}

	dirty(): void {
		this.writer.trigger();
	}

	setEntry(entry: ArchiveEntry, data: Uint8Array) {
		entry.set(data);
	}

	abstract findEntry(filename: string): Promise<ArchiveEntry | undefined>;
	abstract stats(filename: string): Promise<ArchiveEntryStats | undefined>;
	abstract setStats(filename: string, stat: Partial<vscode.FileStat>): boolean;
	abstract readFile(filename: string): Promise<Uint8Array | null>;
	abstract addEntry(filename: string, data?: Uint8Array, directory?: boolean): void;
	abstract deleteEntry(filename: string): boolean;
	abstract renameEntry(oldName: string, newName: string): boolean;
	abstract addRawEntry(filename: string, data: ArchiveEntry): void;
	abstract flush(): Promise<void>;
}

function asyncStream(file: fs.File, length: number) {
	return new bin.async.stream(
		async (offset: number, chunk: Uint8Array) => {
			const read = await file.read(offset, chunk.byteLength);
			chunk.set(read);
			return read.byteLength;
		},
		undefined,
		async _s => file.dispose(),
		length
	);
}

class ZipDocument extends ArchiveDocument {
	doc:	zip.Document;
	private stream:	bin.async.stream;
	private extractQueue = Promise.resolve<any>(undefined);

	constructor(uri: vscode.Uri, length: number, file: fs.File) {
		super(uri, vscode.Uri.from({scheme: 'zip', path: `${uri.path}!/`}));
		this.stream = asyncStream(file, length);
		this.doc	= new zip.Document(this.stream);
	}
	async findEntry(name: string) {
		return this.doc.findEntry(name);
	}
	async readFile(filename: string) {
		const entry = this.doc.findEntry(filename);
		if (!entry)
			return null;
		const result = this.extractQueue = this.extractQueue.then(() => entry.extract());
		this.extractQueue = result;//.then(() => {}, () => {});
		return result;
	}
	async stats(filename: string) {
		const zipEntry = this.doc.findEntry(filename);
		if (zipEntry)
			return {
				type:	zipEntry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
				ctime:	zipEntry.ctime?.getTime() ?? 0,
				mtime:	zipEntry.mtime?.getTime() ?? 0,
				size:	zipEntry.uncompressed_size,
				compressedSize:	zipEntry.compressed_size,
			};
	}
	setStats(filename: string, stat: Partial<vscode.FileStat>) {
		const zipEntry = this.doc.findEntry(filename);
		if (!zipEntry)
			return false;
		if (stat.ctime)
			zipEntry.ctime = new Date(stat.ctime);
		if (stat.mtime)
			zipEntry.mtime = new Date(stat.mtime);
		return true;
	}
	addEntry(filename: string, data?: Uint8Array, directory = false) {
		this.doc.addEntry(filename, data, directory ? zip.METHOD.NO_COMPRESSION : zip.METHOD.DEFLATED);
	}
	deleteEntry(filename: string) {
		return this.doc.deleteEntry(filename);
	}
	renameEntry(oldName: string, newName: string) {
		return this.doc.renameEntry(oldName, newName);
	}
	addRawEntry(filename: string, data: ArchiveEntry) {
		this.doc.addRawEntry(filename, data as zip.Entry);
	}
	async flush() {
		return;
		//this.stream.terminate();
		const stream = new bin.growingStream();
		await this.doc.writeAll(stream);
		const buffer = stream.terminate();
		await vscode.workspace.fs.writeFile(this.uri, buffer);
/*
		const tmp = this.uri.with({ path: this.uri.path + '.tmp' });
		const file = await fs.openFile(tmp, {truncate: true});
		const stream = new bin.async.stream(
			async (offset: number, chunk: Uint8Array) => {
				return chunk.byteLength;
			},
			async (offset: number, chunk: Uint8Array) => {
				await file.write(offset, chunk);
			},
			async _s => file.dispose(),
		);
		await this.zip.writeAll(stream);
		await stream.terminate();
		await vscode.workspace.fs.copy(tmp, this.uri, { overwrite: true });
		await vscode.workspace.fs.delete(tmp);
		*/
	}

	dispose() {
		this.stream.terminate();
	}

	static async load(uri: vscode.Uri) {
		const [stat, file] = await Promise.all([
			vscode.workspace.fs.stat(uri),
			fs.openFile(uri),
		]);
		const doc = new this(uri, stat.size, file);
		try {
			await doc.doc.ready;
		} catch(e) {
			doc.dispose();
			throw e;
		}
		return doc;
	}
}

class TarDocument extends ArchiveDocument {
	constructor(uri: vscode.Uri, public doc: tar.Document) {
		super(uri, vscode.Uri.from({scheme: 'zip', path: `${uri.path}!/`}));
	}
	async findEntry(name: string) {
		return this.doc.findEntry(name);
	}
	async readFile(filename: string) {
		const entry = this.doc.findEntry(filename);
		if (!entry)
			return null;
		return entry.extract();
	}
	async stats(filename: string) {
		const tarEntry = this.doc.findEntry(filename);
		if (tarEntry)
			return {
				type:	tarEntry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
				ctime:	0,
				mtime:	tarEntry.mtime?.getTime() ?? 0,
				size:	tarEntry.size,
			};
	}
	setStats(filename: string, stat: Partial<vscode.FileStat>) {
		const tarEntry = this.doc.findEntry(filename);
		if (!tarEntry)
			return false;
		if (stat.mtime)
			tarEntry.mtime = new Date(stat.mtime);
		return true;
	}

	addEntry(name: string, data?: Uint8Array, directory = false) {
		this.doc.addEntry(directory && !name.endsWith('/') ? `${name}/` : name, data);
	}
	deleteEntry(name: string) {
		return this.doc.deleteEntry(name);
	}
	renameEntry(oldName: string, newName: string) {
		return this.doc.renameEntry(oldName, newName);
	}
	addRawEntry(name: string, data: ArchiveEntry) {
		this.doc.addRawEntry(name, data as tar.Entry);
	}
	async flush() {
		return;
	}
	static async load(uri: vscode.Uri) {
		const [stat, file] = await Promise.all([
			vscode.workspace.fs.stat(uri),
			fs.openFile(uri),
		]);
		return new TarDocument(uri, new tar.Document(asyncStream(file, stat.size)));
	}
	static async loadTGZ(uri: vscode.Uri) {
		const data = await fs.loadFile(uri);
		if (data)
			return new TarDocument(uri, await tar.loadTGZ(data));
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
		const sep = uri.path.lastIndexOf('!/');
		if (sep < 0)
			throw vscode.FileSystemError.FileNotFound(uri);
		return { doc: this.getDoc(vscode.Uri.file(uri.path.slice(0, sep))), name: uri.path.slice(sep + 2) };
	}
	private static getDocAndEntry(uri: vscode.Uri) {
		const {doc, name} = this.getDocAndName(uri);
		return { doc, name, entry: doc.then(doc => doc.findEntry(name)) };
	}

	private changed(doc: ArchiveDocument, name: string, type: vscode.FileChangeType) {
		doc.dirty();
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

	async stat(uri: vscode.Uri): Promise<ArchiveEntryStats> {
		const {doc, name}	= ZipFileSystem.getDocAndName(uri);
		const stats = await doc.then(doc => doc.stats(name));
		if (stats)
			return stats;
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
		const {entry}		= ZipFileSystem.getDocAndEntry(uri);
		const entry2		= await entry;
		if (entry2) {
			const children = entry2.children as Map<string, ArchiveEntry>;
			if (children)
				return Array.from(children.entries()).map(([name, child]) => [name, child.isDirectory ? vscode.FileType.Directory : vscode.FileType.File] as [string, vscode.FileType]);
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
		doc2.addEntry(name + '/', undefined, true);
		this.changed(doc2, name, vscode.FileChangeType.Created);
	}

	async readFile(uri: vscode.Uri) {
		const {doc, name} = ZipFileSystem.getDocAndName(uri);
		const data = await doc.then(doc => doc.readFile(name));
		if (data)
			return data;
		throw vscode.FileSystemError.FileNotFound(uri);
	}

	async writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }): Promise<void> {
		const {doc, name, entry} = ZipFileSystem.getDocAndEntry(uri);
		const [doc2, entry2] = await Promise.all([doc, entry]);
		if (!entry2) {
			if (!options.create)
				throw vscode.FileSystemError.FileNotFound(uri);
			doc2.addEntry(name, content, false);
		} else {
			if (!options.overwrite)
				throw vscode.FileSystemError.FileExists(uri);
			doc2.setEntry(entry2, content);
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
		doc2.deleteEntry(name);
		this.changed(doc2, name, vscode.FileChangeType.Deleted);
	}

	async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean; }): Promise<void> {
		const {doc, name: oldName, entry} = ZipFileSystem.getDocAndEntry(oldUri);
		const {name: newName} = ZipFileSystem.getDocAndName(newUri);
		const [doc2, entry2] = await Promise.all([doc, entry]);
		if (!entry2)
			throw vscode.FileSystemError.FileNotFound(oldUri);
		if (await doc2.findEntry(newName)) {
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
		if (await tdoc.findEntry(t.name)) {
			if (!options.overwrite)
				throw vscode.FileSystemError.FileExists(target);
			tdoc.deleteEntry(t.name);
			this.changed(tdoc, t.name, vscode.FileChangeType.Deleted);
		}

		const recurse = (sourceEntry: ArchiveEntry, targetName: string) => {
			tdoc.addRawEntry(targetName, sourceEntry);
			this.changed(tdoc, targetName, vscode.FileChangeType.Created);
			const children = sourceEntry.children;
			if (children) {
				for (const [name, child] of children)
					recurse(child, targetName + '/' + name);
			}
		};

		recurse(sentry, t.name);
	}

	async setStats(uri: vscode.Uri, stat: Partial<vscode.FileStat>): Promise<void> {
		const {doc, name} = ZipFileSystem.getDocAndName(uri);
		const doc2 = await doc;
		if (doc2.setStats(name, stat))
			this.changed(doc2, name, vscode.FileChangeType.Changed);
		else
			throw vscode.FileSystemError.FileNotFound(uri);
	}
}
