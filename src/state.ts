/** Device-local sync state (stored with app.saveLocalStorage, never in data.json). */

export interface NoteState {
	id: string;
	path: string;
	version: number;
	/** Hash of the note as last synced (content, tags, pinned). */
	contentHash: string;
	tags: string[];
	systemTags: string[];
	mtime: number;
	size: number;
	/** Pinned (bookmarked) state as last synced; bookmark changes do not touch the file, so the scan compares this. */
	pinned?: boolean;
	/** Set when the file must be re-read next sync although its stat is unchanged (link targets changed). */
	recheck?: string;
}

export interface SyncProblem {
	kind: 'too-large' | 'error';
	/** 'setting' = over the plugin's maximum note size; 'server' = Simplenote answered 413. */
	source?: 'setting' | 'server';
	detail: string;
	since: number;
	/** File size when the problem was recorded; the file is retried once its size changes. */
	size: number;
	mtime: number;
	count: number;
}

export interface PendingDelete {
	path: string;
	since: number;
}

export interface SyncState {
	cursor: string;
	notes: Record<string, NoteState>;
	/** Files without simplenote-id: path -> first time seen (ms). -1 = approved for immediate upload. */
	pendingNew: Record<string, number>;
	/** Notes whose local file vanished: id -> when first noticed. */
	pendingDeletes: Record<string, PendingDelete>;
	/** Notes whose local body became empty: id -> when first noticed. */
	pendingEmpty: Record<string, number>;
	/** Notes that changed on Simplenote while their file was unreadable, blocked, or excluded: id -> when first noticed. Re-fetched every sync until applied. */
	pendingRemote: Record<string, number>;
	/** Conflict copies with a duplicate simplenote-id; never uploaded automatically. */
	pausedPaths: string[];
	/** Excluded files already reported in the log (path -> reason). */
	knownExcluded: Record<string, string>;
	/** Files that cannot sync right now (path -> problem). Cleared when the file syncs again. */
	problems: Record<string, SyncProblem>;
	/** Notes this device trashed on Simplenote because the file vanished (id -> path). If the file comes back, the note is restored. */
	trashedByMe: Record<string, string>;
	/** Notes whose file has a conflict-copy name ("Note 2.md", "Note(1).md"): id -> the title the note keeps while it does. */
	keptTitles: Record<string, string>;
	/** One-time migration of the pinned property into bookmarks done. */
	pinnedMigrated: boolean;
	backupDone: boolean;
	firstRunDone: boolean;
	lastFullReconcile: number;
	lastSync: number;
}

export function emptyState(): SyncState {
	return {
		cursor: '',
		notes: {},
		pendingNew: {},
		pendingDeletes: {},
		pendingEmpty: {},
		pendingRemote: {},
		pausedPaths: [],
		knownExcluded: {},
		problems: {},
		trashedByMe: {},
		keptTitles: {},
		pinnedMigrated: false,
		backupDone: false,
		firstRunDone: false,
		lastFullReconcile: 0,
		lastSync: 0,
	};
}

export function normalizeState(raw: unknown): SyncState {
	const s = emptyState();
	if (!raw || typeof raw !== 'object') return s;
	const r = raw as Partial<SyncState>;
	if (typeof r.cursor === 'string') s.cursor = r.cursor;
	if (r.notes && typeof r.notes === 'object') {
		for (const [id, n] of Object.entries(r.notes)) {
			if (n && typeof n === 'object' && typeof n.path === 'string') {
				s.notes[id] = {
					id,
					path: n.path,
					version: typeof n.version === 'number' ? n.version : 0,
					contentHash: typeof n.contentHash === 'string' ? n.contentHash : '',
					tags: Array.isArray(n.tags) ? n.tags : [],
					systemTags: Array.isArray(n.systemTags) ? n.systemTags : ['markdown'],
					mtime: typeof n.mtime === 'number' ? n.mtime : 0,
					size: typeof n.size === 'number' ? n.size : -1,
					...(typeof n.recheck === 'string' ? { recheck: n.recheck } : {}),
					...(typeof n.pinned === 'boolean' ? { pinned: n.pinned } : {}),
				};
			}
		}
	}
	if (r.pendingNew && typeof r.pendingNew === 'object') s.pendingNew = { ...r.pendingNew };
	if (r.pendingDeletes && typeof r.pendingDeletes === 'object') s.pendingDeletes = { ...r.pendingDeletes };
	if (r.pendingEmpty && typeof r.pendingEmpty === 'object') s.pendingEmpty = { ...r.pendingEmpty };
	if (r.pendingRemote && typeof r.pendingRemote === 'object') s.pendingRemote = { ...r.pendingRemote };
	if (Array.isArray(r.pausedPaths)) s.pausedPaths = r.pausedPaths.filter((p): p is string => typeof p === 'string');
	if (r.knownExcluded && typeof r.knownExcluded === 'object') s.knownExcluded = { ...r.knownExcluded };
	if (r.problems && typeof r.problems === 'object') s.problems = { ...r.problems };
	if (r.trashedByMe && typeof r.trashedByMe === 'object') s.trashedByMe = { ...r.trashedByMe };
	if (r.keptTitles && typeof r.keptTitles === 'object') s.keptTitles = { ...r.keptTitles };
	s.pinnedMigrated = r.pinnedMigrated === true;
	s.backupDone = r.backupDone === true;
	s.firstRunDone = r.firstRunDone === true;
	if (typeof r.lastFullReconcile === 'number') s.lastFullReconcile = r.lastFullReconcile;
	if (typeof r.lastSync === 'number') s.lastSync = r.lastSync;
	return s;
}

export interface StateStore {
	load(): SyncState;
	save(state: SyncState): void;
}

/** In-memory store (tests). */
export class MemoryStateStore implements StateStore {
	private state: SyncState = emptyState();
	load(): SyncState {
		return normalizeState(JSON.parse(JSON.stringify(this.state)));
	}
	save(state: SyncState): void {
		this.state = JSON.parse(JSON.stringify(state)) as SyncState;
	}
}

/** Index of state by path (case-insensitive, NFC). */
export function pathIndex(state: SyncState): Map<string, NoteState> {
	const m = new Map<string, NoteState>();
	for (const n of Object.values(state.notes)) m.set(n.path.normalize('NFC').toLocaleLowerCase('en-US'), n);
	return m;
}
