import { App, normalizePath, TFile, TFolder } from 'obsidian';
import type { BookmarkAdapter, FileInfo, VaultAdapter, WriteTimes } from './vault';

interface BookmarkItem {
	type: string;
	path?: string;
	items?: BookmarkItem[];
	ctime?: number;
	title?: string;
}

interface BookmarksInstance {
	items?: BookmarkItem[];
	getBookmarks?(): BookmarkItem[];
	addItem?(item: BookmarkItem): void;
	removeItem?(item: BookmarkItem): void;
	saveData?(): void;
}

/** Core Bookmarks plugin via Obsidian's internal plugin registry (not in the public typings, but stable since 1.2). */
export class ObsidianBookmarks implements BookmarkAdapter {
	constructor(private readonly app: App) {}

	private instance(): BookmarksInstance | null {
		const internal = (this.app as unknown as { internalPlugins?: { getPluginById?(id: string): { enabled?: boolean; instance?: BookmarksInstance } | null } }).internalPlugins;
		const p = internal?.getPluginById?.('bookmarks');
		if (!p || p.enabled === false || !p.instance) return null;
		return p.instance;
	}

	available(): boolean {
		return this.instance() !== null;
	}

	private find(items: BookmarkItem[] | undefined, path: string): BookmarkItem | null {
		for (const it of items ?? []) {
			if (it.type === 'file' && it.path === path) return it;
			if (it.type === 'group') {
				const hit = this.find(it.items, path);
				if (hit) return hit;
			}
		}
		return null;
	}

	isBookmarked(path: string): boolean {
		const inst = this.instance();
		if (!inst) return false;
		const items = inst.getBookmarks ? inst.getBookmarks() : inst.items;
		return this.find(items, path) !== null;
	}

	setBookmarked(path: string, on: boolean): void {
		const inst = this.instance();
		if (!inst) return;
		const items = inst.getBookmarks ? inst.getBookmarks() : inst.items;
		const existing = this.find(items, path);
		if (on && !existing) inst.addItem?.({ type: 'file', path, ctime: Date.now() });
		else if (!on && existing) inst.removeItem?.(existing);
		else return;
		inst.saveData?.();
	}
}

/** VaultAdapter over the Obsidian Vault API. Records its own writes so file events can be ignored. */
export class ObsidianVault implements VaultAdapter {
	private readonly recentWrites = new Map<string, number>();
	readonly bookmarks: BookmarkAdapter;

	constructor(
		private readonly app: App,
		private readonly pluginDir: string,
	) {
		this.bookmarks = new ObsidianBookmarks(app);
	}

	/** True when the plugin wrote, renamed, or trashed this path within the last few seconds. */
	wasWrittenByPlugin(path: string, withinMs = 5000): boolean {
		const t = this.recentWrites.get(path);
		if (t === undefined) return false;
		if (Date.now() - t > withinMs) {
			this.recentWrites.delete(path);
			return false;
		}
		return true;
	}

	private mark(path: string): void {
		this.recentWrites.set(path, Date.now());
		if (this.recentWrites.size > 2000) {
			const cutoff = Date.now() - 10_000;
			for (const [p, t] of this.recentWrites) if (t < cutoff) this.recentWrites.delete(p);
		}
	}

	private file(path: string): TFile {
		const f = this.app.vault.getFileByPath(path);
		if (!f) throw new Error(`file not found: ${path}`);
		return f;
	}

	private static info(f: TFile): FileInfo {
		return { path: f.path, mtime: f.stat.mtime, size: f.stat.size };
	}

	listMarkdownFiles(): FileInfo[] {
		return this.app.vault.getMarkdownFiles().map((f) => ObsidianVault.info(f));
	}

	listFolders(): string[] {
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot())
			.map((f) => f.path);
	}

	exists(path: string): boolean {
		if (this.app.vault.getAbstractFileByPath(path)) return true;
		const k = path.normalize('NFC').toLocaleLowerCase('en-US');
		return this.app.vault.getAllLoadedFiles().some((f) => f.path.normalize('NFC').toLocaleLowerCase('en-US') === k);
	}

	stat(path: string): FileInfo | null {
		const f = this.app.vault.getFileByPath(path);
		return f ? ObsidianVault.info(f) : null;
	}

	read(path: string): Promise<string> {
		return this.app.vault.read(this.file(path));
	}

	readFrontmatter(path: string): Promise<Record<string, unknown> | null> {
		const f = this.app.vault.getFileByPath(path);
		if (!f) return Promise.resolve(null);
		const cache = this.app.metadataCache.getFileCache(f);
		if (!cache) return Promise.resolve(null);
		return Promise.resolve({ ...(cache.frontmatter ?? {}) });
	}

	async write(path: string, text: string, times?: WriteTimes): Promise<FileInfo> {
		const f = this.file(path);
		this.mark(path);
		await this.app.vault.modify(f, text, times?.mtime ? { mtime: times.mtime } : undefined);
		return ObsidianVault.info(f);
	}

	async create(path: string, text: string, times?: WriteTimes): Promise<FileInfo> {
		const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (folder) await this.createFolder(folder);
		this.mark(path);
		const opts = times && (times.ctime || times.mtime) ? { ctime: times.ctime, mtime: times.mtime } : undefined;
		const f = await this.app.vault.create(path, text, opts);
		return ObsidianVault.info(f);
	}

	async createFolder(path: string): Promise<void> {
		const parts = path.split('/').filter((p) => p.length > 0);
		let cur = '';
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!this.exists(cur)) {
				this.mark(cur);
				await this.app.vault.createFolder(normalizePath(cur));
			}
		}
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const f = this.file(oldPath);
		const folder = newPath.includes('/') ? newPath.slice(0, newPath.lastIndexOf('/')) : '';
		if (folder) await this.createFolder(folder);
		this.mark(oldPath);
		this.mark(newPath);
		await this.app.fileManager.renameFile(f, normalizePath(newPath));
	}

	async trash(path: string): Promise<void> {
		const f = this.file(path);
		this.mark(path);
		await this.app.fileManager.trashFile(f);
	}

	async processFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<FileInfo> {
		const f = this.file(path);
		this.mark(path);
		await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => {
			fn(fm);
			for (const k of Object.keys(fm)) if (fm[k] === undefined) delete fm[k];
		});
		return ObsidianVault.info(f);
	}

	async writePluginFile(name: string, text: string): Promise<void> {
		const dir = normalizePath(this.pluginDir);
		if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
		await this.app.vault.adapter.write(normalizePath(`${dir}/${name}`), text);
	}
}
