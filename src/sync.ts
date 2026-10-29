/**
 * Sync engine: pull, first-run linking, push, deletions, guards.
 * Runs against VaultAdapter + SimperiumClient so it can be tested without Obsidian.
 */
import { joinFrontmatter, setKeys, splitFrontmatter } from './frontmatter';
import { computeCcid, newNoteId, noteHash } from './hash';
import { Logger } from './log';
import { mergeStrings } from './merge';
import {
	basenameMatchesTitle,
	basenameOfPath,
	encodeFolderTag,
	exclusionReason,
	fileToNote,
	folderFromTag,
	folderOfPath,
	isConflictCopyName,
	isFolderTag,
	joinPath,
	nameKey,
	noteToFileText,
	splitContent,
	splitTags,
	stripCollisionSuffix,
	tagKey,
	titleToFileName,
	uniqueBasename,
	type ExclusionReason,
	type TagStyle,
	type LocalNote,
} from './mapping';
import { LEASE_NOTE_ID, type PushLease } from './lease';
import { matchFirstRun, removeTitleLine, type FirstRunDecision, type FirstRunProposal, type LocalCandidate, type RemoteCandidate } from './firstrun';
import { AuthError, SimperiumClient, SimperiumError, type IndexEntry, type NoteData } from './simperium';
import type { NoteState, StateStore, SyncProblem, SyncState } from './state';
import type { BookmarkAdapter, FileInfo, VaultAdapter } from './vault';

export const NEW_FILE_WAIT_MS = 2 * 60 * 1000;
export const SUSPICIOUS_WAIT_MS = 60 * 1000;
/** How long a delete made in Obsidian is remembered while its note waits to be trashed. */
export const USER_DELETE_TTL_MS = 10 * 60 * 1000;
/** On a shared vault the vault sync can hide a file for minutes while it moves folders around; wait longer before trashing its note. */
export const SHARED_VAULT_VANISH_WAIT_MS = 10 * 60 * 1000;
export const FULL_RECONCILE_MS = 24 * 60 * 60 * 1000;
/** Conflict copies of a note must stay unchanged this long before the synced copy gets its name back. */
export const CONFLICT_SETTLE_MS = 30 * 1000;
/** How many versions back the Simplenote history is searched for the text of a surplus conflict copy. */
export const CONFLICT_HISTORY_DEPTH = 25;
export const GUARD_LIMITS = { trash: 10, move: 20, change: 50 };

export interface EngineSettings {
	excludedFolders: string[];
	maxNoteSizeKb: number;
	dryRun: boolean;
	translateLinks: boolean;
	tagStyle?: TagStyle;
	/** The vault is shared through a vault sync (iCloud, Obsidian Sync): only the device holding the push lease pushes. */
	sharedVault?: boolean;
}

export interface ExcludedFile {
	path: string;
	reason: ExclusionReason;
}

export function describeExclusion(reason: ExclusionReason): string {
	switch (reason) {
		case 'not-markdown':
			return 'not a Markdown file';
		case 'dot-folder':
			return 'in a dot folder (.obsidian, .trash, …)';
		case 'excalidraw':
			return 'Excalidraw drawing';
		case 'excluded-folder':
			return 'in an excluded folder (setting)';
		case 'too-large':
			return 'larger than the maximum note size (setting)';
		case 'case-conflict':
			return 'folder differs only by case from another folder';
	}
}

export interface PlanSummary {
	trash: number;
	move: number;
	change: number;
	causes: string[];
	items: string[];
}

export type SyncStatus =
	| { kind: 'idle'; at: number; problems: number; pullOnly?: string | null }
	| { kind: 'syncing' }
	| { kind: 'paused'; reason: string }
	| { kind: 'error'; message: string };

export interface SyncResult {
	ok: boolean;
	skipped?: 'paused' | 'guard-declined' | 'first-run-cancelled' | 'no-token' | 'already-running';
	pulled: number;
	pushed: number;
	trashed: number;
	errors: string[];
	dryRun: boolean;
}

export interface CleanupResult {
	/** Files moved to the Obsidian trash. */
	trashed: string[];
	/** Files kept as the single copy of their note. */
	kept: string[];
	/** Copies whose text differs; left for the owner to merge. */
	skipped: string[];
	/** Duplicate notes moved to the Simplenote trash. */
	notesTrashed: number;
	dryRun: boolean;
}

export interface LinkTranslator {
	/** Body text of a local file -> body text to push. Must be deterministic across devices. */
	toRemote(body: string, path: string): string;
	/** Body text from Simplenote -> body text for the local file. */
	toLocal(body: string): string;
	/** Paths of notes that link to the given path (used to re-push them once the target has an id). */
	backlinks(path: string): string[];
}

export interface EngineDeps {
	vault: VaultAdapter;
	client: SimperiumClient;
	store: StateStore;
	log: Logger;
	settings: () => EngineSettings;
	now?: () => number;
	confirmPlan: (summary: PlanSummary) => Promise<boolean>;
	firstRun: (proposal: FirstRunProposal, excluded: ExcludedFile[]) => Promise<FirstRunDecision | null>;
	notice: (msg: string) => void;
	onStatus?: (status: SyncStatus) => void;
	translator?: LinkTranslator;
	/** Push lease for shared vaults (used when the sharedVault setting is on). */
	lease?: PushLease;
}

interface LocalFile {
	info: FileInfo;
	id: string | null;
	/** Stat differs from state (or no state entry). */
	changed: boolean;
	excluded: ExclusionReason | null;
	text?: string;
	note?: LocalNote;
	unreadable?: boolean;
}

interface Scan {
	files: LocalFile[];
	byId: Map<string, LocalFile>;
	/** Ids carried by excluded or blocked files: present locally, but not synced. */
	presentIds: Set<string>;
	/** Name keys of files that exist but could not be read this sync (vault-sync placeholders). */
	unreadable: Set<string>;
	noId: LocalFile[];
	excluded: LocalFile[];
	pathKeys: Set<string>;
	folders: string[];
}

type ActionKind = 'create-local' | 'update-local' | 'trash-local' | 'adopt' | 'push' | 'merge' | 'create-remote' | 'trash-remote';

interface Action {
	kind: ActionKind;
	category: 'trash' | 'move' | 'change' | 'none';
	path: string;
	id: string;
	describe: string;
	moveFrom?: string;
	moveTo?: string;
	/** Actions sharing a group count as one change in the mass-change guard. */
	group?: string;
	/** Trash of a note whose file the owner deleted in Obsidian on this device: allowed on standby too. */
	byUser?: boolean;
	run: () => Promise<void>;
}

export class SyncEngine {
	private readonly vault: VaultAdapter;
	private readonly client: SimperiumClient;
	private readonly store: StateStore;
	private readonly log: Logger;
	private readonly settingsFn: () => EngineSettings;
	private readonly now: () => number;
	private readonly deps: EngineDeps;
	private chain: Promise<unknown> = Promise.resolve();
	private running = false;
	private queued: Promise<SyncResult> | null = null;
	private state!: SyncState;
	private dryRun = false;
	private sharedVault = false;
	/** The "another device uses the shared-vault setting" notice was shown this session. */
	private sharedNoticed = false;
	/** Set when this device just took the sync lease over: the next sync fetches the full index to catch up. */
	private fullNext = false;
	/** Paths of files the current plan will create, so link translation can resolve them during the batch. */
	private planned = new Map<string, string>();
	/** Files the owner deleted in Obsidian on this device (name key -> when, and the id the file carried), as opposed to files that vanished. */
	private readonly userDeletes = new Map<string, { at: number; path: string; id?: string }>();
	/** Folder pairs differing only by case that were already shown in a notice this session. */
	private caseConflictNoticed = new Set<string>();
	/** Files the owner renamed or created in Obsidian on this device (name keys), until the state has caught up with them. */
	private readonly userNames = new Set<string>();
	/** Empty conflict-copy files already reported in the log this session. */
	private emptyCopyNoticed = new Set<string>();
	/** Conflict copies of a note waiting to settle: note id -> when this set of copies was first seen, and its signature. */
	private readonly conflictCopiesSeen = new Map<string, { since: number; sig: string }>();
	/** Name of the device holding the push lease while this device pulls only; null when this device pushes. */
	pullOnly: string | null = null;
	paused = false;
	pauseReason = '';
	status: SyncStatus = { kind: 'idle', at: 0, problems: 0 };

	constructor(deps: EngineDeps) {
		this.deps = deps;
		this.vault = deps.vault;
		this.client = deps.client;
		this.store = deps.store;
		this.log = deps.log;
		this.settingsFn = deps.settings;
		this.now = deps.now ?? (() => Date.now());
	}

	private setStatus(s: SyncStatus): void {
		this.status = s;
		this.deps.onStatus?.(s);
	}

	/** Current list of excluded Markdown files with reasons (from the last scan). */
	excludedFiles(): ExcludedFile[] {
		const st = this.state ?? this.store.load();
		return Object.entries(st.knownExcluded)
			.map(([path, reason]) => ({ path, reason: reason as ExclusionReason }))
			.sort((a, b) => (a.path < b.path ? -1 : 1));
	}

	lastSyncAt(): number {
		return (this.state ?? this.store.load()).lastSync;
	}

	/** id -> path of all notes known on this device. */
	knownNotes(): Map<string, string> {
		const st = this.state ?? this.store.load();
		const m = new Map<string, string>();
		for (const n of Object.values(st.notes)) m.set(n.id, n.path);
		for (const [id, path] of this.planned) if (!m.has(id)) m.set(id, path);
		return m;
	}

	/**
	 * The owner deleted this file in Obsidian on this device. Its note is trashed on the next sync without the
	 * vanished-file wait (on standby too), and a copy of the file that comes back later does not restore the note.
	 */
	noteDeletedByUser(path: string, id?: string): void {
		this.userDeletes.set(nameKey(path), { at: this.now(), path, id: id || undefined });
	}

	/** The owner renamed or created this file in Obsidian on this device: its name is the title, even one like "Chapter 2". */
	noteNamedByUser(path: string): void {
		this.userNames.add(nameKey(path));
	}

	pause(reason = 'paused by user'): void {
		this.paused = true;
		this.pauseReason = reason;
		this.setStatus({ kind: 'paused', reason });
	}

	resume(): void {
		this.paused = false;
		const st = this.store.load();
		this.setStatus({ kind: 'idle', at: st.lastSync, problems: Object.keys(st.problems).length, pullOnly: this.pullOnly });
	}

	/** Shared vault: the next sync takes the push lease over from whichever device holds it. */
	takeOver(): void {
		this.deps.lease?.requestTakeover();
	}

	/** Files that currently cannot sync, with what to do about them. */
	problems(): { path: string; problem: SyncProblem; remedy: string }[] {
		const st = this.state ?? this.store.load();
		return Object.entries(st.problems)
			.map(([path, problem]) => ({ path, problem, remedy: remedyFor(problem) }))
			.sort((a, b) => (a.path < b.path ? -1 : 1));
	}

	private recordProblem(path: string, kind: SyncProblem['kind'], detail: string, source?: SyncProblem['source']): void {
		const info = this.vault.stat(path);
		const prev = this.state.problems[path];
		const count = (prev?.count ?? 0) + 1;
		const problem: SyncProblem = { kind, source, detail, since: prev?.since ?? this.now(), size: info?.size ?? -1, mtime: info?.mtime ?? -1, count };
		this.state.problems[path] = problem;
		if (kind === 'error' && count < 3) return; // transient errors are retried quietly a couple of times
		if (prev && prev.kind === kind && prev.source === source && prev.size === (info?.size ?? -1)) return; // already announced for this file state
		const remedy = remedyFor(problem);
		this.log.warn(`not syncing: ${path}: ${detail}. ${remedy}`);
		this.deps.notice(`Simplenote: "${path}" is not syncing. ${detail}. ${remedy}`);
	}

	private clearProblem(path: string): void {
		if (this.state.problems[path]) {
			delete this.state.problems[path];
			this.log.info(`syncing again: ${path}`);
		}
	}

	/** True when the file has not changed since its problem was recorded (no point retrying). */
	private stillBlocked(path: string, info: FileInfo): boolean {
		const p = this.state.problems[path];
		if (!p) return false;
		if (p.kind === 'error' && p.count < 3) return false;
		if (p.kind === 'too-large' && p.source === 'setting') return false; // the limit may have changed: re-evaluated by the scan
		return p.size === info.size && p.mtime === info.mtime;
	}

	/** Runs a sync. Calls are serialized; a call made while a sync runs is coalesced into one follow-up run. */
	sync(opts: { full?: boolean; reason?: string } = {}): Promise<SyncResult> {
		if (this.running && this.queued) return this.queued;
		const p: Promise<SyncResult> = this.chain.then(() => this.run(opts));
		this.chain = p.catch(() => undefined);
		if (this.running) {
			this.queued = p;
			void p.finally(() => {
				if (this.queued === p) this.queued = null;
			});
		}
		return p;
	}

	private async run(opts: { full?: boolean; reason?: string }): Promise<SyncResult> {
		const result: SyncResult = { ok: true, pulled: 0, pushed: 0, trashed: 0, errors: [], dryRun: false };
		if (this.paused) return { ...result, skipped: 'paused' };
		if (!this.client.hasToken()) {
			this.setStatus({ kind: 'error', message: 'Not logged in' });
			return { ...result, ok: false, skipped: 'no-token' };
		}
		this.running = true;
		this.setStatus({ kind: 'syncing' });
		const settings = this.settingsFn();
		this.dryRun = settings.dryRun;
		this.sharedVault = settings.sharedVault === true;
		result.dryRun = this.dryRun;
		this.state = this.store.load();
		const now = this.now();
		this.log.info(`sync start${opts.reason ? ` (${opts.reason})` : ''}${this.dryRun ? ' [dry-run]' : ''}`);
		try {
			let full = opts.full === true || this.fullNext || this.state.cursor.length === 0 || now - this.state.lastFullReconcile > FULL_RECONCILE_MS;
			this.fullNext = false;
			let fetched: { entries: IndexEntry[]; current: string };
			try {
				fetched = await this.client.fetchIndex(full ? undefined : this.state.cursor);
			} catch (e) {
				if (!full && e instanceof SimperiumError && e.status >= 400 && e.status < 500 && !(e instanceof AuthError)) {
					this.log.warn(`cursor rejected (HTTP ${e.status}); fetching the full index`);
					full = true;
					fetched = await this.client.fetchIndex();
				} else throw e;
			}
			this.log.debug(`index: ${fetched.entries.length} entries, full=${full}`);
			for (const e of fetched.entries) this.deps.lease?.observe(e);
			fetched.entries = fetched.entries.filter((e) => e.id !== LEASE_NOTE_ID);
			// A device without the shared-vault setting follows the lease anyway once one exists: settings live in
			// .obsidian, which a vault sync does not always carry, and one device pushing on its own next to the
			// lease holder produced duplicated fragments and conflict copies (NOTES.md, 0.4.4 incident, item 7).
			let shared = settings.sharedVault === true;
			if (!shared && this.deps.lease && !this.dryRun && (await this.deps.lease.exists())) {
				shared = true;
				if (!this.sharedNoticed) {
					this.sharedNoticed = true;
					this.log.warn('another device syncs this vault with the shared-vault setting; following its sync lease (turn the setting on here as well)');
					this.deps.notice('Simplenote: another device syncs this vault with "Shared vault: one device syncs at a time". This device follows that lease. Please turn the setting on here as well.');
				}
			}
			this.sharedVault = shared;
			const lease = shared && !this.dryRun ? this.deps.lease : undefined;
			await this.migratePinnedProperty();
			let scan = await this.scanLocal(settings);
			let preConfirmed = false;
			if (!this.state.firstRunDone) {
				if (!full) {
					fetched = await this.client.fetchIndex();
					for (const e of fetched.entries) this.deps.lease?.observe(e);
					fetched.entries = fetched.entries.filter((e) => e.id !== LEASE_NOTE_ID);
					full = true;
				}
				const ok = await this.runFirstRun(fetched.entries, scan);
				if (!ok) {
					this.log.info('first run cancelled by the owner');
					this.setStatus({ kind: 'paused', reason: 'first run cancelled' });
					return { ...result, skipped: 'first-run-cancelled' };
				}
				preConfirmed = true;
				scan = await this.scanLocal(settings);
			}
			let actions = await this.plan(fetched.entries, scan, full, now);
			let takeover = false;
			if (lease) {
				const d = await lease.decide(now);
				const wasPullOnly = this.pullOnly;
				this.pullOnly = d.holder ? null : (d.holderName ?? 'another device');
				if (!d.holder) {
					// Standby: the holder syncs this vault in both directions and the vault sync carries its writes
					// here. Only state-keeping actions run; writing pulled notes on two devices at once made
					// iCloud for Windows rename files to `Note(1).md` and folders to `Folder(1)`.
					// A trash of a note whose file the owner deleted here writes nothing to the vault: it runs on
					// standby too, otherwise the holder only sees a vanished file and restores the note if it comes back.
					const keep = (a: Action): boolean => a.kind === 'adopt' || (a.kind === 'trash-remote' && a.byUser === true);
					const held = actions.filter((a) => !keep(a));
					actions = actions.filter(keep);
					if (wasPullOnly !== this.pullOnly) this.log.info(`standby: ${this.pullOnly} holds the sync lease and syncs this vault; this device changes nothing until the lease moves`);
					if (held.length > 0) this.log.debug(`${held.length} change(s) wait for the sync lease`);
				} else if (wasPullOnly !== null) {
					this.log.info('this device holds the sync lease now; full reconcile on the next sync');
					this.fullNext = true;
					takeover = true;
					// files that vanished while on standby are re-checked from now, and nothing is trashed on the takeover sync
					actions = actions.filter((a) => a.kind !== 'trash-remote' || a.byUser === true);
					for (const pd of Object.values(this.state.pendingDeletes)) pd.since = now;
				}
			} else this.pullOnly = null;
			const summary = summarize(actions);
			if (actions.length > 0) this.log.info(`plan: ${summary.change} change(s), ${summary.move} move(s), ${summary.trash} trash(es)`);
			for (const d of summary.items) this.log.debug(`  ${d}`);
			if (!preConfirmed && overThreshold(summary)) {
				this.log.warn(`mass-change guard: ${summary.causes.join('; ')}`);
				const ok = await this.deps.confirmPlan(summary);
				if (!ok) {
					this.pause('large change declined; resume to re-check');
					return { ...result, skipped: 'guard-declined' };
				}
			}
			const remoteWrites = actions.some((a) => isRemoteWrite(a.kind));
			if (remoteWrites && !this.state.backupDone) await this.backup(full ? fetched.entries : null);
			let pullFailed = false;
			let n = 0;
			const trashedLocally: string[] = [];
			for (const a of actions) {
				try {
					await a.run();
					if (a.path) this.clearProblem(a.path);
					if (a.kind === 'create-local' || a.kind === 'update-local') result.pulled++;
					else if (a.kind === 'push' || a.kind === 'merge' || a.kind === 'create-remote') result.pushed++;
					else if (a.kind === 'trash-local' || a.kind === 'trash-remote') result.trashed++;
					if (a.kind === 'trash-local') trashedLocally.push(a.path);
				} catch (e) {
					if (e instanceof AuthError) throw e;
					if (e instanceof SimperiumError && e.status === 413) {
						const size = this.vault.stat(a.path)?.size ?? 0;
						this.recordProblem(a.path, 'too-large', `Simplenote refused it as too large (${Math.round(size / 1024)} KB)`, 'server');
						continue;
					}
					const msg = `${a.kind} ${a.path}: ${errorText(e)}`;
					this.log.error(msg);
					result.errors.push(msg);
					if (a.kind !== 'trash-local' && a.kind !== 'adopt') this.recordProblem(a.path, 'error', `sync keeps failing (${errorText(e)})`);
					if (a.kind === 'create-local' || a.kind === 'update-local' || a.kind === 'trash-local' || a.kind === 'adopt') pullFailed = true;
				}
				if (!this.dryRun && ++n % 10 === 0) this.store.save(this.state);
			}
			// writes to the vault: only the device that syncs it, never on the takeover sync
			if (!this.dryRun && this.pullOnly === null && !takeover) {
				try {
					await this.restoreConflictCopyNames(now);
				} catch (e) {
					if (e instanceof AuthError) throw e;
					this.log.error(`restoring conflict copy names: ${errorText(e)}`);
				}
			}
			if (trashedLocally.length > 0) {
				const shown = trashedLocally.slice(0, 3).join(', ');
				this.deps.notice(`Simplenote: ${trashedLocally.length} file(s) moved to the Obsidian trash because their notes were trashed on Simplenote: ${shown}${trashedLocally.length > 3 ? ', …' : ''}`);
			}
			if (!this.dryRun) {
				if (!pullFailed) this.state.cursor = fetched.current;
				if (full && !pullFailed) this.state.lastFullReconcile = now;
				this.state.lastSync = now;
				this.store.save(this.state);
			}
			result.ok = result.errors.length === 0;
			this.log.info(`sync done: pulled ${result.pulled}, pushed ${result.pushed}, trashed ${result.trashed}${result.errors.length ? `, ${result.errors.length} error(s)` : ''}`);
			if (result.ok) this.setStatus({ kind: 'idle', at: now, problems: Object.keys(this.state.problems).length, pullOnly: this.pullOnly });
			else this.setStatus({ kind: 'error', message: result.errors[0] ?? 'error' });
			return result;
		} catch (e) {
			const msg = errorText(e);
			this.log.error(`sync failed: ${msg}`);
			if (e instanceof AuthError) {
				this.deps.notice('Simplenote: login expired. Please log in again in the plugin settings.');
				this.setStatus({ kind: 'error', message: 'Login required' });
			} else {
				this.setStatus({ kind: 'error', message: msg });
			}
			return { ...result, ok: false, errors: [msg] };
		} finally {
			this.running = false;
		}
	}

	/** A `pinned` property found in a file is turned into a bookmark and removed (bookmarks available only). */
	private async dropPinnedProperty(lf: LocalFile): Promise<void> {
		if (this.dryRun || !this.bookmarksAvailable() || lf.text === undefined) return;
		const fm = splitFrontmatter(lf.text);
		if (!fm.hasBlock || fm.invalid || !('pinned' in fm.data)) return;
		if (fm.data.pinned === true) (this.vault.bookmarks as BookmarkAdapter).setBookmarked(lf.info.path, true);
		try {
			lf.info = await this.vault.processFrontmatter(lf.info.path, (f) => {
				f.pinned = undefined;
			});
			lf.text = await this.vault.read(lf.info.path);
			this.log.info(`${lf.info.path}: pinned property moved into a bookmark`);
		} catch (e) {
			this.log.warn(`could not remove the pinned property from ${lf.info.path}: ${errorText(e)}`);
		}
	}

	/** One-time: turn a leftover `pinned` property into a bookmark and drop the property (bookmarks available only). */
	private async migratePinnedProperty(): Promise<void> {
		if (this.state.pinnedMigrated || this.dryRun || !this.bookmarksAvailable()) return;
		const bm = this.vault.bookmarks as BookmarkAdapter;
		let n = 0;
		for (const info of this.vault.listMarkdownFiles()) {
			const fm = await this.vault.readFrontmatter(info.path);
			if (!fm || !('pinned' in fm)) continue;
			if (fm.pinned === true) bm.setBookmarked(info.path, true);
			try {
				const written = await this.vault.processFrontmatter(info.path, (f) => {
					f.pinned = undefined;
				});
				const st = Object.values(this.state.notes).find((x) => nameKey(x.path) === nameKey(info.path));
				if (st) {
					st.mtime = written.mtime;
					st.size = written.size;
					st.pinned = fm.pinned === true;
				}
				n++;
			} catch (e) {
				this.log.warn(`could not remove the pinned property from ${info.path}: ${errorText(e)}`);
			}
		}
		if (n > 0) this.log.info(`moved the pinned property of ${n} file(s) into Obsidian bookmarks`);
		this.state.pinnedMigrated = true;
		this.store.save(this.state);
	}

	// ---------------- scanning ----------------

	private async scanLocal(settings: EngineSettings): Promise<Scan> {
		const byPath = new Map<string, NoteState>();
		for (const n of Object.values(this.state.notes)) byPath.set(nameKey(n.path), n);
		const files: LocalFile[] = [];
		const excluded: LocalFile[] = [];
		const pathKeys = new Set<string>();
		const idFiles = new Map<string, LocalFile[]>();
		const paused = new Set(this.state.pausedPaths.map(nameKey));
		const presentIds = new Set<string>();
		const unreadable = new Set<string>();
		// Records the id of a file that exists but will not take part in this sync, so that the plan
		// never creates a second file for its note.
		const noteId = async (path: string): Promise<void> => {
			const known = byPath.get(nameKey(path));
			if (known) presentIds.add(known.id);
			const fm = await this.vault.readFrontmatter(path);
			const id = fm?.['simplenote-id'];
			if (typeof id === 'string' && id.length > 0) presentIds.add(id);
		};
		// Simplenote tags are case-insensitive: two folders that differ only by case map to one tag.
		// The folder that holds notes wins, so an empty leftover from a case-only rename does no harm.
		const markdownFiles = this.vault.listMarkdownFiles();
		const foldersWithNotes = new Set(markdownFiles.map((f) => folderOfPath(f.path)));
		const canonicalFolder = new Map<string, string>();
		for (const f of [...this.vault.listFolders()].sort()) {
			const current = canonicalFolder.get(nameKey(f));
			if (current === undefined || (!foldersWithNotes.has(current) && foldersWithNotes.has(f))) canonicalFolder.set(nameKey(f), f);
		}
		const warnedFolders = new Set<string>();
		for (const info of markdownFiles) {
			pathKeys.add(nameKey(info.path));
			let reason = exclusionReason(info.path, info.size, settings);
			const folder = folderOfPath(info.path);
			const canonical = canonicalFolder.get(nameKey(folder));
			if (!reason && folder && canonical !== undefined && canonical !== folder) {
				reason = 'case-conflict';
				if (!warnedFolders.has(folder)) {
					warnedFolders.add(folder);
					this.log.warn(`folder "${folder}" differs only by case from "${canonical}"; its notes are skipped (Simplenote tags are case-insensitive)`);
					const pair = `${canonical}\u0000${folder}`;
					if (!this.caseConflictNoticed.has(pair)) {
						this.caseConflictNoticed.add(pair);
						this.deps.notice(`Simplenote: folders "${canonical}" and "${folder}" differ only in capital letters. Simplenote cannot tell them apart, so the notes in "${folder}" are not syncing. Please rename one folder or move its notes into the other, and do not keep two folders like this.`);
					}
				}
			}
			const lf: LocalFile = { info, id: null, changed: true, excluded: reason };
			if (reason === 'too-large') {
				const over = `larger than the maximum note size setting (${Math.round(info.size / 1024)} KB)`;
				this.recordProblem(info.path, 'too-large', over, 'setting');
				await noteId(info.path);
				continue;
			}
			if (this.state.problems[info.path]?.source === 'setting') this.clearProblem(info.path); // now under the limit
			if (reason) {
				excluded.push(lf);
				await noteId(info.path);
				if (this.state.knownExcluded[info.path] !== reason) {
					this.state.knownExcluded[info.path] = reason;
					this.log.warn(`excluded: ${info.path} (${describeExclusion(reason)})`);
				}
				continue;
			}
			delete this.state.knownExcluded[info.path];
			if (paused.has(nameKey(info.path))) {
				await noteId(info.path);
				continue;
			}
			if (this.stillBlocked(info.path, info)) {
				await noteId(info.path);
				continue;
			}
			const st = byPath.get(nameKey(info.path));
			const pinnedChanged = st !== undefined && st.pinned !== undefined && this.bookmarksAvailable() && (this.vault.bookmarks as BookmarkAdapter).isBookmarked(info.path) !== st.pinned;
			if (st && st.mtime === info.mtime && st.size === info.size && !st.recheck && !pinnedChanged) {
				lf.id = st.id;
				lf.changed = false;
			} else {
				const ok = await this.loadLocal(lf);
				if (!ok) {
					unreadable.add(nameKey(info.path));
					await noteId(info.path);
					continue;
				}
				lf.id = lf.note?.id ?? null;
			}
			files.push(lf);
			if (lf.id) {
				const arr = idFiles.get(lf.id);
				if (arr) arr.push(lf);
				else idFiles.set(lf.id, [lf]);
			}
		}
		const byId = new Map<string, LocalFile>();
		for (const [id, list] of idFiles) {
			if (list.length === 1) {
				byId.set(id, list[0] as LocalFile);
				continue;
			}
			const keeper = this.pickKeeper(id, list);
			byId.set(id, keeper);
			for (const other of list) {
				if (other === keeper) continue;
				if (!this.state.pausedPaths.includes(other.info.path)) {
					this.state.pausedPaths.push(other.info.path);
					const msg = `Duplicate simplenote-id in "${other.info.path}" and "${keeper.info.path}". Sync paused for "${other.info.path}". Merge or delete it by hand.`;
					this.log.warn(msg);
					this.deps.notice(`Simplenote: ${msg}`);
				}
			}
		}
		// drop paused entries whose file is gone
		this.state.pausedPaths = this.state.pausedPaths.filter((p) => pathKeys.has(nameKey(p)));
		for (const p of Object.keys(this.state.knownExcluded)) if (!pathKeys.has(nameKey(p))) delete this.state.knownExcluded[p];
		for (const p of Object.keys(this.state.problems)) if (!pathKeys.has(nameKey(p))) delete this.state.problems[p];
		if (excluded.length > 0) this.log.info(`${excluded.length} file(s) excluded from sync (command "List excluded files" shows them)`);
		const noId = files.filter((f) => f.id === null);
		return { files: files.filter((f) => f.id === null || byId.get(f.id) === f), byId, presentIds, unreadable, noId, excluded, pathKeys, folders: this.vault.listFolders().filter((f) => canonicalFolder.get(nameKey(f)) === f) };
	}

	private pickKeeper(id: string, list: LocalFile[]): LocalFile {
		const st = this.state.notes[id];
		if (st) {
			const match = list.find((f) => nameKey(f.info.path) === nameKey(st.path));
			if (match) return match;
		}
		// "Note (conflicted copy).md", "Note 2.md" (iCloud on macOS), "Note(1).md" (iCloud for Windows)
		const conflictRe = /\((conflict|conflicted copy|sync conflict)[^)]*\)|\b\d{4}-\d{2}-\d{2}\b| \d+\.md$|\S\(\d+\)(\(\d+\))*\.md$/i;
		const clean = list.filter((f) => !conflictRe.test(f.info.path));
		const pool = clean.length > 0 ? clean : list;
		return [...pool].sort((a, b) => a.info.path.length - b.info.path.length || (a.info.path < b.info.path ? -1 : 1))[0] as LocalFile;
	}

	/** Reads and converts a file. Returns false (and logs) when it cannot be read. */
	private async loadLocal(lf: LocalFile): Promise<boolean> {
		if (lf.note) return true;
		try {
			lf.text = await this.vault.read(lf.info.path);
		} catch (e) {
			lf.unreadable = true;
			this.log.warn(`cannot read ${lf.info.path} (${errorText(e)}); will retry later`);
			return false;
		}
		await this.dropPinnedProperty(lf);
		lf.note = fileToNote(lf.text ?? '', basenameOfPath(lf.info.path));
		if (lf.note.invalidFrontmatter) this.log.warn(`${lf.info.path}: frontmatter is not valid YAML; treating it as text`);
		return true;
	}

	// ---------------- hashing helpers ----------------

	/** Pinned state of a local file: the Obsidian bookmark when the core plugin is available, else the property. */
	private pinnedOf(path: string, note: LocalNote): boolean {
		const bm = this.vault.bookmarks;
		if (bm && bm.available()) return bm.isBookmarked(path);
		return note.pinned;
	}

	private bookmarksAvailable(): boolean {
		return !!this.vault.bookmarks && this.vault.bookmarks.available();
	}

	private localTags(lf: LocalFile, note: LocalNote): string[] {
		const folderTag = encodeFolderTag(folderOfPath(lf.info.path));
		return folderTag ? [...note.tags, folderTag] : [...note.tags];
	}

	private remoteContentFor(lf: LocalFile, note: LocalNote): string {
		const t = this.deps.translator;
		if (!t || !this.settingsFn().translateLinks) return note.content;
		return `${note.title}\n${t.toRemote(note.body, lf.info.path)}`;
	}

	private localContentFor(data: NoteData): string {
		const t = this.deps.translator;
		if (!t || !this.settingsFn().translateLinks) return data.content;
		const { title, body } = splitContent(data.content);
		return `${title}\n${t.toLocal(body)}`;
	}

	private async hashLocal(lf: LocalFile, note: LocalNote): Promise<string> {
		return noteHash(this.remoteContentFor(lf, note), this.localTags(lf, note).map(tagKey), this.pinnedOf(lf.info.path, note));
	}

	private async hashRemote(data: NoteData): Promise<string> {
		return noteHash(data.content, data.tags.map(tagKey), data.systemTags.includes('pinned'));
	}

	/** Hash of a file as written, used as the state hash so unchanged files compare equal. */
	private async hashText(path: string, text: string): Promise<string> {
		const note = fileToNote(text, basenameOfPath(path));
		const lf: LocalFile = { info: { path, mtime: 0, size: 0 }, id: note.id, changed: false, excluded: null };
		return this.hashLocal(lf, note);
	}

	/** Hash of the file this device would write for a remote note at the given path. */
	private async renderedHash(path: string, id: string, data: NoteData): Promise<string> {
		const content = this.localContentFor(data);
		const text = noteToFileText({ ...data, content }, id, basenameOfPath(path), this.settingsFn().tagStyle ?? 'inline', !this.bookmarksAvailable()).text;
		return this.hashText(path, text);
	}

	// ---------------- first run ----------------

	private async runFirstRun(entries: IndexEntry[], scan: Scan): Promise<boolean> {
		const remote: RemoteCandidate[] = [];
		for (const e of entries) {
			if (!e.d || e.d.deleted || scan.byId.has(e.id)) continue;
			remote.push({ id: e.id, version: e.v, data: e.d });
		}
		const local: LocalCandidate[] = [];
		for (const lf of scan.noId) {
			if (!(await this.loadLocal(lf))) continue;
			local.push({ path: lf.info.path, text: lf.text ?? '' });
		}
		const proposal = matchFirstRun(remote, local);
		if (proposal.matches.length === 0 && proposal.unmatchedRemote.length === 0 && proposal.unmatchedLocal.length === 0) {
			this.log.info('first run: nothing to link');
			if (!this.dryRun) {
				this.state.firstRunDone = true;
				this.store.save(this.state);
			}
			return true;
		}
		this.log.info(
			`first run: ${proposal.matches.length} match(es) (${proposal.matches.filter((m) => m.method === 'probable').length} probable, ${proposal.matches.filter((m) => m.method === 'title-line').length} title-line fixes), ${proposal.unmatchedRemote.length} remote note(s) without match, ${proposal.unmatchedLocal.length} local file(s) without match, ${scan.excluded.length} excluded`,
		);
		const decision = await this.deps.firstRun(
			proposal,
			scan.excluded.map((f) => ({ path: f.info.path, reason: f.excluded ?? 'not-markdown' })),
		);
		if (!decision) return false;
		for (const m of proposal.matches) {
			const confirmed = m.method !== 'probable' || decision.confirmedProbable.has(m.remote.id);
			if (!confirmed) {
				this.log.info(`first run: probable match not confirmed: ${m.local.path} <-> ${m.remote.id}`);
				if (decision.uploadUnmatched) this.state.pendingNew[m.local.path] = -1;
				continue;
			}
			const fix = m.method === 'title-line' && decision.applyTitleFixes;
			const desc = `first run: link ${m.local.path} -> ${m.remote.id} (${m.method}${fix ? ', title line removed' : ''})`;
			if (this.dryRun) {
				this.log.info(`[dry-run] ${desc}`);
				continue;
			}
			this.log.info(desc);
			let info = this.vault.stat(m.local.path);
			if (fix) info = await this.vault.write(m.local.path, removeTitleLine(m.local.text));
			const remoteOther = splitTags(m.remote.data.tags).otherTags;
			const localNote = fileToNote(fix ? removeTitleLine(m.local.text) : m.local.text, basenameOfPath(m.local.path));
			const tags = unionTags(localNote.tags, remoteOther);
			const pinned = m.remote.data.systemTags.includes('pinned') || this.pinnedOf(m.local.path, localNote);
			const values: Record<string, unknown> = { 'simplenote-id': m.remote.id };
			if (tags.length > 0) values.tags = tags;
			if (pinned && !this.bookmarksAvailable()) values.pinned = true;
			if (pinned && this.bookmarksAvailable()) (this.vault.bookmarks as BookmarkAdapter).setBookmarked(m.local.path, true);
			info = await this.assignId(m.local.path, fix ? removeTitleLine(m.local.text) : m.local.text, localNote, values);
			this.state.notes[m.remote.id] = {
				id: m.remote.id,
				path: m.local.path,
				version: m.remote.version,
				contentHash: await this.hashRemote(m.remote.data),
				tags: m.remote.data.tags,
				systemTags: m.remote.data.systemTags,
				// stat left unknown on purpose: the next plan compares the file and pushes local differences
				mtime: -1,
				size: -1,
			};
			void info;
		}
		if (decision.uploadUnmatched) for (const l of proposal.unmatchedLocal) this.state.pendingNew[l.path] = -1;
		if (!this.dryRun) {
			this.state.firstRunDone = true;
			this.store.save(this.state);
		}
		return true;
	}

	// ---------------- planning ----------------

	private async plan(entries: IndexEntry[], scan: Scan, full: boolean, now: number): Promise<Action[]> {
		const actions: Action[] = [];
		this.planned = new Map();
		const handled = new Set<string>();
		const remoteIds = new Set<string>();
		const taken = new Set(scan.pathKeys);
		const waitingOnUnreadable = new Set<string>();
		const folders = [...scan.folders];
		const ctx = { taken, folders };
		/** Files without an id already linked to a remote twin in this plan. */
		const claimed = new Set<string>();

		// Notes that changed on Simplenote while their file could not sync are not in the since-cursor
		// index any more: fetch them again until the file is available.
		const all = [...entries];
		const inIndex = new Set(entries.map((e) => e.id));
		for (const id of Object.keys(this.state.pendingRemote)) {
			if (inIndex.has(id) || !scan.byId.has(id)) continue;
			const got = await this.client.getNote(id);
			if (got) all.push({ id, v: got.version, d: got.data });
			else delete this.state.pendingRemote[id];
		}

		for (const entry of all) {
			remoteIds.add(entry.id);
			const id = entry.id;
			const st = this.state.notes[id];
			const lf = scan.byId.get(id);
			if (lf) delete this.state.pendingRemote[id];
			let data = entry.d;
			let version = entry.v;
			if (!data) {
				const got = await this.client.getNote(id);
				if (!got) {
					if (lf) actions.push(this.trashLocalAction(lf, id, 'deleted on Simplenote'));
					else delete this.state.notes[id];
					handled.add(id);
					continue;
				}
				data = got.data;
				version = got.version;
			}
			if (data.deleted) {
				handled.add(id);
				if (!lf) {
					if (scan.presentIds.has(id) && st) {
						// the file exists but cannot sync right now: decide once it is available
						this.state.pendingRemote[id] = now;
						continue;
					}
					delete this.state.notes[id];
					delete this.state.pendingDeletes[id];
					// trashedByMe stays: if the vanished file comes back later, its note is still restored
					continue;
				}
				if (!(await this.loadLocal(lf))) {
					this.state.pendingRemote[id] = now; // the since-cursor index will not repeat the trash
					continue;
				}
				const note = lf.note as LocalNote;
				const localHash = await this.hashLocal(lf, note);
				if (this.state.trashedByMe[id]) {
					// this device trashed the note because the file had vanished; the file is back: restore the note
					this.log.warn(`${lf.info.path} is back after it had vanished; restoring its note on Simplenote`);
					actions.push(this.restoreAction(lf, note, id, version, data));
					continue;
				}
				if (st && localHash !== st.contentHash) {
					this.log.warn(`${lf.info.path} was trashed on Simplenote but edited here since; keeping the file and restoring the note`);
					actions.push(this.restoreAction(lf, note, id, version, data));
					continue;
				}
				actions.push(this.trashLocalAction(lf, id, 'trashed on Simplenote'));
				continue;
			}
			delete this.state.trashedByMe[id];
			if (!lf) {
				if (scan.presentIds.has(id)) {
					// The file exists but is unreadable, blocked, paused, or excluded right now. Never create a
					// second file for the note; the change is applied once the file takes part in a sync again.
					if ((!st || version !== st.version) && this.state.pendingRemote[id] === undefined) {
						this.state.pendingRemote[id] = now;
						this.log.info(`${st?.path ?? id} changed on Simplenote but its file cannot sync right now; the change is applied when the file is available again`);
					}
					handled.add(id);
					continue;
				}
				// The file the note would get already exists but cannot be read (a vault-sync placeholder that is
				// still downloading, typically after another device renamed or cleaned up). Creating "Title (2).md"
				// now would leave two files for one note once the download finishes; wait instead.
				const wantedPath = this.pickPath(this.targetFolder(data, ctx), splitContent(data.content).title, { taken: new Set() });
				if (scan.unreadable.has(nameKey(wantedPath))) {
					if (this.state.pendingRemote[id] === undefined) {
						this.state.pendingRemote[id] = now;
						this.log.info(`${wantedPath} exists but cannot be read yet (vault sync still downloading it?); not creating a copy for the note`);
					}
					waitingOnUnreadable.add(id);
					handled.add(id);
					continue;
				}
				if (st && version === st.version) continue; // local file gone, remote unchanged: deletion flow decides
				if (this.deletedHereById(id, st)) {
					// deleted in Obsidian: the deletion flow trashes the note. If only a conflict copy with the same id
					// was deleted and the real file comes back, the change is applied then: the since-cursor index
					// will not repeat it.
					if (st) this.state.pendingRemote[id] = now;
					continue;
				}
				if (st) {
					this.log.info(`${st.path} is missing locally but changed on Simplenote; recreating it`);
					delete this.state.pendingDeletes[id];
				} else {
					// A note this device has never seen, with the same content as a local file that has no id yet:
					// another device created the note for that very file (vault sync has not delivered the id yet).
					const twin = await this.findUnlinkedTwin(data, scan, claimed);
					if (twin) {
						claimed.add(nameKey(twin.info.path));
						actions.push(this.linkTwinAction(twin, id, data, version));
						handled.add(id);
						continue;
					}
				}
				actions.push(this.createLocalAction(id, data, version, ctx));
				handled.add(id);
				continue;
			}
			if (st && st.version === version && !lf.changed) {
				handled.add(id);
				continue;
			}
			if (!(await this.loadLocal(lf))) {
				handled.add(id);
				continue;
			}
			// the note's own last push comes back in the index too, so a conflict copy can show up on this side
			if (st) this.keepTitleOfConflictCopy(lf, st);
			const note = lf.note as LocalNote;
			const localHash = await this.hashLocal(lf, note);
			const remoteHash = await this.hashRemote(data);
			handled.add(id);
			const tagUpdate = st ? this.folderTagUpdate(st, lf) : null;
			if (localHash === remoteHash && !tagUpdate) {
				actions.push(this.adoptAction(lf, id, data, version, localHash));
			} else if (!st) {
				// linked by id only (e.g. first sync on a new device): newer side wins
				if (lf.info.mtime > data.modificationDate * 1000) actions.push(this.pushAction(lf, note, id, version, data, undefined));
				else actions.push(this.updateLocalAction(lf, id, data, version, ctx));
			} else if (localHash === st.contentHash && !tagUpdate) {
				actions.push(this.updateLocalAction(lf, id, data, version, ctx));
			} else {
				const a = this.pushAction(lf, note, id, st.version, data, st, st.version !== version);
				if (tagUpdate && localHash === st.contentHash) a.group = tagUpdate;
				actions.push(a);
			}
		}

		// local side
		for (const lf of scan.files) {
			if (lf.id && handled.has(lf.id)) continue;
			if (lf.id) {
				const st = this.state.notes[lf.id];
				if (st) {
					const tagUpdate = this.folderTagUpdate(st, lf);
					if (tagUpdate) {
						if (!(await this.loadLocal(lf))) continue;
						this.keepTitleOfConflictCopy(lf, st);
						const a = this.pushAction(lf, lf.note as LocalNote, lf.id, st.version, undefined, st);
						a.group = tagUpdate;
						actions.push(a);
						handled.add(lf.id);
						continue;
					}
					if (!lf.changed && nameKey(st.path) === nameKey(lf.info.path)) continue;
					if (!(await this.loadLocal(lf))) continue;
					this.keepTitleOfConflictCopy(lf, st);
					const note = lf.note as LocalNote;
					const h = await this.hashLocal(lf, note);
					if (h === st.contentHash) {
						st.path = lf.info.path;
						st.mtime = lf.info.mtime;
						st.size = lf.info.size;
						delete st.recheck;
						continue;
					}
					if (note.body.trim().length === 0 && st.size > lf.info.size) {
						const first = this.state.pendingEmpty[lf.id];
						if (first === undefined) {
							this.state.pendingEmpty[lf.id] = now;
							this.log.warn(`${lf.info.path} became empty; waiting ${SUSPICIOUS_WAIT_MS / 1000} s before pushing`);
							continue;
						}
						if (now - first < SUSPICIOUS_WAIT_MS) continue;
					}
					delete this.state.pendingEmpty[lf.id];
					const a = this.pushAction(lf, note, lf.id, st.version, undefined, st);
					if (st.recheck) a.group = st.recheck;
					actions.push(a);
					handled.add(lf.id);
				} else if (!remoteIds.has(lf.id)) {
					if (!(await this.loadLocal(lf))) continue;
					actions.push(this.linkOrCreateAction(lf, lf.note as LocalNote, lf.id, ctx));
					handled.add(lf.id);
				}
				continue;
			}
			// no id
			if (claimed.has(nameKey(lf.info.path))) continue;
			if (await this.isEmptyConflictCopy(lf)) continue;
			const first = this.state.pendingNew[lf.info.path];
			if (first === undefined) {
				this.state.pendingNew[lf.info.path] = now;
				this.log.debug(`new file ${lf.info.path}: waiting ${NEW_FILE_WAIT_MS / 1000} s for an id from another device`);
				continue;
			}
			if (first !== -1 && now - first < NEW_FILE_WAIT_MS) continue;
			actions.push(this.createRemoteAction(lf, ctx));
		}
		for (const p of Object.keys(this.state.pendingNew)) if (!scan.pathKeys.has(nameKey(p))) delete this.state.pendingNew[p];

		// deletions and reconcile
		for (const st of Object.values(this.state.notes)) {
			if (handled.has(st.id)) continue;
			const lf = scan.byId.get(st.id);
			if (full && !remoteIds.has(st.id)) {
				if (lf) actions.push(this.trashLocalAction(lf, st.id, 'missing on Simplenote (full reconcile)'));
				else delete this.state.notes[st.id];
				continue;
			}
			if (lf) {
				delete this.state.pendingDeletes[st.id];
				continue;
			}
			if (scan.presentIds.has(st.id)) continue; // file exists but is excluded, paused, or blocked: leave the note alone
			// A file the owner deleted here is trashed at once; a file that only vanished (vault sync, iCloud
			// eviction) waits, and its note is restored if it comes back.
			const byUser = this.userDeletes.has(nameKey(st.path));
			const pd = this.state.pendingDeletes[st.id];
			const vanishWait = this.sharedVault ? SHARED_VAULT_VANISH_WAIT_MS : SUSPICIOUS_WAIT_MS;
			if (!pd && !byUser) {
				this.state.pendingDeletes[st.id] = { path: st.path, since: now };
				this.log.warn(`${st.path} vanished; waiting ${vanishWait / 1000} s before trashing the note`);
				continue;
			}
			if (!byUser && pd && now - pd.since < vanishWait) continue;
			if (this.vault.exists(st.path)) {
				delete this.state.pendingDeletes[st.id];
				this.userDeletes.delete(nameKey(st.path));
				continue;
			}
			actions.push(this.trashRemoteAction(st, byUser));
		}
		for (const id of Object.keys(this.state.pendingRemote)) if (!this.state.notes[id] && !scan.presentIds.has(id) && !waitingOnUnreadable.has(id)) delete this.state.pendingRemote[id];
		if (full) for (const id of Object.keys(this.state.trashedByMe)) if (!remoteIds.has(id)) delete this.state.trashedByMe[id];
		for (const id of Object.keys(this.state.keptTitles)) if (!this.state.notes[id]) delete this.state.keptTitles[id];
		// A deleted file whose note this device has no state for (a standby device that never adopted it): trash by id.
		for (const [k, d] of this.userDeletes) {
			if (!d.id || this.state.notes[d.id] || handled.has(d.id) || scan.byId.has(d.id) || scan.presentIds.has(d.id) || scan.pathKeys.has(k)) continue;
			actions.push(this.trashRemoteByIdAction(d.id, d.path));
		}
		// a delete that is long past, or of a file that had no note, says nothing about later files at that path
		for (const [k, d] of this.userDeletes) {
			const known = Object.values(this.state.notes).some((n) => nameKey(n.path) === k) || (d.id !== undefined && !handled.has(d.id) && !this.state.notes[d.id]);
			if (now - d.at > USER_DELETE_TTL_MS || !known) this.userDeletes.delete(k);
		}
		return actions;
	}

	/** Content-and-tags hash of a local file, ignoring pinned (bookmarks are device-local). */
	private async twinHashLocal(lf: LocalFile, note: LocalNote): Promise<string> {
		return noteHash(this.remoteContentFor(lf, note), this.localTags(lf, note).map(tagKey), false);
	}

	private async twinHashRemote(data: NoteData): Promise<string> {
		return noteHash(data.content, data.tags.map(tagKey), false);
	}

	/** A local file without an id whose content and tags equal the remote note's. */
	private async findUnlinkedTwin(data: NoteData, scan: Scan, claimed: Set<string>): Promise<LocalFile | null> {
		if (scan.noId.length === 0 || data.deleted) return null;
		const want = await this.twinHashRemote(data);
		for (const lf of scan.noId) {
			if (claimed.has(nameKey(lf.info.path))) continue;
			if (!(await this.loadLocal(lf))) continue;
			if ((await this.twinHashLocal(lf, lf.note as LocalNote)) === want) return lf;
		}
		return null;
	}

	/** Writes a remote note's id into the local file that another device created it from. */
	private linkTwinAction(lf: LocalFile, id: string, data: NoteData, version: number): Action {
		return {
			kind: 'update-local',
			category: 'change',
			path: lf.info.path,
			id,
			describe: `link ${lf.info.path} to note ${id} (same content, created by another device)`,
			run: async () => {
				if (this.dryRun) {
					this.log.info(`[dry-run] link ${lf.info.path} to note ${id}`);
					return;
				}
				const note = lf.note as LocalNote;
				const info = await this.assignId(lf.info.path, lf.text ?? '', note, { 'simplenote-id': id });
				const pinned = data.systemTags.includes('pinned');
				if (pinned && this.bookmarksAvailable()) (this.vault.bookmarks as BookmarkAdapter).setBookmarked(lf.info.path, true);
				this.log.info(`linked ${lf.info.path} to note ${id} created by another device for the same file`);
				this.state.notes[id] = {
					id,
					path: lf.info.path,
					version,
					contentHash: await this.hashRemote(data),
					tags: data.tags,
					systemTags: data.systemTags,
					mtime: info.mtime,
					size: info.size,
					pinned,
				};
				delete this.state.pendingNew[lf.info.path];
			},
		};
	}

	// ---------------- duplicate cleanup ----------------

	/**
	 * Finds files that share one simplenote-id, or "Title (n).md" copies with the same content as "Title.md"
	 * under another id, and moves the surplus copies to the Obsidian trash. A copy whose content differs from
	 * the kept file and from the note on Simplenote is left alone and reported. Serialized with sync runs.
	 */
	cleanupDuplicates(): Promise<CleanupResult> {
		const p = this.chain.then(() => this.runCleanup());
		this.chain = p.catch(() => undefined);
		return p;
	}

	private async runCleanup(): Promise<CleanupResult> {
		const result: CleanupResult = { trashed: [], kept: [], skipped: [], notesTrashed: 0, dryRun: false };
		if (!this.client.hasToken()) throw new AuthError('Not logged in');
		const settings = this.settingsFn();
		this.dryRun = settings.dryRun;
		result.dryRun = this.dryRun;
		this.state = this.store.load();
		this.log.info(`duplicate cleanup start${this.dryRun ? ' [dry-run]' : ''}`);
		const files: LocalFile[] = [];
		for (const info of this.vault.listMarkdownFiles()) {
			if (exclusionReason(info.path, info.size, settings)) continue;
			const lf: LocalFile = { info, id: null, changed: true, excluded: null };
			if (!(await this.loadLocal(lf))) continue;
			lf.id = lf.note?.id ?? null;
			files.push(lf);
		}
		const hashes = new Map<LocalFile, string>();
		for (const lf of files) hashes.set(lf, await this.copyHash(lf, lf.note as LocalNote));
		const trashFile = async (lf: LocalFile, why: string): Promise<void> => {
			if (this.dryRun) this.log.info(`[dry-run] trash ${lf.info.path} (${why})`);
			else {
				await this.vault.trash(lf.info.path);
				this.state.pausedPaths = this.state.pausedPaths.filter((p) => nameKey(p) !== nameKey(lf.info.path));
				delete this.state.problems[lf.info.path];
				delete this.state.pendingNew[lf.info.path];
				this.log.info(`trashed ${lf.info.path} (${why})`);
			}
			result.trashed.push(lf.info.path);
		};
		const gone = new Set<LocalFile>();

		// 1. several files with one id
		const byId = new Map<string, LocalFile[]>();
		for (const lf of files) {
			if (!lf.id) continue;
			const list = byId.get(lf.id);
			if (list) list.push(lf);
			else byId.set(lf.id, [lf]);
		}
		for (const [id, list] of byId) {
			if (list.length < 2) continue;
			const keeper = this.pickKeeper(id, list);
			const remote = await this.client.getNote(id);
			const accepted = new Set<string>([hashes.get(keeper) as string]);
			if (remote) accepted.add(await this.remoteCopyHash(remote.data));
			result.kept.push(keeper.info.path);
			for (const other of list) {
				if (other === keeper) continue;
				if (accepted.has(hashes.get(other) as string)) {
					await trashFile(other, `copy of ${keeper.info.path}, same note ${id}`);
					gone.add(other);
				} else {
					this.log.warn(`${other.info.path} shares note ${id} with ${keeper.info.path} but its text differs; left for you to merge by hand`);
					result.skipped.push(other.info.path);
				}
			}
		}

		// 2. "Title (n).md" with the same content as "Title.md" in the same folder, under another id
		const byName = new Map<string, LocalFile>();
		for (const lf of files) {
			if (gone.has(lf)) continue;
			const base = basenameOfPath(lf.info.path);
			if (stripCollisionSuffix(base) === base) byName.set(nameKey(lf.info.path), lf);
		}
		for (const lf of files) {
			if (gone.has(lf) || !lf.id) continue;
			const base = basenameOfPath(lf.info.path);
			const plain = stripCollisionSuffix(base);
			if (plain === base) continue;
			const original = byName.get(nameKey(joinPath(folderOfPath(lf.info.path), plain)));
			if (!original || !original.id || original.id === lf.id) continue;
			if (hashes.get(original) !== hashes.get(lf)) {
				this.log.warn(`${lf.info.path} looks like a copy of ${original.info.path} but its text differs; left alone`);
				result.skipped.push(lf.info.path);
				continue;
			}
			const remote = await this.client.getNote(lf.id);
			if (remote && !remote.data.deleted) {
				if (this.dryRun) this.log.info(`[dry-run] trash note ${lf.id} on Simplenote (duplicate of note ${original.id})`);
				else {
					let res = await this.client.postNote(lf.id, { deleted: true, modificationDate: this.now() / 1000 }, { baseVersion: remote.version });
					if (res.outcome === 'conflict') res = await this.client.postNote(lf.id, { deleted: true, modificationDate: this.now() / 1000 }, { baseVersion: res.version });
					this.log.info(`trashed note ${lf.id} on Simplenote (duplicate of note ${original.id})`);
				}
				result.notesTrashed++;
			}
			if (!this.dryRun) delete this.state.notes[lf.id];
			await trashFile(lf, `copy of ${original.info.path} under a second note`);
			gone.add(lf);
		}
		if (!this.dryRun) this.store.save(this.state);
		this.log.info(`duplicate cleanup done: ${result.trashed.length} file(s) trashed, ${result.notesTrashed} note(s) trashed on Simplenote, ${result.skipped.length} left alone`);
		return result;
	}

	/**
	 * Returns a plan group when the note must be pushed only to rewrite its folder tag: it still carries
	 * a 0.4.4-style tag for its folder (`obsidian:my%5Ffolder`, `obsidian:my%255Ffolder`). Change hashes
	 * count those as `_`, so nothing else would push it. The case of a folder is never a reason to push:
	 * Simplenote compares tags case-insensitively, and two devices on a shared vault can disagree about
	 * a folder's case for a long time (0.4.3 and 0.4.4 pushed the case back and forth between them).
	 */
	private folderTagUpdate(st: NoteState, lf: LocalFile): string | null {
		const folder = folderOfPath(lf.info.path);
		const tag = encodeFolderTag(folder);
		if (!tag || st.tags.some((t) => nameKey(t) === nameKey(tag))) return null;
		const stale = st.tags.find((t) => isFolderTag(t) && tagKey(t) === tagKey(tag));
		return stale ? `Folder "${folder}": folder tag ${stale} -> ${tag}` : null;
	}

	// ---------------- actions ----------------

	private targetFolder(data: NoteData, ctx: { folders: string[] }, path?: string): string {
		const { folderTags } = splitTags(data.tags);
		if (folderTags.length > 1) this.log.warn(`${path ?? data.content.split('\n')[0]}: ${folderTags.length} folder tags (${folderTags.join(', ')}); using ${folderTags[0]}`);
		const tag = folderTags[0];
		return tag ? folderFromTag(tag, ctx.folders) : '';
	}

	private pickPath(folder: string, title: string, ctx: { taken: Set<string> }, keep?: string): string {
		if (keep && basenameMatchesTitle(basenameOfPath(keep), title) && nameKey(folderOfPath(keep)) === nameKey(folder)) return keep;
		const keepKey = keep ? nameKey(keep) : '';
		const desired = titleToFileName(title);
		const base = uniqueBasename(desired, (b) => {
			const k = nameKey(joinPath(folder, b));
			return k !== keepKey && ctx.taken.has(k);
		});
		return joinPath(folder, base);
	}

	private async writeState(id: string, path: string, text: string, version: number, data: NoteData, info: FileInfo | null): Promise<void> {
		// the file was just named after the Simplenote title
		delete this.state.keptTitles[id];
		const pinned = data.systemTags.includes('pinned');
		if (this.bookmarksAvailable()) (this.vault.bookmarks as BookmarkAdapter).setBookmarked(path, pinned);
		this.state.notes[id] = {
			id,
			path,
			version,
			contentHash: await this.hashText(path, text),
			tags: data.tags,
			systemTags: data.systemTags,
			mtime: info?.mtime ?? 0,
			size: info?.size ?? -1,
			pinned,
		};
		delete this.state.pendingDeletes[id];
		delete this.state.pendingEmpty[id];
	}

	private createLocalAction(id: string, data: NoteData, version: number, ctx: { taken: Set<string>; folders: string[] }): Action {
		const title = splitContent(data.content).title;
		const folder = this.targetFolder(data, ctx);
		const path = this.pickPath(folder, title, ctx);
		ctx.taken.add(nameKey(path));
		this.planned.set(id, path);
		return {
			kind: 'create-local',
			category: 'change',
			path,
			id,
			describe: `create ${path} from Simplenote`,
			run: async () => {
				const content = this.localContentFor(data);
				const text = noteToFileText({ ...data, content }, id, basenameOfPath(path), this.settingsFn().tagStyle ?? 'inline', !this.bookmarksAvailable()).text;
				if (this.dryRun) {
					this.log.info(`[dry-run] create ${path}`);
					return;
				}
				if (folder && !this.vault.exists(folder)) {
					await this.vault.createFolder(folder);
					ctx.folders.push(folder);
				}
				const info = await this.vault.create(path, text, noteTimes(data));
				this.log.info(`created ${path}`);
				await this.writeState(id, path, text, version, data, info);
			},
		};
	}

	private updateLocalAction(lf: LocalFile, id: string, data: NoteData, version: number, ctx: { taken: Set<string>; folders: string[] }): Action {
		const title = splitContent(data.content).title;
		const folder = this.targetFolder(data, ctx, lf.info.path);
		const newPath = this.pickPath(folder, title, ctx, lf.info.path);
		const moved = nameKey(folderOfPath(newPath)) !== nameKey(folderOfPath(lf.info.path));
		return {
			kind: 'update-local',
			category: moved ? 'move' : 'change',
			path: lf.info.path,
			id,
			describe: `update ${lf.info.path} from Simplenote${newPath !== lf.info.path ? ` -> ${newPath}` : ''}`,
			moveFrom: moved ? folderOfPath(lf.info.path) : undefined,
			moveTo: moved ? folderOfPath(newPath) : undefined,
			run: async () => {
				await this.writeLocal(lf.info.path, id, data, version, ctx);
			},
		};
	}

	/** Writes remote data into an existing file, renaming or moving it when title or folder changed. */
	private async writeLocal(path: string, id: string, data: NoteData, version: number, ctx: { taken: Set<string>; folders: string[] }): Promise<void> {
		const title = splitContent(data.content).title;
		const folder = this.targetFolder(data, ctx, path);
		const newPath = this.pickPath(folder, title, ctx, path);
		const content = this.localContentFor(data);
		const text = noteToFileText({ ...data, content }, id, basenameOfPath(newPath), this.settingsFn().tagStyle ?? 'inline', !this.bookmarksAvailable()).text;
		if (this.dryRun) {
			this.log.info(`[dry-run] update ${path}${newPath !== path ? ` and rename to ${newPath}` : ''}`);
			return;
		}
		let info = await this.vault.write(path, text, { mtime: noteTimes(data).mtime });
		if (newPath !== path) {
			if (folder && !this.vault.exists(folder)) {
				await this.vault.createFolder(folder);
				ctx.folders.push(folder);
			}
			await this.renameFile(path, newPath);
			ctx.taken.delete(nameKey(path));
			ctx.taken.add(nameKey(newPath));
			info = this.vault.stat(newPath) ?? info;
			this.log.info(`updated ${path} and renamed to ${newPath}`);
		} else {
			this.log.info(`updated ${path}`);
		}
		await this.writeState(id, newPath, text, version, data, info);
	}

	private async renameFile(from: string, to: string): Promise<void> {
		if (nameKey(from) === nameKey(to)) {
			const tmp = to.replace(/\.md$/, `.${Date.now().toString(36)}.tmp.md`);
			await this.vault.rename(from, tmp);
			await this.vault.rename(tmp, to);
		} else {
			await this.vault.rename(from, to);
		}
	}

	private adoptAction(lf: LocalFile, id: string, data: NoteData, version: number, hash: string): Action {
		return {
			kind: 'adopt',
			category: 'none',
			path: lf.info.path,
			id,
			describe: `already in sync: ${lf.info.path}`,
			run: () => {
				if (this.dryRun) return Promise.resolve();
				this.state.notes[id] = { id, path: lf.info.path, version, contentHash: hash, tags: data.tags, systemTags: data.systemTags, mtime: lf.info.mtime, size: lf.info.size, pinned: data.systemTags.includes('pinned') };
				delete this.state.pendingDeletes[id];
				delete this.state.pendingEmpty[id];
				delete this.state.pendingNew[lf.info.path];
				return Promise.resolve();
			},
		};
	}

	private trashLocalAction(lf: LocalFile, id: string, why: string): Action {
		return {
			kind: 'trash-local',
			category: 'trash',
			path: lf.info.path,
			id,
			describe: `trash ${lf.info.path} (${why})`,
			run: async () => {
				if (this.dryRun) {
					this.log.info(`[dry-run] trash ${lf.info.path} (${why})`);
					return;
				}
				await this.vault.trash(lf.info.path);
				this.log.info(`trashed ${lf.info.path} (${why})`);
				delete this.state.notes[id];
				delete this.state.pendingDeletes[id];
			},
		};
	}

	private restoreAction(lf: LocalFile, note: LocalNote, id: string, version: number, remote: NoteData): Action {
		return {
			kind: 'push',
			category: 'change',
			path: lf.info.path,
			id,
			describe: `restore note on Simplenote from ${lf.info.path}`,
			run: async () => {
				await this.pushLocal(lf, note, id, version, remote, undefined);
				delete this.state.trashedByMe[id];
			},
		};
	}

	/**
	 * "Note.md" became "Note 2.md" or "Note(1).md": the vault sync made a conflict copy; keep the title. The title
	 * is remembered in `keptTitles`, because once the state follows the file to its new name, later edits of
	 * the copy would otherwise push the suffix. A rename by hand to any other name makes the file name the title again.
	 */
	private keepTitleOfConflictCopy(lf: LocalFile, st: NoteState): void {
		const k = nameKey(lf.info.path);
		if (this.userNames.has(k)) {
			delete this.state.keptTitles[st.id];
			if (nameKey(st.path) === k) this.userNames.delete(k);
			return;
		}
		const name = basenameOfPath(lf.info.path);
		const kept = this.state.keptTitles[st.id];
		if (kept !== undefined) {
			if (isConflictCopyName(kept, name)) {
				lf.note = fileToNote(lf.text ?? '', kept);
				return;
			}
			delete this.state.keptTitles[st.id];
		}
		if (
			nameKey(st.path) !== nameKey(lf.info.path) &&
			nameKey(folderOfPath(st.path)) === nameKey(folderOfPath(lf.info.path)) &&
			isConflictCopyName(basenameOfPath(st.path), name)
		) {
			this.log.warn(`${lf.info.path}: named like a sync conflict copy of ${st.path}; keeping the note title`);
			this.state.keptTitles[st.id] = basenameOfPath(st.path);
			lf.note = fileToNote(lf.text ?? '', basenameOfPath(st.path));
		}
	}

	/**
	 * iCloud for Windows renames a file that changed on two sides at once to "Note(1).md", "Note 2.md"…: the note
	 * seems to vanish and copies appear (2026-10-29, while a note was being edited). Once the copies of a note have
	 * stayed the same for `CONFLICT_SETTLE_MS`, the synced copy gets its kept name back, and the other copies of the
	 * same note go to the Obsidian trash when their text is already in the note's Simplenote history. A copy whose
	 * text is found nowhere stays, paused, for the owner to merge. Runs on the device that syncs the vault only.
	 */
	private async restoreConflictCopyNames(now: number): Promise<void> {
		const waiting = new Set<string>();
		const files = this.vault.listMarkdownFiles();
		for (const [id, kept] of Object.entries(this.state.keptTitles)) {
			const st = this.state.notes[id];
			if (!st || !isConflictCopyName(kept, basenameOfPath(st.path))) continue;
			const folder = folderOfPath(st.path);
			const target = joinPath(folder, kept);
			const cur = this.vault.stat(st.path);
			// a pending edit is pushed first; a file under the old name (back, or not readable yet) is left alone
			if (!cur || cur.mtime !== st.mtime || cur.size !== st.size || this.vault.exists(target)) continue;
			const copies = files.filter((f) => nameKey(folderOfPath(f.path)) === nameKey(folder) && isConflictCopyName(kept, basenameOfPath(f.path)));
			const sig = copies
				.map((f) => `${f.path}|${f.mtime}|${f.size}`)
				.sort()
				.join('\n');
			waiting.add(id);
			const seen = this.conflictCopiesSeen.get(id);
			if (!seen || seen.sig !== sig) {
				this.conflictCopiesSeen.set(id, { since: now, sig });
				continue;
			}
			if (now - seen.since < CONFLICT_SETTLE_MS) continue;

			const surplus = new Map<string, string>();
			for (const info of copies) {
				if (nameKey(info.path) === nameKey(st.path)) continue;
				const lf: LocalFile = { info, id: null, changed: true, excluded: null };
				if (!(await this.loadLocal(lf)) || lf.note?.id !== id) continue;
				surplus.set(info.path, await this.copyHash(lf, lf.note));
			}
			const known = surplus.size > 0 ? await this.findInHistory(id, new Set(surplus.values())) : new Set<string>();

			await this.vault.rename(st.path, target);
			const info = this.vault.stat(target);
			this.log.info(`${st.path}: name made by the vault sync; renamed back to ${target}`);
			st.path = target;
			if (info) {
				st.mtime = info.mtime;
				st.size = info.size;
			}
			delete this.state.keptTitles[id];
			this.conflictCopiesSeen.delete(id);
			let trashed = 0;
			for (const [path, hash] of surplus) {
				if (!known.has(hash)) {
					this.log.warn(`${path} is a copy of ${target} with text not found on Simplenote; left for you to merge by hand`);
					continue;
				}
				await this.vault.trash(path);
				this.state.pausedPaths = this.state.pausedPaths.filter((p) => nameKey(p) !== nameKey(path));
				delete this.state.problems[path];
				this.log.info(`trashed ${path} (older copy of ${target}, its text is in the Simplenote history)`);
				trashed++;
			}
			const left = surplus.size - trashed;
			this.deps.notice(
				`Simplenote: the vault sync renamed "${kept}"; its name is back${trashed > 0 ? `, ${trashed} older copy(ies) moved to the trash` : ''}${left > 0 ? `, ${left} copy(ies) with other text left to merge by hand` : ''}.`,
			);
		}
		for (const id of [...this.conflictCopiesSeen.keys()]) if (!waiting.has(id)) this.conflictCopiesSeen.delete(id);
	}

	/** The subset of `hashes` (see `copyHash`) found among the latest `CONFLICT_HISTORY_DEPTH` versions of a note. */
	private async findInHistory(id: string, hashes: Set<string>): Promise<Set<string>> {
		const found = new Set<string>();
		const current = await this.client.getNote(id);
		if (!current) return found;
		for (let v = current.version; v > 0 && v > current.version - CONFLICT_HISTORY_DEPTH && found.size < hashes.size; v--) {
			const old = v === current.version ? current : await this.client.getNote(id, v);
			if (!old) continue; // outside the server's retention
			const h = await this.remoteCopyHash(old.data);
			if (hashes.has(h)) found.add(h);
		}
		return found;
	}

	/** Copies in one folder differ in file name, hence in title: they are compared by body and tags only. */
	private copyHash(lf: LocalFile, note: LocalNote): Promise<string> {
		const body = splitContent(this.remoteContentFor(lf, note)).body;
		return noteHash(`\n${body}`, this.localTags(lf, note).map(tagKey), false);
	}

	private remoteCopyHash(data: NoteData): Promise<string> {
		return noteHash(`\n${splitContent(data.content).body}`, data.tags.map(tagKey), false);
	}

	/**
	 * An empty file without an id whose name is a conflict copy of a synced note in its folder ("Note(1).md" next
	 * to "Note.md"): what the vault sync leaves behind, not a note the owner wrote. It is never uploaded.
	 */
	private async isEmptyConflictCopy(lf: LocalFile): Promise<boolean> {
		const name = basenameOfPath(lf.info.path);
		if (!/(?: \d+| ?\(\d+\))$/.test(name) || this.userNames.has(nameKey(lf.info.path))) return false;
		const folder = nameKey(folderOfPath(lf.info.path));
		const titles: string[] = [];
		for (const st of Object.values(this.state.notes)) {
			if (nameKey(folderOfPath(st.path)) !== folder) continue;
			titles.push(basenameOfPath(st.path));
			const kept = this.state.keptTitles[st.id];
			if (kept !== undefined) titles.push(kept);
		}
		const of = titles.find((t) => isConflictCopyName(t, name));
		if (of === undefined) return false;
		if (!(await this.loadLocal(lf)) || (lf.note as LocalNote).body.trim().length > 0) return false;
		if (!this.emptyCopyNoticed.has(nameKey(lf.info.path))) {
			this.emptyCopyNoticed.add(nameKey(lf.info.path));
			this.log.warn(`${lf.info.path}: empty file named like a sync conflict copy of "${of}"; not creating a note for it. Delete it by hand.`);
		}
		return true;
	}

	/** True when the owner deleted the file of this note in Obsidian on this device. */
	private deletedHereById(id: string, st: NoteState | undefined): boolean {
		for (const [k, d] of this.userDeletes) if (d.id === id || (st && nameKey(st.path) === k)) return true;
		return false;
	}

	/** Trash of a note this device has no state for, whose file the owner deleted here. */
	private trashRemoteByIdAction(id: string, path: string): Action {
		return {
			kind: 'trash-remote',
			category: 'trash',
			path,
			id,
			byUser: true,
			describe: `trash note on Simplenote: ${path} (file deleted in Obsidian)`,
			run: async () => {
				if (this.dryRun) {
					this.log.info(`[dry-run] trash note ${id} (${path})`);
					return;
				}
				this.userDeletes.delete(nameKey(path));
				const got = await this.client.getNote(id);
				if (!got || got.data.deleted) return;
				const res = await this.client.postNote(id, { deleted: true, modificationDate: this.now() / 1000 }, { baseVersion: got.version });
				if (res.outcome === 'conflict') throw new Error('server refused the trash update');
				this.log.info(`trashed note on Simplenote: ${path}`);
				delete this.state.pendingDeletes[id];
				delete this.state.trashedByMe[id];
			},
		};
	}

	private trashRemoteAction(st: NoteState, byUser: boolean): Action {
		return {
			kind: 'trash-remote',
			category: 'trash',
			path: st.path,
			id: st.id,
			byUser,
			describe: `trash note on Simplenote: ${st.path} (${byUser ? 'file deleted in Obsidian' : 'file vanished from the vault'})`,
			run: async () => {
				if (this.dryRun) {
					this.log.info(`[dry-run] trash note ${st.id} (${st.path})`);
					return;
				}
				let res = await this.client.postNote(st.id, { deleted: true, modificationDate: this.now() / 1000 }, { baseVersion: st.version, ccid: await computeCcid(st.id, st.version, 'deleted') });
				if (res.outcome === 'conflict') {
					res = await this.client.postNote(st.id, { deleted: true, modificationDate: this.now() / 1000 }, { baseVersion: res.version });
					if (res.outcome === 'conflict') throw new Error('server refused the trash update');
				}
				this.log.info(`trashed note on Simplenote: ${st.path}`);
				delete this.state.notes[st.id];
				delete this.state.pendingDeletes[st.id];
				this.userDeletes.delete(nameKey(st.path));
				// only a file that vanished by itself restores its note when it comes back
				if (byUser) delete this.state.trashedByMe[st.id];
				else this.state.trashedByMe[st.id] = st.path;
			},
		};
	}

	private pushAction(lf: LocalFile, note: LocalNote, id: string, baseVersion: number, remote: NoteData | undefined, st: NoteState | undefined, bothChanged = false): Action {
		const localFolder = folderOfPath(lf.info.path);
		const stFolder = st ? folderOfPath(st.path) : localFolder;
		const moved = nameKey(localFolder) !== nameKey(stFolder);
		return {
			kind: bothChanged ? 'merge' : 'push',
			category: moved ? 'move' : 'change',
			path: lf.info.path,
			id,
			describe: `${bothChanged ? 'merge and push' : 'push'} ${lf.info.path}${moved ? ` (moved from ${stFolder || '/'} to ${localFolder || '/'})` : ''}`,
			moveFrom: moved ? stFolder : undefined,
			moveTo: moved ? localFolder : undefined,
			run: async () => {
				await this.pushLocal(lf, note, id, baseVersion, remote, st);
			},
		};
	}

	private async pushLocal(lf: LocalFile, note: LocalNote, id: string, baseVersion: number, remote: NoteData | undefined, st: NoteState | undefined): Promise<void> {
		const content = this.remoteContentFor(lf, note);
		let tags = this.localTags(lf, note);
		let pinned = this.pinnedOf(lf.info.path, note);
		let systemTags = st?.systemTags ?? remote?.systemTags ?? ['markdown'];
		if (st && remote) {
			tags = mergeTags(st.tags, tags, remote.tags);
			const basePinned = st.systemTags.includes('pinned');
			const remotePinned = remote.systemTags.includes('pinned');
			if (pinned === basePinned && remotePinned !== basePinned) pinned = remotePinned;
			systemTags = remote.systemTags;
		}
		systemTags = setPinned(systemTags, pinned);
		const hash = await noteHash(content, tags.map(tagKey), pinned);
		const ccid = await computeCcid(id, baseVersion, hash);
		if (this.dryRun) {
			this.log.info(`[dry-run] push ${lf.info.path} (base v${baseVersion})`);
			return;
		}
		// The server does not dedupe ccids (NOTES.md): re-check the version right before pushing so an
		// identical edit that another device pushed meanwhile is adopted instead of applied twice.
		const current = await this.client.getNote(id);
		if (current && current.version !== baseVersion) {
			// a 0.4.4-style folder tag must still be rewritten although the hashes compare equal
			const sameFolderTags = tags.filter(isFolderTag).every((t) => current.data.tags.some((ct) => nameKey(ct) === nameKey(t)));
			if (sameFolderTags && (await this.hashRemote(current.data)) === hash) {
				this.log.info(`${lf.info.path}: identical content already on Simplenote (v${current.version}); not pushing`);
				this.state.notes[id] = {
					id,
					path: lf.info.path,
					version: current.version,
					contentHash: await this.hashLocal(lf, note),
					tags: current.data.tags,
					systemTags: current.data.systemTags,
					mtime: lf.info.mtime,
					size: lf.info.size,
					pinned: current.data.systemTags.includes('pinned'),
				};
				delete this.state.pendingDeletes[id];
				delete this.state.pendingEmpty[id];
				return;
			}
			if (st) {
				tags = mergeTags(st.tags, this.localTags(lf, note), current.data.tags);
				systemTags = setPinned(current.data.systemTags, pinned);
			}
			this.log.debug(`${lf.info.path}: Simplenote is at v${current.version}, pushing against v${baseVersion} (server merges)`);
		}
		const body: Partial<NoteData> = { content, tags, systemTags, deleted: false, modificationDate: this.now() / 1000 };
		let res = await this.client.postNote(id, body, { baseVersion, ccid });
		if (res.outcome === 'conflict') {
			this.log.warn(`${lf.info.path}: server refused base v${baseVersion} (current v${res.version}); merging locally`);
			const base = await this.client.getNote(id, baseVersion);
			const baseContent = base?.data.content ?? res.data.content;
			const merged = mergeStrings(baseContent, content, res.data.content);
			const mergedTags = mergeTags(base?.data.tags ?? res.data.tags, tags, res.data.tags);
			const mergedHash = await noteHash(merged, mergedTags.map(tagKey), pinned);
			res = await this.client.postNote(
				id,
				{ content: merged, tags: mergedTags, systemTags, deleted: false, modificationDate: this.now() / 1000 },
				{ baseVersion: res.version, ccid: await computeCcid(id, res.version, mergedHash) },
			);
			if (res.outcome === 'conflict') throw new Error('server refused the merged update; will retry');
		}
		this.log.info(`pushed ${lf.info.path} -> v${res.version}${res.outcome === 'unchanged' ? ' (no change on server)' : ''}`);
		const resultHash = await this.hashRemote(res.data);
		const localHash = await noteHash(content, tags.map(tagKey), pinned);
		if (resultHash !== localHash) {
			this.log.info(`${lf.info.path}: server returned a merged note; writing it back`);
			await this.writeLocal(lf.info.path, id, res.data, res.version, { taken: new Set(), folders: this.vault.listFolders() });
			return;
		}
		this.state.notes[id] = {
			id,
			path: lf.info.path,
			version: res.version,
			contentHash: await this.hashLocal(lf, note),
			tags: res.data.tags,
			systemTags: res.data.systemTags,
			mtime: lf.info.mtime,
			size: lf.info.size,
			pinned: res.data.systemTags.includes('pinned'),
		};
		delete this.state.pendingDeletes[id];
		delete this.state.pendingEmpty[id];
	}

	private createRemoteAction(lf: LocalFile, ctx: { taken: Set<string>; folders: string[] }): Action {
		return {
			kind: 'create-remote',
			category: 'change',
			path: lf.info.path,
			id: '',
			describe: `create note on Simplenote for ${lf.info.path}`,
			run: async () => {
				// re-read: another device may have assigned an id meanwhile
				let text: string;
				try {
					text = await this.vault.read(lf.info.path);
				} catch (e) {
					this.log.warn(`cannot read ${lf.info.path} (${errorText(e)})`);
					return;
				}
				const note = fileToNote(text, basenameOfPath(lf.info.path));
				if (note.id) {
					this.log.info(`${lf.info.path} got id ${note.id} from another device; linking next sync`);
					delete this.state.pendingNew[lf.info.path];
					return;
				}
				if (this.dryRun) {
					this.log.info(`[dry-run] create note for ${lf.info.path}`);
					return;
				}
				const id = newNoteId();
				lf.info = await this.assignId(lf.info.path, text, note, { 'simplenote-id': id });
				await this.createRemote(lf, fileToNote(await this.vault.read(lf.info.path), basenameOfPath(lf.info.path)), id);
				delete this.state.pendingNew[lf.info.path];
				void ctx;
			},
		};
	}

	/** Writes plugin keys into a file. Files with invalid YAML get a new block in front (the old block stays as text). */
	private async assignId(path: string, text: string, note: LocalNote, values: Record<string, unknown>): Promise<FileInfo> {
		if (note.invalidFrontmatter) {
			return this.vault.write(path, joinFrontmatter(setKeys('', values), text));
		}
		return this.vault.processFrontmatter(path, (fm) => {
			for (const [k, v] of Object.entries(values)) fm[k] = v;
		});
	}

	private async createRemote(lf: LocalFile, note: LocalNote, id: string): Promise<void> {
		const content = this.remoteContentFor(lf, note);
		const tags = this.localTags(lf, note);
		const pinned = this.pinnedOf(lf.info.path, note);
		const systemTags = setPinned(['markdown'], pinned);
		const hash = await noteHash(content, tags.map(tagKey), pinned);
		const nowSec = this.now() / 1000;
		const res = await this.client.postNote(
			id,
			{ content, tags, systemTags, deleted: false, creationDate: nowSec, modificationDate: nowSec, shareURL: '', publishURL: '' },
			{ ccid: await computeCcid(id, 0, hash) },
		);
		this.log.info(`created note on Simplenote for ${lf.info.path} (v${res.version})`);
		this.markBacklinks(lf.info.path);
		this.state.notes[id] = {
			id,
			path: lf.info.path,
			version: res.version,
			contentHash: await this.hashLocal(lf, note),
			tags: res.data.tags,
			systemTags: res.data.systemTags,
			mtime: lf.info.mtime,
			size: lf.info.size,
			pinned,
		};
	}

	/** With link translation on, notes linking to a newly identified note change on the Simplenote side. */
	private markBacklinks(path: string): void {
		const t = this.deps.translator;
		if (!t || !this.settingsFn().translateLinks) return;
		const byPath = new Map<string, NoteState>();
		for (const n of Object.values(this.state.notes)) byPath.set(nameKey(n.path), n);
		const reason = `Links to "${basenameOfPath(path)}" updated (note got its id)`;
		let n = 0;
		for (const p of t.backlinks(path)) {
			const st = byPath.get(nameKey(p));
			if (st) {
				st.recheck = reason;
				n++;
			}
		}
		if (n > 0) this.log.info(`${n} note(s) link to ${path}; they will be re-pushed with translated links`);
	}

	private linkOrCreateAction(lf: LocalFile, note: LocalNote, id: string, ctx: { taken: Set<string>; folders: string[] }): Action {
		return {
			kind: 'create-remote',
			category: 'change',
			path: lf.info.path,
			id,
			describe: `link or create note ${id} for ${lf.info.path}`,
			run: async () => {
				if (this.dryRun) {
					this.log.info(`[dry-run] link or create note ${id} for ${lf.info.path}`);
					return;
				}
				const got = await this.client.getNote(id);
				if (!got) {
					await this.createRemote(lf, note, id);
					return;
				}
				if (got.data.deleted) {
					if (this.state.trashedByMe[id]) {
						this.log.warn(`${lf.info.path} is back after it had vanished; restoring its note on Simplenote`);
						await this.pushLocal(lf, note, id, got.version, got.data, undefined);
						delete this.state.trashedByMe[id];
						return;
					}
					if ((await this.hashLocal(lf, note)) === (await this.renderedHash(lf.info.path, id, got.data))) {
						// a stale copy of a deleted file (vault sync brought it back, or another device kept it)
						await this.vault.trash(lf.info.path);
						this.log.info(`trashed ${lf.info.path} (unchanged copy of note ${id}, which is in the Simplenote trash)`);
						this.deps.notice(`Simplenote: "${lf.info.path}" moved to the Obsidian trash because its note is in the Simplenote trash.`);
						return;
					}
					this.log.warn(`${lf.info.path} points to a trashed note ${id} but holds other text; pushing the file restores the note`);
					await this.pushLocal(lf, note, id, got.version, got.data, undefined);
					return;
				}
				const localHash = await this.hashLocal(lf, note);
				if (localHash === (await this.hashRemote(got.data))) {
					this.state.notes[id] = { id, path: lf.info.path, version: got.version, contentHash: localHash, tags: got.data.tags, systemTags: got.data.systemTags, mtime: lf.info.mtime, size: lf.info.size, pinned: got.data.systemTags.includes('pinned') };
					return;
				}
				if (lf.info.mtime > got.data.modificationDate * 1000) await this.pushLocal(lf, note, id, got.version, got.data, undefined);
				else await this.writeLocal(lf.info.path, id, got.data, got.version, ctx);
			},
		};
	}

	// ---------------- backup ----------------

	private async backup(entries: IndexEntry[] | null): Promise<void> {
		if (this.dryRun) {
			this.log.info('[dry-run] would write a backup of all notes before the first push');
			return;
		}
		const all = entries ?? (await this.client.fetchIndex()).entries;
		const d = new Date(this.now());
		const pad = (n: number): string => String(n).padStart(2, '0');
		const name = `backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
		const payload = all.map((e) => ({ id: e.id, v: e.v, ...(e.d ?? {}) }));
		await this.vault.writePluginFile(name, JSON.stringify(payload, null, 1));
		this.log.info(`wrote ${name} (${payload.length} notes) before the first push`);
		this.state.backupDone = true;
		this.store.save(this.state);
	}
}

// ---------------- helpers ----------------

function isRemoteWrite(kind: ActionKind): boolean {
	return kind === 'push' || kind === 'merge' || kind === 'create-remote' || kind === 'trash-remote';
}

export function summarize(actions: Action[]): PlanSummary {
	const s: PlanSummary = { trash: 0, move: 0, change: 0, causes: [], items: [] };
	const moves = new Map<string, number>();
	let remoteChanges = 0;
	let localChanges = 0;
	let localTrash = 0;
	let remoteTrash = 0;
	let creates = 0;
	const groups = new Map<string, number>();
	for (const a of actions) {
		if (a.category === 'none') continue;
		s.items.push(a.describe);
		if (a.group) {
			const seen = groups.get(a.group) ?? 0;
			groups.set(a.group, seen + 1);
			if (seen === 0) s.change++;
			continue;
		}
		if (a.category === 'trash') s.trash++;
		else if (a.category === 'move') {
			s.move++;
			const k = `${a.moveFrom ?? ''}\u0000${a.moveTo ?? ''}`;
			moves.set(k, (moves.get(k) ?? 0) + 1);
		} else s.change++;
		if (a.kind === 'create-local' || a.kind === 'update-local') remoteChanges++;
		if (a.kind === 'push' || a.kind === 'merge') localChanges++;
		if (a.kind === 'create-remote') creates++;
		if (a.kind === 'trash-local') localTrash++;
		if (a.kind === 'trash-remote') remoteTrash++;
	}
	if (remoteChanges) s.causes.push(`${remoteChanges} note(s) changed on Simplenote`);
	if (localChanges) s.causes.push(`${localChanges} note(s) changed in the vault`);
	if (creates) s.causes.push(`${creates} new file(s) to upload`);
	if (localTrash) s.causes.push(`${localTrash} file(s) to trash locally (trashed or deleted on Simplenote)`);
	if (remoteTrash) s.causes.push(`${remoteTrash} file(s) deleted in the vault: their notes will be trashed on Simplenote`);
	for (const [g, n] of groups) s.causes.push(`${g}: ${n} note(s), counted as one change`);
	for (const [k, n] of moves) {
		const [from, to] = k.split('\u0000');
		s.causes.push(`Folder "${from || '/'}" -> "${to || '/'}": ${n} note(s) will be moved or retagged`);
	}
	return s;
}

/** Simplenote dates (Unix seconds) as file times (ms); undefined when the note has none. */
export function noteTimes(data: NoteData): { ctime?: number; mtime?: number } {
	const ms = (s: number): number | undefined => (Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : undefined);
	return { ctime: ms(data.creationDate), mtime: ms(data.modificationDate) };
}

export function remedyFor(p: SyncProblem): string {
	if (p.kind === 'too-large') return 'Shorten the note or split it into several notes; it syncs again as soon as it is small enough. (Or move it to an excluded folder to keep it local only.)';
	return 'Open the sync log for details. It is retried as soon as the file changes or after the next full reconcile.';
}

export function overThreshold(s: PlanSummary): boolean {
	return s.trash > GUARD_LIMITS.trash || s.move > GUARD_LIMITS.move || s.change > GUARD_LIMITS.change;
}

export function errorText(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

function unionTags(a: string[], b: string[]): string[] {
	const out = [...a];
	const seen = new Set(a.map(nameKey));
	for (const t of b) {
		if (!seen.has(nameKey(t))) {
			out.push(t);
			seen.add(nameKey(t));
		}
	}
	return out;
}

/** Three-way tag merge: apply remote additions and removals (since base) onto the local tags. The local folder tag always wins. */
export function mergeTags(base: string[], local: string[], remote: string[]): string[] {
	const bk = new Set(base.map(nameKey));
	const rk = new Set(remote.map(nameKey));
	const lk = new Set(local.map(nameKey));
	const removedByRemote = new Set(base.filter((t) => !rk.has(nameKey(t))).map(nameKey));
	const addedByRemote = remote.filter((t) => !bk.has(nameKey(t)));
	const localHasFolder = local.some(isFolderTag);
	const out = local.filter((t) => isFolderTag(t) || !removedByRemote.has(nameKey(t)));
	for (const t of addedByRemote) {
		if (isFolderTag(t) && localHasFolder) continue;
		if (!lk.has(nameKey(t))) out.push(t);
	}
	return out;
}

function setPinned(systemTags: string[], pinned: boolean): string[] {
	const without = systemTags.filter((t) => t !== 'pinned');
	return pinned ? [...without, 'pinned'] : without;
}
