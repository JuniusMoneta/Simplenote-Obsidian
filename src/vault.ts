/**
 * Minimal vault abstraction so the sync engine can be tested without Obsidian.
 * Paths are vault-relative, `/`-separated, without a leading slash.
 */

export interface FileInfo {
	path: string;
	mtime: number;
	size: number;
}

export interface WriteTimes {
	/** Creation time in ms (only honored on create). */
	ctime?: number;
	/** Modification time in ms. */
	mtime?: number;
}

/** Obsidian's core Bookmarks list, used as the counterpart of Simplenote's pin. */
export interface BookmarkAdapter {
	available(): boolean;
	isBookmarked(path: string): boolean;
	setBookmarked(path: string, on: boolean): void;
}

export interface VaultAdapter {
	/** Optional bookmark integration; when absent or unavailable, the `pinned` property is used. */
	bookmarks?: BookmarkAdapter;
	listMarkdownFiles(): FileInfo[];
	listFolders(): string[];
	/** Case-insensitive existence check of a file or folder path. */
	exists(path: string): boolean;
	stat(path: string): FileInfo | null;
	read(path: string): Promise<string>;
	/** Frontmatter as parsed by Obsidian's metadata cache, {} when none, null when unknown. */
	readFrontmatter(path: string): Promise<Record<string, unknown> | null>;
	/** Overwrites an existing file, optionally stamping its modification time. */
	write(path: string, text: string, times?: WriteTimes): Promise<FileInfo>;
	/** Creates a new file, creating parent folders as needed, optionally stamping its times. */
	create(path: string, text: string, times?: WriteTimes): Promise<FileInfo>;
	createFolder(path: string): Promise<void>;
	/** Rename or move; parent folders are created as needed. Uses fileManager.renameFile in Obsidian. */
	rename(oldPath: string, newPath: string): Promise<void>;
	trash(path: string): Promise<void>;
	/** Edits frontmatter keys. Set a key to undefined to delete it. */
	processFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<FileInfo>;
	/** Writes a file into the plugin's own folder (backups). */
	writePluginFile(name: string, text: string): Promise<void>;
}

export function parentFolder(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? '' : path.slice(0, i);
}
