/**
 * Minimal Simperium HTTP client for the Simplenote `note` bucket.
 * All HTTP goes through an injected HttpFn (requestUrl in the plugin, a fake in tests).
 */

export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST' | 'DELETE';
	headers: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export interface NoteData {
	content: string;
	tags: string[];
	deleted: boolean;
	systemTags: string[];
	creationDate: number;
	modificationDate: number;
	shareURL?: string;
	publishURL?: string;
}

export interface IndexEntry {
	id: string;
	v: number;
	d?: NoteData;
}

export interface IndexPage {
	index: IndexEntry[];
	current: string;
	mark?: string;
}

export interface VersionedNote {
	data: NoteData;
	version: number;
}

export type PostOutcome = 'updated' | 'unchanged' | 'conflict';

export interface PostResult extends VersionedNote {
	outcome: PostOutcome;
}

export class SimperiumError extends Error {
	constructor(
		message: string,
		public status: number,
		public body = '',
	) {
		super(message);
		this.name = 'SimperiumError';
	}
}

export class AuthError extends SimperiumError {
	constructor(message = 'Not authorized') {
		super(message, 401);
		this.name = 'AuthError';
	}
}

export interface ClientOptions {
	appId: string;
	apiKey: string;
	http: HttpFn;
	token?: string;
	bucket?: string;
	/** Minimum time between request starts (upload throttle). Default 500 ms = 2 req/s. */
	minIntervalMs?: number;
	maxRetries?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	log?: (msg: string) => void;
	authHost?: string;
	apiHost?: string;
	/** Host of the Simplenote account service (email-code login). */
	accountHost?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function normalizeNoteData(raw: Partial<NoteData> | undefined): NoteData {
	return {
		content: typeof raw?.content === 'string' ? raw.content : '',
		tags: Array.isArray(raw?.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
		deleted: raw?.deleted === true,
		systemTags: Array.isArray(raw?.systemTags) ? raw.systemTags.filter((t): t is string => typeof t === 'string') : [],
		creationDate: typeof raw?.creationDate === 'number' ? raw.creationDate : 0,
		modificationDate: typeof raw?.modificationDate === 'number' ? raw.modificationDate : 0,
		shareURL: typeof raw?.shareURL === 'string' ? raw.shareURL : '',
		publishURL: typeof raw?.publishURL === 'string' ? raw.publishURL : '',
	};
}

export class SimperiumClient {
	private token: string | undefined;
	private readonly http: HttpFn;
	private readonly appId: string;
	private readonly apiKey: string;
	private readonly bucket: string;
	private readonly minIntervalMs: number;
	private readonly maxRetries: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => number;
	private readonly log: (msg: string) => void;
	private readonly authHost: string;
	private readonly apiHost: string;
	private readonly accountHost: string;
	private nextSlot = 0;
	/** Count of HTTP requests sent (for tests and logging). */
	requestCount = 0;

	constructor(opts: ClientOptions) {
		this.http = opts.http;
		this.appId = opts.appId;
		this.apiKey = opts.apiKey;
		this.token = opts.token;
		this.bucket = opts.bucket ?? 'note';
		this.minIntervalMs = opts.minIntervalMs ?? 500;
		this.maxRetries = opts.maxRetries ?? 5;
		this.sleep = opts.sleep ?? defaultSleep;
		this.now = opts.now ?? (() => Date.now());
		this.log = opts.log ?? (() => undefined);
		this.authHost = opts.authHost ?? 'https://auth.simperium.com';
		this.apiHost = opts.apiHost ?? 'https://api.simperium.com';
		this.accountHost = opts.accountHost ?? 'https://app.simplenote.com';
	}

	/**
	 * Email-code login, step 1 (the flow the Simplenote web app uses): asks the account service
	 * to email a login code. No API key needed; talks to app.simplenote.com only.
	 */
	async requestLoginCode(email: string): Promise<void> {
		const username = email.trim().toLowerCase();
		const res = await this.send(
			{
				url: `${this.accountHost}/account/request-login`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username, request_source: 'electron' }),
			},
			[200, 201, 202, 204],
		).catch((e: unknown) => {
			if (e instanceof SimperiumError) throw new AuthError(`Could not request a login code (HTTP ${e.status}). Check the email address.`);
			throw e;
		});
		void res;
	}

	/** Email-code login, step 2: exchanges the emailed code for a Simperium token and stores it on the client. */
	async completeLoginCode(email: string, code: string): Promise<string> {
		const username = email.trim().toLowerCase();
		const res = await this.send(
			{
				url: `${this.accountHost}/account/complete-login`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ username, auth_code: code.trim().toUpperCase() }),
			},
			[200],
		).catch((e: unknown) => {
			if (e instanceof SimperiumError) throw new AuthError(`Login code rejected (HTTP ${e.status}). Request a new code and try again.`);
			throw e;
		});
		const parsed = JSON.parse(res.text) as { sync_token?: string };
		if (!parsed.sync_token) throw new AuthError('Login failed: no token in the response.');
		this.token = parsed.sync_token;
		return this.token;
	}

	setToken(token: string | undefined): void {
		this.token = token;
	}

	hasToken(): boolean {
		return !!this.token;
	}

	private get dataUrl(): string {
		return `${this.apiHost}/1/${this.appId}/${this.bucket}`;
	}

	private async throttle(): Promise<void> {
		const now = this.now();
		const slot = Math.max(now, this.nextSlot);
		this.nextSlot = slot + this.minIntervalMs;
		if (slot > now) await this.sleep(slot - now);
	}

	/** Sends one request with throttle, retry on 429/5xx/network errors, and 401 detection. */
	private async send(req: HttpRequest, okStatuses: number[] = [200]): Promise<HttpResponse> {
		let attempt = 0;
		for (;;) {
			await this.throttle();
			this.requestCount++;
			let res: HttpResponse;
			try {
				this.log(`${req.method} ${req.url.replace(/\?.*$/, '')}`);
				res = await this.http(req);
				this.log(`-> HTTP ${res.status}`);
			} catch (e) {
				if (attempt >= this.maxRetries) throw e;
				const wait = 1000 * 2 ** attempt;
				this.log(`network error (${String(e)}), retry in ${wait} ms`);
				await this.sleep(wait);
				attempt++;
				continue;
			}
			if (okStatuses.includes(res.status)) return res;
			if (res.status === 401) throw new AuthError();
			if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
				const wait = 1000 * 2 ** attempt;
				this.log(`HTTP ${res.status} on ${req.method} ${req.url}, retry in ${wait} ms`);
				await this.sleep(wait);
				attempt++;
				continue;
			}
			throw new SimperiumError(`HTTP ${res.status} on ${req.method} ${req.url}`, res.status, res.text);
		}
	}

	private authHeaders(): Record<string, string> {
		if (!this.token) throw new AuthError('No token');
		return { 'X-Simperium-Token': this.token };
	}

	/** Logs in and stores the token on the client. Returns the token. */
	async authorize(username: string, password: string): Promise<string> {
		const res = await this.send(
			{
				url: `${this.authHost}/1/${this.appId}/authorize/`,
				method: 'POST',
				headers: { 'X-Simperium-API-Key': this.apiKey, 'Content-Type': 'application/json' },
				body: JSON.stringify({ username, password }),
			},
			[200],
		).catch((e: unknown) => {
			if (e instanceof SimperiumError && (e.status === 401 || e.status === 400)) {
				throw new AuthError('Login failed. Check email and password.');
			}
			throw e;
		});
		const parsed = JSON.parse(res.text) as { access_token?: string };
		if (!parsed.access_token) throw new AuthError('Login failed: no token in response.');
		this.token = parsed.access_token;
		return this.token;
	}

	async indexPage(opts: { since?: string; mark?: string; limit?: number; data?: boolean } = {}): Promise<IndexPage> {
		const q: string[] = [`limit=${opts.limit ?? 100}`];
		if (opts.data !== false) q.push('data=true');
		if (opts.since) q.push(`since=${encodeURIComponent(opts.since)}`);
		if (opts.mark) q.push(`mark=${encodeURIComponent(opts.mark)}`);
		const res = await this.send({ url: `${this.dataUrl}/index?${q.join('&')}`, method: 'GET', headers: this.authHeaders() });
		const page = JSON.parse(res.text) as IndexPage;
		const index = Array.isArray(page.index) ? page.index : [];
		return {
			index: index.map((e) => ({ id: e.id, v: e.v, d: e.d ? normalizeNoteData(e.d) : undefined })),
			current: String(page.current ?? ''),
			mark: page.mark ? String(page.mark) : undefined,
		};
	}

	/** Fetches all index pages. `since` undefined = full index. */
	async fetchIndex(since?: string, onPage?: (page: IndexPage) => void): Promise<{ entries: IndexEntry[]; current: string }> {
		const entries: IndexEntry[] = [];
		let mark: string | undefined;
		let current = '';
		do {
			const page = await this.indexPage({ since, mark, data: true });
			onPage?.(page);
			entries.push(...page.index);
			current = page.current;
			mark = page.mark;
		} while (mark);
		return { entries, current };
	}

	/** Returns null when the note does not exist (404). */
	async getNote(id: string, version?: number): Promise<VersionedNote | null> {
		const url = version === undefined ? `${this.dataUrl}/i/${id}` : `${this.dataUrl}/i/${id}/v/${version}`;
		const res = await this.send({ url, method: 'GET', headers: this.authHeaders() }, [200, 404]);
		if (res.status === 404) return null;
		return { data: normalizeNoteData(JSON.parse(res.text) as Partial<NoteData>), version: versionFromHeaders(res.headers) };
	}

	/**
	 * Creates or updates a note. Without replace, only the fields sent are updated.
	 * 412 (no change) is reported as `unchanged`. 405/409/440 are reported as `conflict`
	 * together with the current server note, so the caller can merge locally and retry.
	 * A 404 against a base version whose note still exists is a conflict too: the server
	 * does not have that version (NOTES.md, "Unknown base version").
	 */
	async postNote(
		id: string,
		data: Partial<NoteData>,
		opts: { baseVersion?: number; ccid?: string; replace?: boolean } = {},
	): Promise<PostResult> {
		let url = `${this.dataUrl}/i/${id}`;
		if (opts.baseVersion !== undefined) url += `/v/${opts.baseVersion}`;
		const q = ['response=1'];
		if (opts.ccid) q.push(`ccid=${opts.ccid}`);
		if (opts.replace) q.push('replace=1');
		url += `?${q.join('&')}`;
		const res = await this.send(
			{ url, method: 'POST', headers: { ...this.authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
			opts.baseVersion !== undefined ? [200, 404, 405, 409, 412, 440] : [200, 405, 409, 412, 440],
		);
		if (res.status === 200 && res.text.trim().length > 0) {
			return { data: normalizeNoteData(JSON.parse(res.text) as Partial<NoteData>), version: versionFromHeaders(res.headers), outcome: 'updated' };
		}
		const current = await this.getNote(id);
		if (!current) throw new SimperiumError(`Note ${id} vanished after POST (HTTP ${res.status})`, res.status, res.text);
		if (res.status === 200 || res.status === 412) return { ...current, outcome: 'unchanged' };
		if (res.status === 404) this.log(`HTTP 404 on POST ${id}: the server does not have base v${opts.baseVersion} (current v${current.version}); treating as conflict`);
		else this.log(`HTTP ${res.status} on POST ${id}: treating as conflict`);
		return { ...current, outcome: 'conflict' };
	}
}

export function versionFromHeaders(headers: Record<string, string>): number {
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === 'x-simperium-version') {
			const n = Number.parseInt(v, 10);
			return Number.isFinite(n) ? n : 0;
		}
	}
	return 0;
}
