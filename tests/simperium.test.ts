import { describe, expect, it } from 'vitest';
import { AuthError, SimperiumClient, SimperiumError } from '../src/simperium';
import { computeCcid, noteHash, sha256Hex } from '../src/hash';
import { fakeWithUser } from './fake-simperium';

function makeClient(server: ReturnType<typeof fakeWithUser>['server'], extra: Partial<ConstructorParameters<typeof SimperiumClient>[0]> = {}) {
	return new SimperiumClient({
		appId: 'chalk-bump-f49',
		apiKey: 'c8c2b86337154cdabc989b23e30c6bf4',
		http: server.http,
		sleep: () => Promise.resolve(),
		minIntervalMs: 0,
		...extra,
	});
}

describe('SimperiumClient', () => {
	it('logs in and lists notes with pagination', async () => {
		const { server, username, password } = fakeWithUser();
		for (let i = 0; i < 250; i++) server.seed(`n${String(i).padStart(3, '0')}`, { content: `Note ${i}\nbody` });
		const c = makeClient(server);
		const token = await c.authorize(username, password);
		expect(token).toMatch(/^tok-/);
		const { entries, current } = await c.fetchIndex();
		expect(entries).toHaveLength(250);
		expect(entries[0]?.d?.content).toBe('Note 0\nbody');
		expect(current).toBe('250');
		const indexRequests = server.requests.filter((r) => r.url.includes('/index?'));
		expect(indexRequests).toHaveLength(3);
	});

	it('rejects a bad login with AuthError', async () => {
		const { server, username } = fakeWithUser();
		const c = makeClient(server);
		await expect(c.authorize(username, 'wrong')).rejects.toBeInstanceOf(AuthError);
	});

	it('throws AuthError on 401 for an expired token', async () => {
		const { server } = fakeWithUser();
		const c = makeClient(server, { token: 'expired' });
		await expect(c.fetchIndex()).rejects.toBeInstanceOf(AuthError);
	});

	it('returns only changes since a cursor', async () => {
		const { server, username, password } = fakeWithUser();
		server.seed('a', { content: 'A' });
		const c = makeClient(server);
		await c.authorize(username, password);
		const first = await c.fetchIndex();
		server.seed('b', { content: 'B' });
		server.seed('a', { content: 'A2' });
		const second = await c.fetchIndex(first.current);
		expect(second.entries.map((e) => e.id)).toEqual(['b', 'a']);
		expect(second.entries[1]?.v).toBe(2);
		const third = await c.fetchIndex(second.current);
		expect(third.entries).toHaveLength(0);
	});

	it('creates, gets, and updates notes with versions', async () => {
		const { server, username, password } = fakeWithUser();
		const c = makeClient(server);
		await c.authorize(username, password);
		const r1 = await c.postNote('x1', { content: 'Hello\nworld', tags: ['t'], systemTags: ['markdown'], deleted: false });
		expect(r1.outcome).toBe('updated');
		expect(r1.version).toBe(1);
		const g = await c.getNote('x1');
		expect(g?.data.content).toBe('Hello\nworld');
		expect(g?.version).toBe(1);
		const r2 = await c.postNote('x1', { content: 'Hello\nworld!' }, { baseVersion: 1 });
		expect(r2.version).toBe(2);
		expect(r2.data.tags).toEqual(['t']); // partial update keeps other fields
		expect(await c.getNote('missing')).toBeNull();
	});

	it('treats 412 (no change) as success', async () => {
		const { server, username, password } = fakeWithUser();
		const c = makeClient(server);
		await c.authorize(username, password);
		await c.postNote('x1', { content: 'same' });
		const r = await c.postNote('x1', { content: 'same' }, { baseVersion: 1 });
		expect(r.outcome).toBe('unchanged');
		expect(r.version).toBe(1);
	});

	it('server merges string changes on a stale base version', async () => {
		const { server, username, password } = fakeWithUser();
		const c = makeClient(server);
		await c.authorize(username, password);
		await c.postNote('x1', { content: 'Title\nline one\nline two' });
		await c.postNote('x1', { content: 'Title\nline one edited\nline two' }, { baseVersion: 1 });
		const r = await c.postNote('x1', { content: 'Title\nline one\nline two edited' }, { baseVersion: 1 });
		expect(r.outcome).toBe('updated');
		expect(r.version).toBe(3);
		expect(r.data.content).toBe('Title\nline one edited\nline two edited');
	});

	it('reports a conflict when the server refuses a stale version', async () => {
		const { server, username, password } = fakeWithUser({ staleVersion: 405 });
		const c = makeClient(server);
		await c.authorize(username, password);
		await c.postNote('x1', { content: 'v1' });
		await c.postNote('x1', { content: 'v2' }, { baseVersion: 1 });
		const r = await c.postNote('x1', { content: 'mine' }, { baseVersion: 1 });
		expect(r.outcome).toBe('conflict');
		expect(r.data.content).toBe('v2');
		expect(r.version).toBe(2);
	});

	it('drops a duplicate ccid from a second login', async () => {
		const { server, username, password } = fakeWithUser();
		const c1 = makeClient(server);
		const c2 = makeClient(server);
		await c1.authorize(username, password);
		await c2.authorize(username, password);
		await c1.postNote('x1', { content: 'base' });
		const hash = await noteHash('base\nedit', [], false);
		const ccid = await computeCcid('x1', 1, hash);
		const r1 = await c1.postNote('x1', { content: 'base\nedit' }, { baseVersion: 1, ccid });
		expect(r1.version).toBe(2);
		const r2 = await c2.postNote('x1', { content: 'base\nedit' }, { baseVersion: 1, ccid });
		expect(server.version('x1')).toBe(2);
		expect(r2.data.content).toBe('base\nedit');
		expect(['unchanged', 'conflict']).toContain(r2.outcome);
	});

	it('retries 5xx and 429 with backoff and throttles requests', async () => {
		const { server, username, password } = fakeWithUser();
		const waits: number[] = [];
		let clock = 0;
		const c = makeClient(server, {
			sleep: (ms) => {
				waits.push(ms);
				clock += ms;
				return Promise.resolve();
			},
			now: () => clock,
			minIntervalMs: 500,
		});
		await c.authorize(username, password);
		server.failNext = { status: 503, count: 2 };
		await c.postNote('x1', { content: 'a' });
		expect(waits).toContain(1000);
		expect(waits).toContain(2000);
		waits.length = 0;
		await c.postNote('x1', { content: 'b' }, { baseVersion: 1 });
		await c.postNote('x1', { content: 'c' }, { baseVersion: 2 });
		// two requests back to back: the second one waits for the 500 ms slot
		expect(waits.some((w) => w > 0 && w <= 500)).toBe(true);
	});

	it('gives up after max retries', async () => {
		const { server, username, password } = fakeWithUser();
		const c = makeClient(server, { maxRetries: 2 });
		await c.authorize(username, password);
		server.failNext = { status: 500, count: 10 };
		await expect(c.getNote('x')).rejects.toBeInstanceOf(SimperiumError);
	});

	it('reports an unknown cursor as a SimperiumError (caller falls back to full index)', async () => {
		const { server, username, password } = fakeWithUser();
		const c = makeClient(server);
		await c.authorize(username, password);
		await expect(c.fetchIndex('garbage')).rejects.toMatchObject({ status: 400 });
	});
});

describe('hash helpers', () => {
	it('sha256 is stable', async () => {
		expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});
	it('ccid is 32 hex chars and deterministic', async () => {
		const a = await computeCcid('id', 3, 'h');
		const b = await computeCcid('id', 3, 'h');
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(await computeCcid('id', 4, 'h')).not.toBe(a);
	});
	it('note hash ignores tag order', async () => {
		expect(await noteHash('c', ['b', 'a'], false)).toBe(await noteHash('c', ['a', 'b'], false));
		expect(await noteHash('c', ['a'], true)).not.toBe(await noteHash('c', ['a'], false));
	});
});
