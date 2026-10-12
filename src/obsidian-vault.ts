import { App, normalizePath, TFile, TFolder } from 'obsidian';
import type { FileInfo, VaultAdapter } from './vault';

/** VaultAdapter over the Obsidian Vault API. Records its own writes so file events can be ignored. */
export class ObsidianVault implements VaultAdapter {
	private readonly recentWrites = new Map<string, number>();

	constructor(
		private readonly app: App,
		private readonly pluginDir: string,
	) {}

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

	async write(path: string, text: string): Promise<FileInfo> {
		const f = this.file(path);
		this.mark(path);
		await this.app.vault.modify(f, text);
		return ObsidianVault.info(f);
	}

	async create(path: string, text: string): Promise<FileInfo> {
		const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (folder) await this.createFolder(folder);
		this.mark(path);
		const f = await this.app.vault.create(path, text);
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
