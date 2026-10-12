/**
 * Push lease for vaults shared through a vault sync (iCloud, Obsidian Sync): only one device pushes at a time.
 *
 * The lease lives in one note of the Simplenote account, kept in the Simplenote trash so it stays out of the
 * note list. Each device owns one line of the note: `<deviceId> <priority> <until> <name>`. The holder is the
 * device whose line is still valid (until > now) with the lowest priority, ties broken by device id. A device
 * only ever rewrites its own line, so the server-side merge of two simultaneous writes keeps both lines and
 * every device derives the same holder from the merged text. No compare-and-swap is needed.
 *
 * - Nobody holds the lease: the first device to sync claims it with priority = now.
 * - The holder renews `until` whenever less than half the TTL is left.
 * - The holder stops syncing (app closed, phone in the background): the lease expires after TTL and the next
 *   device that syncs takes it over.
 * - "Take over" by the owner: priority below the current holder's, so the takeover wins even against a renewal
 *   that is in flight.
 */
import { AuthError, SimperiumError, type IndexEntry, type NoteData, type PostResult, type SimperiumClient } from './simperium';

/** Fixed id of the lease note (sha256("simplenote-sync push lease") prefix). */
export const LEASE_NOTE_ID = '9c5f0e3a1d7b4f2e8a6c0d9b3e1f5a7c';
export const LEASE_TTL_MS = 3 * 60 * 1000;
export const LEASE_TITLE = 'Obsidian sync lease (managed by the Simplenote Sync plugin; keep this note in the trash)';
/** Lines older than this are dropped when the note is rewritten. */
const STALE_LINE_MS = 24 * 60 * 60 * 1000;

export interface LeaseLine {
	device: string;
	priority: number;
	until: number;
	name: string;
}

export interface LeaseDecision {
	/** True when this device may push. */
	holder: boolean;
	/** Name of the device that holds the lease (this device included), null when nobody does. */
	holderName: string | null;
	holderDevice: string | null;
}

const LINE_RE = /^([a-z0-9]+) (\d+) (\d+) (.*)$/;

export function parseLease(content: string): LeaseLine[] {
	const lines: LeaseLine[] = [];
	for (const raw of content.split('\n').slice(1)) {
		const m = LINE_RE.exec(raw.trim());
		if (!m) continue;
		lines.push({ device: m[1] as string, priority: Number(m[2]), until: Number(m[3]), name: (m[4] as string).trim() });
	}
	return lines;
}

export function renderLease(lines: LeaseLine[]): string {
	const body = lines.map((l) => `${l.device} ${l.priority} ${l.until} ${l.name.replace(/[\r\n]+/g, ' ')}`);
	return [LEASE_TITLE, ...body].join('\n');
}

export function holderOf(lines: LeaseLine[], now: number): LeaseLine | null {
	const valid = lines.filter((l) => l.until > now);
	if (valid.length === 0) return null;
	valid.sort((a, b) => a.priority - b.priority || (a.device < b.device ? -1 : a.device > b.device ? 1 : 0));
	return valid[0] as LeaseLine;
}

export interface LeaseDeps {
	client: SimperiumClient;
	deviceId: string;
	deviceName: string;
	now: () => number;
	log: (msg: string) => void;
}

export class PushLease {
	private cached: { version: number; lines: LeaseLine[] } | null = null;
	private forceNext = false;

	constructor(private readonly deps: LeaseDeps) {}

	/** Feeds an index entry for the lease note (other devices' writes arrive through the index). */
	observe(entry: IndexEntry): void {
		if (entry.id !== LEASE_NOTE_ID || !entry.d) return;
		if (this.cached && this.cached.version > entry.v) return;
		this.cached = { version: entry.v, lines: parseLease(entry.d.content) };
	}

	/** The next decision takes the lease over even if another device holds it. */
	requestTakeover(): void {
		this.forceNext = true;
	}

	/** Current view without network access (for status displays). */
	peek(now: number): LeaseDecision {
		const h = this.cached ? holderOf(this.cached.lines, now) : null;
		return { holder: h?.device === this.deps.deviceId, holderName: h?.name ?? null, holderDevice: h?.device ?? null };
	}

	/** Decides whether this device may push now, renewing, claiming, or taking over the lease as needed. */
	async decide(now: number): Promise<LeaseDecision> {
		if (!this.cached) await this.refresh();
		const cached = this.cached as { version: number; lines: LeaseLine[] };
		const force = this.forceNext;
		this.forceNext = false;
		const current = holderOf(cached.lines, now);
		const me = this.deps.deviceId;
		if (force) {
			const valid = cached.lines.filter((l) => l.until > now && l.device !== me);
			const priority = valid.length > 0 ? Math.min(...valid.map((l) => l.priority)) - 1 : now;
			this.deps.log(`push lease: taking over${current && current.device !== me ? ` from ${current.name}` : ''}`);
			return this.write({ device: me, priority, until: now + LEASE_TTL_MS, name: this.deps.deviceName }, now);
		}
		if (current && current.device === me) {
			if (current.until - now < LEASE_TTL_MS / 2) return this.write({ ...current, until: now + LEASE_TTL_MS, name: this.deps.deviceName }, now);
			return this.decision(current);
		}
		if (current) return this.decision(current);
		this.deps.log(`push lease: free; claiming it for ${this.deps.deviceName}`);
		return this.write({ device: me, priority: now, until: now + LEASE_TTL_MS, name: this.deps.deviceName }, now);
	}

	private decision(h: LeaseLine | null): LeaseDecision {
		return { holder: h?.device === this.deps.deviceId, holderName: h?.name ?? null, holderDevice: h?.device ?? null };
	}

	private async refresh(): Promise<void> {
		const got = await this.deps.client.getNote(LEASE_NOTE_ID);
		this.cached = got ? { version: got.version, lines: parseLease(got.data.content) } : { version: 0, lines: [] };
	}

	private async write(mine: LeaseLine, now: number): Promise<LeaseDecision> {
		const cached = this.cached as { version: number; lines: LeaseLine[] };
		const keep = cached.lines.filter((l) => l.device !== mine.device && now - l.until < STALE_LINE_MS);
		const lines = [...keep, mine];
		const content = renderLease(lines);
		const sec = now / 1000;
		let res: PostResult;
		try {
			if (cached.version === 0) {
				const data: NoteData = { content, tags: [], deleted: true, systemTags: ['markdown'], creationDate: sec, modificationDate: sec, shareURL: '', publishURL: '' };
				res = await this.deps.client.postNote(LEASE_NOTE_ID, data);
			} else {
				res = await this.deps.client.postNote(LEASE_NOTE_ID, { content, deleted: true, modificationDate: sec }, { baseVersion: cached.version });
			}
		} catch (e) {
			if (e instanceof AuthError || !(e instanceof SimperiumError)) throw e;
			// the note is gone (trash emptied) or the server refused the base: re-read and decide again next sync
			this.deps.log(`push lease: write failed (${e.message}); re-reading`);
			await this.refresh();
			return this.decision(holderOf((this.cached as { lines: LeaseLine[] }).lines, now));
		}
		if (res.outcome === 'conflict') {
			// another device wrote meanwhile: take its view, decide again next sync
			this.cached = { version: res.version, lines: parseLease(res.data.content) };
			return this.decision(holderOf(this.cached.lines, now));
		}
		this.cached = { version: res.version, lines: parseLease(res.data.content) };
		const h = holderOf(this.cached.lines, now);
		if (h && h.device !== mine.device) this.deps.log(`push lease: held by ${h.name}; this device pulls only`);
		return this.decision(h);
	}
}
