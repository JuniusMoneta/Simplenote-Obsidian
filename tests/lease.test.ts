import { describe, expect, it } from 'vitest';
import { holderOf, LEASE_NOTE_ID, LEASE_TTL_MS, parseLease, renderLease } from '../src/lease';
import { NEW_FILE_WAIT_MS } from '../src/sync';
import { FakeSimperium } from './fake-simperium';
import { makeHarness, logText } from './harness';
import { MemoryVault } from './memory-vault';

type H = Awaited<ReturnType<typeof makeHarness>>;

describe('lease note format', () => {
	it('round-trips lines and ignores garbage', () => {
		const lines = [
			{ device: 'aaaa', priority: 10, until: 20, name: 'Windows aaaa' },
			{ device: 'bbbb', priority: 5, until: 30, name: 'iPhone with spaces' },
		];
		const text = renderLease(lines);
		expect(text.split('\n')[0]).toContain('Obsidian sync lease');
		expect(parseLease(`${text}\nnot a line\n`)).toEqual(lines);
	});

	it('the valid line with the lowest priority holds the lease; ties go to the smaller device id', () => {
		const now = 100;
		expect(holderOf([], now)).toBeNull();
		expect(holderOf([{ device: 'a', priority: 1, until: 50, name: '' }], now)).toBeNull();
		const lines = [
			{ device: 'zzzz', priority: 1, until: 200, name: 'z' },
			{ device: 'aaaa', priority: 2, until: 200, name: 'a' },
			{ device: 'mmmm', priority: 1, until: 200, name: 'm' },
		];
		expect(holderOf(lines, now)?.device).toBe('mmmm');
	});
});

/** Two devices on one vault (zero-lag vault sync) and one Simplenote account. */
async function sharedVault(sharedVault = true): Promise<{ win: H; ios: H; server: FakeSimperium; vault: MemoryVault; clock: { now: number } }> {
	const server = new FakeSimperium();
	server.addUser('u', 'p');
	const clock = { now: 1_800_000_000_000 };
	const vault = new MemoryVault(() => clock.now);
	const win = await makeHarness({ server, vault, clock, settings: { sharedVault }, device: { id: 'win0000001', name: 'Windows win0' } });
	const ios = await makeHarness({ server, vault, clock, settings: { sharedVault }, device: { id: 'ios0000001', name: 'iPhone ios0' } });
	server.seed('a', { content: 'Note\nline one', tags: ['obsidian:F'] });
	return { win, ios, server, vault, clock };
}

const noteIds = (server: FakeSimperium): string[] => [...server.notes.keys()].filter((k) => k !== LEASE_NOTE_ID);

describe('push lease on a shared vault', () => {
	it('the first device to sync claims the lease; the second pulls only, and its edits reach Simplenote through the holder', async () => {
		const { win, ios, server, vault, clock } = await sharedVault();
		await win.engine.sync();
		await ios.engine.sync();
		expect(win.engine.pullOnly).toBeNull();
		expect(ios.engine.pullOnly).toBe('Windows win0');
		expect(vault.paths()).toEqual(['F/Note.md']); // the lease note never becomes a file
		const lease = server.get(LEASE_NOTE_ID);
		expect(lease?.deleted).toBe(true); // kept in the Simplenote trash
		// an edit made on the phone: the vault sync carries it to Windows, which pushes it
		vault.put('F/Note.md', '---\nsimplenote-id: a\n---\nline one\ntyped on the phone');
		clock.now += 15_000;
		let r = await ios.engine.sync();
		expect(r.pushed).toBe(0);
		expect(server.get('a')?.content).toBe('Note\nline one');
		r = await win.engine.sync();
		expect(r.pushed).toBe(1);
		expect(server.get('a')?.content).toBe('Note\nline one\ntyped on the phone');
		// the phone adopts the pushed version instead of pushing again
		r = await ios.engine.sync();
		expect(r.pushed).toBe(0);
		expect(server.version('a')).toBe(2);
	});

	it('new files are created by the holder only', async () => {
		const { win, ios, server, vault, clock } = await sharedVault();
		await win.engine.sync();
		await ios.engine.sync();
		vault.put('Fresh.md', 'hello');
		await win.engine.sync();
		await ios.engine.sync();
		clock.now += NEW_FILE_WAIT_MS + 1;
		await ios.engine.sync(); // pull only: must not create
		expect(noteIds(server)).toHaveLength(1);
		await win.engine.sync();
		expect(noteIds(server)).toHaveLength(2);
		await ios.engine.sync();
		expect(noteIds(server)).toHaveLength(2);
	});

	it('the lease moves to the other device when the holder stops syncing', async () => {
		const { win, ios, server, vault, clock } = await sharedVault();
		await win.engine.sync();
		await ios.engine.sync();
		clock.now += LEASE_TTL_MS + 1; // Windows closed
		vault.put('F/Note.md', '---\nsimplenote-id: a\n---\nline one\nphone, laptop off');
		const r = await ios.engine.sync();
		expect(ios.engine.pullOnly).toBeNull();
		expect(r.pushed).toBe(1);
		expect(server.get('a')?.content).toContain('laptop off');
		// Windows comes back: the phone holds the lease now
		await win.engine.sync();
		expect(win.engine.pullOnly).toBe('iPhone ios0');
		expect(logText(win)).toContain('standby: iPhone ios0 holds the sync lease');
	});

	it('the holder renews only when half the lease time has passed', async () => {
		const { win, server, clock } = await sharedVault();
		await win.engine.sync();
		const v1 = server.version(LEASE_NOTE_ID);
		clock.now += 20_000;
		await win.engine.sync();
		expect(server.version(LEASE_NOTE_ID)).toBe(v1);
		clock.now += LEASE_TTL_MS / 2;
		await win.engine.sync();
		expect(server.version(LEASE_NOTE_ID)).toBe(v1 + 1);
	});

	it('"take over" wins even against a holder that keeps renewing', async () => {
		const { win, ios, clock } = await sharedVault();
		await win.engine.sync();
		await ios.engine.sync();
		ios.engine.takeOver();
		await ios.engine.sync();
		expect(ios.engine.pullOnly).toBeNull();
		clock.now += 5_000;
		await win.engine.sync();
		expect(win.engine.pullOnly).toBe('iPhone ios0');
		expect(logText(win)).toContain('standby: iPhone ios0 holds the sync lease');
	});

	it('two devices claiming at the same moment agree on one holder', async () => {
		const { win, ios, server, clock } = await sharedVault();
		// both decide against an empty lease: the fake server merges the two creations like Simperium does
		await Promise.all([win.engine.sync(), ios.engine.sync()]);
		clock.now += 1_000;
		await win.engine.sync();
		await ios.engine.sync();
		const holders = [win.engine.pullOnly, ios.engine.pullOnly];
		expect(holders.filter((h) => h === null)).toHaveLength(1);
		expect(server.get(LEASE_NOTE_ID)?.deleted).toBe(true);
	});

	it('an emptied Simplenote trash recreates the lease note', async () => {
		const { win, ios, server, clock } = await sharedVault();
		await win.engine.sync();
		await ios.engine.sync();
		server.notes.delete(LEASE_NOTE_ID);
		clock.now += LEASE_TTL_MS;
		await win.engine.sync(); // renewal fails -> re-read -> recreate
		clock.now += 1_000;
		await win.engine.sync();
		expect(server.get(LEASE_NOTE_ID)?.deleted).toBe(true);
		expect(win.engine.pullOnly).toBeNull();
	});

	it('with the setting off both devices push as before and the lease note is never written', async () => {
		const { win, ios, server, vault } = await sharedVault(false);
		await win.engine.sync();
		await ios.engine.sync();
		vault.put('F/Note.md', '---\nsimplenote-id: a\n---\nline one\nedit');
		const r = await ios.engine.sync();
		expect(r.pushed).toBe(1);
		expect(server.get(LEASE_NOTE_ID)).toBeUndefined();
	});

	it('a standby device writes nothing: the holder applies remote changes and the vault sync carries them', async () => {
		const { win, ios, server, vault, clock } = await sharedVault();
		await win.engine.sync();
		await ios.engine.sync();
		server.seed('a', { content: 'Note\nline one\nedited on the web', tags: ['obsidian:F'] });
		server.seed('n', { content: 'New on web\nbody', tags: ['obsidian:F'] });
		clock.now += 15_000;
		const r = await ios.engine.sync();
		expect(r.pulled).toBe(0);
		expect(vault.get('F/Note.md')).not.toContain('edited on the web');
		expect(vault.has('F/New on web.md')).toBe(false);
		await win.engine.sync();
		expect(vault.get('F/Note.md')).toContain('edited on the web');
		expect(vault.has('F/New on web.md')).toBe(true);
		// the standby device sees the holder's writes through the vault and only records them
		const r2 = await ios.engine.sync();
		expect(r2.pushed + r2.pulled).toBe(0);
		expect(vault.paths()).toEqual(['F/New on web.md', 'F/Note.md']);
	});

	it('a device that takes the lease over catches up with a full reconcile', async () => {
		const { win, ios, server, vault, clock } = await sharedVault();
		await win.engine.sync();
		await ios.engine.sync();
		server.seed('a', { content: 'Note\nline one\nedited while on standby', tags: ['obsidian:F'] });
		clock.now += 15_000;
		await ios.engine.sync(); // standby: nothing written
		clock.now += LEASE_TTL_MS + 1; // Windows gone
		await ios.engine.sync();
		expect(ios.engine.pullOnly).toBeNull();
		expect(logText(ios)).toContain('full reconcile on the next sync');
		await ios.engine.sync();
		expect(vault.get('F/Note.md')).toContain('edited while on standby');
	});

	it('a device with the setting off follows the lease once another device created one', async () => {
		const server = new FakeSimperium();
		server.addUser('u', 'p');
		const clock = { now: 1_800_000_000_000 };
		const vault = new MemoryVault(() => clock.now);
		const win = await makeHarness({ server, vault, clock, settings: { sharedVault: true }, device: { id: 'win0000001', name: 'Windows win0' } });
		const ios = await makeHarness({ server, vault, clock, settings: { sharedVault: false }, device: { id: 'ios0000001', name: 'iPhone ios0' } });
		server.seed('a', { content: 'Note\nline one', tags: ['obsidian:F'] });
		await win.engine.sync();
		await ios.engine.sync();
		expect(ios.engine.pullOnly).toBe('Windows win0');
		expect(ios.notices.join('\n')).toContain('follows that lease');
		vault.put('F/Note.md', '---\nsimplenote-id: a\n---\nline one\ntyped on the phone');
		clock.now += 15_000;
		const r = await ios.engine.sync();
		expect(r.pushed).toBe(0);
		expect(server.get('a')?.content).toBe('Note\nline one');
		await win.engine.sync();
		expect(server.get('a')?.content).toBe('Note\nline one\ntyped on the phone');
	});

	it('a full reconcile on a pull-only device does not touch the lease note or trash anything', async () => {
		const { win, ios, server, vault } = await sharedVault();
		await win.engine.sync();
		await ios.engine.sync();
		const r = await ios.engine.sync({ full: true });
		expect(r.ok).toBe(true);
		expect(vault.paths()).toEqual(['F/Note.md']);
		expect(server.get(LEASE_NOTE_ID)?.deleted).toBe(true);
	});
});

describe('files deleted in Obsidian on a shared vault', () => {
	async function untitled(): Promise<{ win: H; ios: H; server: FakeSimperium; vault: MemoryVault; clock: { now: number } }> {
		const s = await sharedVault();
		s.server.seed('b', { content: '' });
		s.server.seed('c', { content: '' });
		await s.win.engine.sync();
		await s.ios.engine.sync();
		expect(s.ios.engine.pullOnly).toBe('Windows win0');
		expect(s.vault.paths()).toEqual(['F/Note.md', 'Untitled (2).md', 'Untitled.md']);
		return s;
	}
	const idOf = (vault: MemoryVault, path: string): string => /simplenote-id: "?([^"\n]+)/.exec(vault.get(path) ?? '')?.[1] ?? '';

	for (const where of ['holder', 'standby'] as const) {
		it(`deleted on the ${where}: the note is trashed on its next sync, and a copy that comes back does not restore it`, async () => {
			const { win, ios, server, vault, clock } = await untitled();
			const device = where === 'holder' ? win : ios;
			const id = idOf(vault, 'Untitled (2).md');
			const text = vault.get('Untitled (2).md') ?? '';
			vault.remove('Untitled (2).md');
			device.engine.noteDeletedByUser('Untitled (2).md', id);
			await device.engine.sync();
			expect(server.get(id)?.deleted).toBe(true);
			for (let i = 0; i < 2; i++) {
				clock.now += 15_000;
				await win.engine.sync();
				await ios.engine.sync();
			}
			vault.put('Untitled (2).md', text); // the vault sync brings a copy back
			for (let i = 0; i < 3; i++) {
				clock.now += 15_000;
				await win.engine.sync();
				await ios.engine.sync();
			}
			expect(server.get(id)?.deleted).toBe(true);
			expect(vault.paths()).toEqual(['F/Note.md', 'Untitled.md']);
			expect(logText(win)).not.toContain('restor');
		});
	}

	it('a file that vanishes without a delete in Obsidian still waits the shared-vault time', async () => {
		const { win, ios, server, vault, clock } = await untitled();
		const id = idOf(vault, 'Untitled (2).md');
		vault.remove('Untitled (2).md');
		for (let i = 0; i < 4; i++) {
			await win.engine.sync();
			await ios.engine.sync();
			clock.now += 60_000;
		}
		expect(server.get(id)?.deleted).toBe(false);
	});
});
