/**
 * Sync engine: pull, first-run linking, push, deletions, guards.
 * Runs against VaultAdapter + SimperiumClient so it can be tested without Obsidian.
 */
import { joinFrontmatter, setKeys } from './frontmatter';
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
	isFolderTag,
	joinPath,
	nameKey,
	noteToFileText,
	splitContent,
	splitTags,
	titleToFileName,
	uniqueBasename,
	type ExclusionReason,
	type LocalNote,
} from './mapping';
import { matchFirstRun, removeTitleLine, type FirstRunDecision, type FirstRunProposal, type LocalCandidate, type RemoteCandidate } from './firstrun';
import { AuthError, SimperiumClient, SimperiumError, type IndexEntry, type NoteData } from './simperium';
import type { NoteState, StateStore, SyncState } from './state';
import type { FileInfo, VaultAdapter } from './vault';

export const NEW_FILE_WAIT_MS = 2 * 60 * 1000;
export const SUSPICIOUS_WAIT_MS = 60 * 1000;
export const FULL_RECONCILE_MS = 24 * 60 * 60 * 1000;
export const GUARD_LIMITS = { trash: 10, move: 20, change: 50 };

export interface EngineSettings {
	excludedFolders: string[];
	maxNoteSizeKb: number;
	dryRun: boolean;
	translateLinks: boolean;
}

export interface PlanSummary {
	trash: number;
	move: number;
	change: number;
	causes: string[];
	items: string[];
}

export type SyncStatus = { kind: 'idle'; at: number } | { kind: 'syncing' } | { kind: 'paused'; reason: string } | { kind: 'error'; message: string };

export interface SyncResult {
	ok: boolean;
	skipped?: 'paused' | 'guard-declined' | 'first-run-cancelled' | 'no-token' | 'already-running';
	pulled: number;
	pushed: number;
	trashed: number;
	errors: string[];
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
	firstRun: (proposal: FirstRunProposal, excludedPaths: string[]) => Promise<FirstRunDecision | null>;
	notice: (msg: string) => void;
	onStatus?: (status: SyncStatus) => void;
	translator?: LinkTranslator;
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
	/** Paths of files the current plan will create, so link translation can resolve them during the batch. */
	private planned = new Map<string, string>();
	paused = false;
	pauseReason = '';
	status: SyncStatus = { kind: 'idle', at: 0 };

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

	pause(reason = 'paused by user'): void {
		this.paused = true;
		this.pauseReason = reason;
		this.setStatus({ kind: 'paused', reason });
	}

	resume(): void {
		this.paused = false;
		this.setStatus({ kind: 'idle', at: this.store.load().lastSync });
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
		result.dryRun = this.dryRun;
		this.state = this.store.load();
		const now = this.now();
		this.log.info(`sync start${opts.reason ? ` (${opts.reason})` : ''}${this.dryRun ? ' [dry-run]' : ''}`);
		try {
			let full = opts.full === true || this.state.cursor.length === 0 || now - this.state.lastFullReconcile > FULL_RECONCILE_MS;
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
			let scan = await this.scanLocal(settings);
			let preConfirmed = false;
			if (!this.state.firstRunDone) {
				if (!full) {
					fetched = await this.client.fetchIndex();
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
			const actions = await this.plan(fetched.entries, scan, full, now);
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
			const remoteWrites = actions.some((a) => a.kind === 'push' || a.kind === 'merge' || a.kind === 'create-remote' || a.kind === 'trash-remote');
			if (remoteWrites && !this.state.backupDone) await this.backup(full ? fetched.entries : null);
			let pullFailed = false;
			let n = 0;
			for (const a of actions) {
				try {
					await a.run();
					if (a.kind === 'create-local' || a.kind === 'update-local') result.pulled++;
					else if (a.kind === 'push' || a.kind === 'merge' || a.kind === 'create-remote') result.pushed++;
					else if (a.kind === 'trash-local' || a.kind === 'trash-remote') result.trashed++;
				} catch (e) {
					if (e instanceof AuthError) throw e;
					const msg = `${a.kind} ${a.path}: ${errorText(e)}`;
					this.log.error(msg);
					result.errors.push(msg);
					if (a.kind === 'create-local' || a.kind === 'update-local' || a.kind === 'trash-local' || a.kind === 'adopt') pullFailed = true;
				}
				if (!this.dryRun && ++n % 10 === 0) this.store.save(this.state);
			}
			if (!this.dryRun) {
				if (!pullFailed) this.state.cursor = fetched.current;
				if (full && !pullFailed) this.state.lastFullReconcile = now;
				this.state.lastSync = now;
				this.store.save(this.state);
			}
			result.ok = result.errors.length === 0;
			this.log.info(`sync done: pulled ${result.pulled}, pushed ${result.pushed}, trashed ${result.trashed}${result.errors.length ? `, ${result.errors.length} error(s)` : ''}`);
			if (result.ok) this.setStatus({ kind: 'idle', at: now });
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

	// ---------------- scanning ----------------

	private async scanLocal(settings: EngineSettings): Promise<Scan> {
		const byPath = new Map<string, NoteState>();
		for (const n of Object.values(this.state.notes)) byPath.set(nameKey(n.path), n);
		const files: LocalFile[] = [];
		const excluded: LocalFile[] = [];
		const pathKeys = new Set<string>();
		const idFiles = new Map<string, LocalFile[]>();
		const paused = new Set(this.state.pausedPaths.map(nameKey));
		for (const info of this.vault.listMarkdownFiles()) {
			pathKeys.add(nameKey(info.path));
			const reason = exclusionReason(info.path, info.size, settings);
			const lf: LocalFile = { info, id: null, changed: true, excluded: reason };
			if (reason) {
				excluded.push(lf);
				if (reason === 'too-large') this.log.warn(`skipping ${info.path}: larger than ${settings.maxNoteSizeKb} KB`);
				continue;
			}
			if (paused.has(nameKey(info.path))) continue;
			const st = byPath.get(nameKey(info.path));
			if (st && st.mtime === info.mtime && st.size === info.size && !st.recheck) {
				lf.id = st.id;
				lf.changed = false;
			} else {
				const ok = await this.loadLocal(lf);
				if (!ok) continue;
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
		const noId = files.filter((f) => f.id === null);
		return { files: files.filter((f) => f.id === null || byId.get(f.id) === f), byId, noId, excluded, pathKeys, folders: this.vault.listFolders() };
	}

	private pickKeeper(id: string, list: LocalFile[]): LocalFile {
		const st = this.state.notes[id];
		if (st) {
			const match = list.find((f) => nameKey(f.info.path) === nameKey(st.path));
			if (match) return match;
		}
		const conflictRe = /\((conflict|conflicted copy|sync conflict)[^)]*\)|\b\d{4}-\d{2}-\d{2}\b| \d+\.md$/i;
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
		lf.note = fileToNote(lf.text, basenameOfPath(lf.info.path));
		if (lf.note.invalidFrontmatter) this.log.warn(`${lf.info.path}: frontmatter is not valid YAML; treating it as text`);
		return true;
	}

	// ---------------- hashing helpers ----------------

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
		return noteHash(this.remoteContentFor(lf, note), this.localTags(lf, note).map(nameKey), note.pinned);
	}

	private async hashRemote(data: NoteData): Promise<string> {
		return noteHash(data.content, data.tags.map(nameKey), data.systemTags.includes('pinned'));
	}

	/** Hash of a file as written, used as the state hash so unchanged files compare equal. */
	private async hashText(path: string, text: string): Promise<string> {
		const note = fileToNote(text, basenameOfPath(path));
		const lf: LocalFile = { info: { path, mtime: 0, size: 0 }, id: note.id, changed: false, excluded: null };
		return this.hashLocal(lf, note);
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
			scan.excluded.map((f) => f.info.path),
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
			const pinned = m.remote.data.systemTags.includes('pinned') || localNote.pinned;
			const values: Record<string, unknown> = { 'simplenote-id': m.remote.id };
			if (tags.length > 0) values.tags = tags;
			if (pinned) values.pinned = true;
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
		const folders = [...scan.folders];
		const ctx = { taken, folders };

		for (const entry of entries) {
			remoteIds.add(entry.id);
			const id = entry.id;
			const st = this.state.notes[id];
			const lf = scan.byId.get(id);
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
				if (lf) actions.push(this.trashLocalAction(lf, id, 'trashed on Simplenote'));
				else {
					delete this.state.notes[id];
					delete this.state.pendingDeletes[id];
				}
				handled.add(id);
				continue;
			}
			if (!lf) {
				if (st && version === st.version) continue; // local file gone, remote unchanged: deletion flow decides
				if (st) {
					this.log.info(`${st.path} is missing locally but changed on Simplenote; recreating it`);
					delete this.state.pendingDeletes[id];
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
			const note = lf.note as LocalNote;
			const localHash = await this.hashLocal(lf, note);
			const remoteHash = await this.hashRemote(data);
			handled.add(id);
			if (localHash === remoteHash) {
				actions.push(this.adoptAction(lf, id, data, version, localHash));
			} else if (!st) {
				// linked by id only (e.g. first sync on a new device): newer side wins
				if (lf.info.mtime > data.modificationDate * 1000) actions.push(this.pushAction(lf, note, id, version, data, undefined));
				else actions.push(this.updateLocalAction(lf, id, data, version, ctx));
			} else if (localHash === st.contentHash) {
				actions.push(this.updateLocalAction(lf, id, data, version, ctx));
			} else if (st.version === version) {
				actions.push(this.pushAction(lf, note, id, st.version, data, st));
			} else {
				actions.push(this.pushAction(lf, note, id, st.version, data, st, true));
			}
		}

		// local side
		for (const lf of scan.files) {
			if (lf.id && handled.has(lf.id)) continue;
			if (lf.id) {
				const st = this.state.notes[lf.id];
				if (st) {
					if (!lf.changed && nameKey(st.path) === nameKey(lf.info.path)) continue;
					if (!(await this.loadLocal(lf))) continue;
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
			if (scan.excluded.some((f) => nameKey(f.info.path) === nameKey(st.path))) continue; // now excluded: leave the note alone
			const pd = this.state.pendingDeletes[st.id];
			if (!pd) {
				this.state.pendingDeletes[st.id] = { path: st.path, since: now };
				this.log.warn(`${st.path} vanished; waiting ${SUSPICIOUS_WAIT_MS / 1000} s before trashing the note`);
				continue;
			}
			if (now - pd.since < SUSPICIOUS_WAIT_MS) continue;
			if (this.vault.exists(st.path)) {
				delete this.state.pendingDeletes[st.id];
				continue;
			}
			actions.push(this.trashRemoteAction(st));
		}
		return actions;
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
		this.state.notes[id] = {
			id,
			path,
			version,
			contentHash: await this.hashText(path, text),
			tags: data.tags,
			systemTags: data.systemTags,
			mtime: info?.mtime ?? 0,
			size: info?.size ?? -1,
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
				const text = noteToFileText({ ...data, content }, id, basenameOfPath(path)).text;
				if (this.dryRun) {
					this.log.info(`[dry-run] create ${path}`);
					return;
				}
				if (folder && !this.vault.exists(folder)) {
					await this.vault.createFolder(folder);
					ctx.folders.push(folder);
				}
				const info = await this.vault.create(path, text);
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
		const text = noteToFileText({ ...data, content }, id, basenameOfPath(newPath)).text;
		if (this.dryRun) {
			this.log.info(`[dry-run] update ${path}${newPath !== path ? ` and rename to ${newPath}` : ''}`);
			return;
		}
		let info = await this.vault.write(path, text);
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
				this.state.notes[id] = { id, path: lf.info.path, version, contentHash: hash, tags: data.tags, systemTags: data.systemTags, mtime: lf.info.mtime, size: lf.info.size };
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

	private trashRemoteAction(st: NoteState): Action {
		return {
			kind: 'trash-remote',
			category: 'trash',
			path: st.path,
			id: st.id,
			describe: `trash note on Simplenote: ${st.path} (file deleted in the vault)`,
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
		let pinned = note.pinned;
		let systemTags = st?.systemTags ?? remote?.systemTags ?? ['markdown'];
		if (st && remote) {
			tags = mergeTags(st.tags, tags, remote.tags);
			const basePinned = st.systemTags.includes('pinned');
			const remotePinned = remote.systemTags.includes('pinned');
			if (pinned === basePinned && remotePinned !== basePinned) pinned = remotePinned;
			systemTags = remote.systemTags;
		}
		systemTags = setPinned(systemTags, pinned);
		const hash = await noteHash(content, tags.map(nameKey), pinned);
		const ccid = await computeCcid(id, baseVersion, hash);
		if (this.dryRun) {
			this.log.info(`[dry-run] push ${lf.info.path} (base v${baseVersion})`);
			return;
		}
		const body: Partial<NoteData> = { content, tags, systemTags, deleted: false, modificationDate: this.now() / 1000 };
		let res = await this.client.postNote(id, body, { baseVersion, ccid });
		if (res.outcome === 'conflict') {
			this.log.warn(`${lf.info.path}: server refused base v${baseVersion} (current v${res.version}); merging locally`);
			const base = await this.client.getNote(id, baseVersion);
			const baseContent = base?.data.content ?? res.data.content;
			const merged = mergeStrings(baseContent, content, res.data.content);
			const mergedTags = mergeTags(base?.data.tags ?? res.data.tags, tags, res.data.tags);
			const mergedHash = await noteHash(merged, mergedTags.map(nameKey), pinned);
			res = await this.client.postNote(
				id,
				{ content: merged, tags: mergedTags, systemTags, deleted: false, modificationDate: this.now() / 1000 },
				{ baseVersion: res.version, ccid: await computeCcid(id, res.version, mergedHash) },
			);
			if (res.outcome === 'conflict') throw new Error('server refused the merged update; will retry');
		}
		this.log.info(`pushed ${lf.info.path} -> v${res.version}${res.outcome === 'unchanged' ? ' (no change on server)' : ''}`);
		const resultHash = await this.hashRemote(res.data);
		const localHash = await noteHash(content, tags.map(nameKey), pinned);
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
		const systemTags = setPinned(['markdown'], note.pinned);
		const hash = await noteHash(content, tags.map(nameKey), note.pinned);
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
					this.log.warn(`${lf.info.path} points to a trashed note ${id}; pushing the file restores it`);
				}
				const localHash = await this.hashLocal(lf, note);
				if (localHash === (await this.hashRemote(got.data))) {
					this.state.notes[id] = { id, path: lf.info.path, version: got.version, contentHash: localHash, tags: got.data.tags, systemTags: got.data.systemTags, mtime: lf.info.mtime, size: lf.info.size };
					return;
				}
				if (lf.info.mtime > got.data.modificationDate * 1000 || got.data.deleted) await this.pushLocal(lf, note, id, got.version, got.data, undefined);
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
