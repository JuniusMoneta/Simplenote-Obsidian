import type { HttpFn, HttpRequest, HttpResponse, NoteData } from '../src/simperium';
import { mergeStrings } from '../src/merge';

interface StoredNote {
	version: number;
	cv: number;
	data: NoteData | null; // null = permanently deleted
	history: Map<number, NoteData>;
	ccids: Set<string>;
}

export interface FakeOptions {
	appId?: string;
	apiKey?: string;
	/** What to do with a POST against a stale version: merge like the real server, or refuse with this status. */
	staleVersion?: 'merge' | 405 | 409;
	/** Status for a duplicate ccid: 409 (protocol doc) or 200 (silently drop). */
	duplicateCcidStatus?: 200 | 409;
	maxContentBytes?: number;
	/** Case-fold tags like Simplenote (keeps the first spelling). */
	caseInsensitiveTags?: boolean;
}

/** In-memory Simperium: versions, since cursors, mark pagination, ccid dedupe, merge on stale base. */
export class FakeSimperium {
	readonly notes = new Map<string, StoredNote>();
	readonly users = new Map<string, string>();
	readonly tokens = new Map<string, string>();
	readonly requests: HttpRequest[] = [];
	cv = 0;
	failNext: { status: number; count: number } | null = null;
	readonly opts: Required<FakeOptions>;

	constructor(opts: FakeOptions = {}) {
		this.opts = {
			appId: opts.appId ?? 'chalk-bump-f49',
			apiKey: opts.apiKey ?? 'c8c2b86337154cdabc989b23e30c6bf4',
			staleVersion: opts.staleVersion ?? 'merge',
			duplicateCcidStatus: opts.duplicateCcidStatus ?? 409,
			maxContentBytes: opts.maxContentBytes ?? 1_000_000,
			caseInsensitiveTags: opts.caseInsensitiveTags ?? true,
		};
	}

	addUser(username: string, password: string): void {
		this.users.set(username, password);
	}

	readonly http: HttpFn = (req) => Promise.resolve(this.handle(req));

	/** Test helper: seed a note directly. Returns the version. */
	seed(id: string, data: Partial<NoteData>): number {
		const full: NoteData = {
			content: '',
			tags: [],
			deleted: false,
			systemTags: ['markdown'],
			creationDate: 1_700_000_000,
			modificationDate: 1_700_000_000,
			shareURL: '',
			publishURL: '',
			...data,
		};
		const existing = this.notes.get(id);
		const version = (existing?.version ?? 0) + 1;
		const history = existing?.history ?? new Map<number, NoteData>();
		history.set(version, full);
		this.notes.set(id, { version, cv: ++this.cv, data: full, history, ccids: existing?.ccids ?? new Set() });
		return version;
	}

	get(id: string): NoteData | undefined {
		return this.notes.get(id)?.data ?? undefined;
	}

	version(id: string): number {
		return this.notes.get(id)?.version ?? 0;
	}

	/** Permanently delete (only for tests of "missing on server"). */
	purge(id: string): void {
		const n = this.notes.get(id);
		if (n) {
			n.data = null;
			n.cv = ++this.cv;
		}
	}

	private handle(req: HttpRequest): HttpResponse {
		this.requests.push(req);
		if (this.failNext && this.failNext.count > 0) {
			this.failNext.count--;
			return { status: this.failNext.status, headers: {}, text: 'injected failure' };
		}
		const u = new URL(req.url);
		if (u.hostname === 'auth.simperium.com') return this.handleAuth(req, u);
		if (u.hostname !== 'api.simperium.com') return { status: 404, headers: {}, text: 'unknown host' };
		const parts = u.pathname.split('/').filter((p) => p.length > 0); // ['1', app, bucket, ...]
		if (parts[0] !== '1' || parts[1] !== this.opts.appId || parts[2] !== 'note') {
			return { status: 404, headers: {}, text: 'unknown bucket' };
		}
		const token = req.headers['X-Simperium-Token'] ?? req.headers['x-simperium-token'];
		if (!token || !this.tokens.has(token)) return { status: 401, headers: {}, text: 'unauthorized' };
		const rest = parts.slice(3);
		if (rest[0] === 'index' && req.method === 'GET') return this.handleIndex(u);
		if (rest[0] === 'i' && rest[1]) {
			const id = rest[1];
			const version = rest[2] === 'v' && rest[3] ? Number.parseInt(rest[3], 10) : undefined;
			if (req.method === 'GET') return this.handleGet(id, version);
			if (req.method === 'POST') return this.handlePost(id, version, u, req.body ?? '');
			if (req.method === 'DELETE') return this.handleDelete(id);
		}
		return { status: 404, headers: {}, text: 'not found' };
	}

	private handleAuth(req: HttpRequest, u: URL): HttpResponse {
		if (u.pathname !== `/1/${this.opts.appId}/authorize/` || req.method !== 'POST') return { status: 404, headers: {}, text: '' };
		const key = req.headers['X-Simperium-API-Key'] ?? req.headers['x-simperium-api-key'];
		if (key !== this.opts.apiKey) return { status: 401, headers: {}, text: 'bad api key' };
		let body: { username?: string; password?: string };
		try {
			body = JSON.parse(req.body ?? '') as { username?: string; password?: string };
		} catch {
			return { status: 400, headers: {}, text: 'bad json' };
		}
		if (!body.username || this.users.get(body.username) !== body.password) return { status: 401, headers: {}, text: 'invalid login' };
		const token = `tok-${body.username}-${this.tokens.size + 1}`;
		this.tokens.set(token, body.username);
		return { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ access_token: token, username: body.username, userid: 'u1' }) };
	}

	private handleIndex(u: URL): HttpResponse {
		const limit = Math.max(1, Math.min(1000, Number.parseInt(u.searchParams.get('limit') ?? '100', 10) || 100));
		const data = u.searchParams.get('data') === 'true' || u.searchParams.get('data') === '1';
		const since = u.searchParams.get('since');
		const mark = u.searchParams.get('mark');
		let list: { id: string; n: StoredNote }[] = [...this.notes.entries()].map(([id, n]) => ({ id, n }));
		if (since !== null) {
			const sinceCv = Number.parseInt(since, 10);
			if (!Number.isFinite(sinceCv) || sinceCv > this.cv) return { status: 400, headers: {}, text: 'unknown cursor' };
			list = list.filter((x) => x.n.cv > sinceCv).sort((a, b) => a.n.cv - b.n.cv);
		} else {
			list = list.filter((x) => x.n.data !== null).sort((a, b) => (a.id < b.id ? -1 : 1));
		}
		const offset = mark ? Number.parseInt(mark, 10) || 0 : 0;
		const page = list.slice(offset, offset + limit);
		const index = page.map((x) => {
			const e: { id: string; v: number; d?: NoteData } = { id: x.id, v: x.n.version };
			if (data && x.n.data) e.d = x.n.data;
			return e;
		});
		const out: { index: unknown[]; current: string; mark?: string } = { index, current: String(this.cv) };
		if (offset + limit < list.length) out.mark = String(offset + limit);
		return { status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify(out) };
	}

	private handleGet(id: string, version: number | undefined): HttpResponse {
		const n = this.notes.get(id);
		if (!n) return { status: 404, headers: {}, text: '' };
		if (version !== undefined) {
			const d = n.history.get(version);
			if (!d) return { status: 404, headers: {}, text: '' };
			return { status: 200, headers: { 'X-Simperium-Version': String(version) }, text: JSON.stringify(d) };
		}
		if (!n.data) return { status: 404, headers: {}, text: '' };
		return { status: 200, headers: { 'X-Simperium-Version': String(n.version) }, text: JSON.stringify(n.data) };
	}

	private handlePost(id: string, baseVersion: number | undefined, u: URL, body: string): HttpResponse {
		let patch: Partial<NoteData>;
		try {
			patch = JSON.parse(body) as Partial<NoteData>;
		} catch {
			return { status: 400, headers: {}, text: 'bad json' };
		}
		if (typeof patch.content === 'string' && new TextEncoder().encode(patch.content).length > this.opts.maxContentBytes) {
			return { status: 413, headers: {}, text: 'too large' };
		}
		const ccid = u.searchParams.get('ccid') ?? undefined;
		const replace = u.searchParams.get('replace') === '1';
		const respond = u.searchParams.get('response') === '1';
		const existing = this.notes.get(id);
		const current = existing?.data ?? null;
		if (existing && ccid && existing.ccids.has(ccid)) {
			if (this.opts.duplicateCcidStatus === 409) return { status: 409, headers: { 'X-Simperium-Version': String(existing.version) }, text: 'duplicate ccid' };
			return { status: 200, headers: { 'X-Simperium-Version': String(existing.version) }, text: respond && current ? JSON.stringify(current) : '' };
		}
		let next: NoteData;
		if (!current) {
			next = {
				content: '',
				tags: [],
				deleted: false,
				systemTags: [],
				creationDate: 0,
				modificationDate: 0,
				shareURL: '',
				publishURL: '',
				...patch,
			};
		} else if (replace) {
			next = { content: '', tags: [], deleted: false, systemTags: [], creationDate: 0, modificationDate: 0, shareURL: '', publishURL: '', ...patch };
		} else {
			next = { ...current, ...patch };
		}
		if (existing && current && baseVersion !== undefined && baseVersion !== existing.version) {
			if (baseVersion > existing.version) return { status: 404, headers: {}, text: 'no such version' };
			if (this.opts.staleVersion !== 'merge') {
				return { status: this.opts.staleVersion, headers: { 'X-Simperium-Version': String(existing.version) }, text: 'stale version' };
			}
			const base = existing.history.get(baseVersion);
			if (base && typeof patch.content === 'string') {
				next.content = mergeStrings(base.content, current.content, patch.content);
			}
		}
		if (this.opts.caseInsensitiveTags) {
			const seen = new Map<string, string>();
			for (const t of next.tags) {
				const k = t.normalize('NFC').toLocaleLowerCase('en-US');
				if (!seen.has(k)) seen.set(k, t);
			}
			next.tags = [...seen.values()];
		}
		if (existing && current && JSON.stringify(current) === JSON.stringify(next)) {
			if (ccid) existing.ccids.add(ccid);
			return { status: 412, headers: { 'X-Simperium-Version': String(existing.version) }, text: '' };
		}
		const version = (existing?.version ?? 0) + 1;
		const history = existing?.history ?? new Map<number, NoteData>();
		history.set(version, next);
		const ccids = existing?.ccids ?? new Set<string>();
		if (ccid) ccids.add(ccid);
		this.notes.set(id, { version, cv: ++this.cv, data: next, history, ccids });
		return { status: 200, headers: { 'X-Simperium-Version': String(version) }, text: respond ? JSON.stringify(next) : '' };
	}

	private handleDelete(id: string): HttpResponse {
		const n = this.notes.get(id);
		if (!n) return { status: 404, headers: {}, text: '' };
		n.data = null;
		n.cv = ++this.cv;
		return { status: 200, headers: { 'X-Simperium-Version': String(n.version) }, text: '' };
	}
}

/** Convenience: a fake with one user already logged in through the client. */
export function fakeWithUser(opts: FakeOptions = {}): { server: FakeSimperium; username: string; password: string } {
	const server = new FakeSimperium(opts);
	server.addUser('test@example.com', 'secret');
	return { server, username: 'test@example.com', password: 'secret' };
}
