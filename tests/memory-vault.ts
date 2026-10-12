import { parseYaml } from 'obsidian';
import { joinFrontmatter, setKeys, splitFrontmatter } from '../src/frontmatter';
import type { FileInfo, VaultAdapter } from '../src/vault';

function key(p: string): string {
	return p.normalize('NFC').toLocaleLowerCase('en-US');
}

export interface VaultEvent {
	kind: 'create' | 'modify' | 'rename' | 'delete';
	path: string;
	oldPath?: string;
}

/** In-memory vault with case-insensitive paths, mtimes, folders, and an event log. */
export class MemoryVault implements VaultAdapter {
	private files = new Map<string, { path: string; text: string; mtime: number; createdByPlugin: boolean }>();
	private folders = new Set<string>();
	readonly trashed: { path: string; text: string }[] = [];
	readonly pluginFiles = new Map<string, string>();
	readonly events: VaultEvent[] = [];
	/** Paths that throw on read (simulates cloud placeholders). */
	readonly unreadable = new Set<string>();
	clock = 1_000_000;

	constructor(private readonly now: () => number = () => Date.now()) {}

	private tick(): number {
		this.clock += 1000;
		return this.clock;
	}

	// ----- test helpers -----
	/** Simulates an external (user or vault-sync) write. */
	put(path: string, text: string, mtime?: number): void {
		const k = key(path);
		const existed = this.files.has(k);
		this.files.set(k, { path, text, mtime: mtime ?? this.tick(), createdByPlugin: false });
		this.ensureFolders(path);
		this.events.push({ kind: existed ? 'modify' : 'create', path });
	}
	remove(path: string): void {
		this.files.delete(key(path));
		this.events.push({ kind: 'delete', path });
	}
	get(path: string): string | undefined {
		return this.files.get(key(path))?.text;
	}
	has(path: string): boolean {
		return this.files.has(key(path));
	}
	paths(): string[] {
		return [...this.files.values()].map((f) => f.path).sort();
	}
	private ensureFolders(path: string): void {
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
	}

	// ----- VaultAdapter -----
	listMarkdownFiles(): FileInfo[] {
		return [...this.files.values()]
			.filter((f) => f.path.endsWith('.md'))
			.map((f) => ({ path: f.path, mtime: f.mtime, size: new TextEncoder().encode(f.text).length }))
			.sort((a, b) => (a.path < b.path ? -1 : 1));
	}
	listFolders(): string[] {
		return [...this.folders].sort();
	}
	exists(path: string): boolean {
		const k = key(path);
		if (this.files.has(k)) return true;
		for (const f of this.folders) if (key(f) === k) return true;
		return false;
	}
	stat(path: string): FileInfo | null {
		const f = this.files.get(key(path));
		return f ? { path: f.path, mtime: f.mtime, size: new TextEncoder().encode(f.text).length } : null;
	}
	read(path: string): Promise<string> {
		if (this.unreadable.has(key(path))) return Promise.reject(new Error(`EIO ${path}`));
		const f = this.files.get(key(path));
		if (!f) return Promise.reject(new Error(`ENOENT ${path}`));
		return Promise.resolve(f.text);
	}
	async readFrontmatter(path: string): Promise<Record<string, unknown> | null> {
		const f = this.files.get(key(path));
		if (!f) return null;
		const fm = splitFrontmatter(f.text);
		return fm.hasBlock && !fm.invalid ? fm.data : {};
	}
	write(path: string, text: string): Promise<FileInfo> {
		const f = this.files.get(key(path));
		if (!f) return Promise.reject(new Error(`ENOENT ${path}`));
		f.text = text;
		f.mtime = this.tick();
		f.createdByPlugin = true;
		this.events.push({ kind: 'modify', path: f.path });
		return Promise.resolve(this.stat(path) as FileInfo);
	}
	create(path: string, text: string): Promise<FileInfo> {
		if (this.files.has(key(path))) return Promise.reject(new Error(`EEXIST ${path}`));
		this.files.set(key(path), { path, text, mtime: this.tick(), createdByPlugin: true });
		this.ensureFolders(path);
		this.events.push({ kind: 'create', path });
		return Promise.resolve(this.stat(path) as FileInfo);
	}
	createFolder(path: string): Promise<void> {
		this.ensureFolders(`${path}/x`);
		return Promise.resolve();
	}
	rename(oldPath: string, newPath: string): Promise<void> {
		const f = this.files.get(key(oldPath));
		if (!f) return Promise.reject(new Error(`ENOENT ${oldPath}`));
		if (key(oldPath) !== key(newPath) && this.files.has(key(newPath))) return Promise.reject(new Error(`EEXIST ${newPath}`));
		this.files.delete(key(oldPath));
		f.path = newPath;
		this.files.set(key(newPath), f);
		this.ensureFolders(newPath);
		this.events.push({ kind: 'rename', path: newPath, oldPath });
		return Promise.resolve();
	}
	trash(path: string): Promise<void> {
		const f = this.files.get(key(path));
		if (!f) return Promise.reject(new Error(`ENOENT ${path}`));
		this.trashed.push({ path: f.path, text: f.text });
		this.files.delete(key(path));
		this.events.push({ kind: 'delete', path });
		return Promise.resolve();
	}
	async processFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<FileInfo> {
		const f = this.files.get(key(path));
		if (!f) throw new Error(`ENOENT ${path}`);
		const split = splitFrontmatter(f.text);
		if (split.hasBlock && split.invalid) throw new Error(`invalid frontmatter in ${path}`);
		const data: Record<string, unknown> = { ...split.data };
		fn(data);
		// mimic Obsidian: keep key order of existing yaml, append new keys
		const values: Record<string, unknown> = {};
		for (const k of Object.keys(split.data)) values[k] = k in data ? data[k] : undefined;
		for (const k of Object.keys(data)) if (!(k in values)) values[k] = data[k];
		const yaml = setKeys(split.yaml, values);
		// validate
		parseYaml(yaml);
		f.text = joinFrontmatter(yaml, split.hasBlock ? split.body : f.text, split.eol);
		f.mtime = this.tick();
		this.events.push({ kind: 'modify', path: f.path });
		return this.stat(path) as FileInfo;
	}
	writePluginFile(name: string, text: string): Promise<void> {
		this.pluginFiles.set(name, text);
		return Promise.resolve();
	}
}
