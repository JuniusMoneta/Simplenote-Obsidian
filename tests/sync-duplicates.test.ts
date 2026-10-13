import { describe, expect, it } from 'vitest';
import { NEW_FILE_WAIT_MS } from '../src/sync';
import { FakeSimperium } from './fake-simperium';
import { makeHarness, logText } from './harness';
import { MemoryVault } from './memory-vault';

type H = Awaited<ReturnType<typeof makeHarness>>;
const seed = (h: H, id: string, content: string, tags: string[] = [], systemTags = ['markdown']) => h.server.seed(id, { content, tags, systemTags });

async function synced(opts: Parameters<typeof makeHarness>[0] = {}): Promise<H> {
	const h = await makeHarness(opts);
	seed(h, 'a', 'Note\nline one\nline two', ['obsidian:F', 'todo']);
	seed(h, 'b', 'Other\nbody');
	await h.engine.sync();
	return h;
}

describe('a remote change never creates a second file for a note whose file exists', () => {
	it('file over the size setting: the change waits and is applied when the file is under the limit again', async () => {
		const h = await synced({ settings: { maxNoteSizeKb: 1 } });
		h.vault.put('Other.md', `---\nsimplenote-id: b\n---\n${'x'.repeat(2000)}`);
		await h.engine.sync(); // blocked by the setting
		seed(h, 'b', 'Other\nedited on the web');
		await h.engine.sync();
		expect(h.vault.paths()).toEqual(['F/Note.md', 'Other.md']);
		expect(logText(h)).toContain('cannot sync right now');
		expect(logText(h)).not.toContain('recreating it');
		// the file shrinks back to what was synced: the remote edit is applied although the cursor moved on
		h.vault.put('Other.md', '---\nsimplenote-id: b\n---\nbody');
		await h.engine.sync();
		expect(h.vault.paths()).toEqual(['F/Note.md', 'Other.md']);
		expect(h.vault.get('Other.md')).toContain('edited on the web');
		expect(h.store.load().pendingRemote).toEqual({});
	});

	it('file blocked after repeated push errors', async () => {
		const h = await synced();
		h.vault.put('Other.md', '---\nsimplenote-id: b\n---\nlocal edit');
		for (let i = 0; i < 3; i++) {
			h.server.opts.beforeRequest = (req) => {
				if (req.method === 'POST' && req.url.includes('/i/b')) throw new Error('network down');
			};
			await h.engine.sync();
			h.server.opts.beforeRequest = () => undefined;
		}
		expect(h.engine.problems().map((p) => p.path)).toEqual(['Other.md']);
		seed(h, 'b', 'Other\nedited on the web');
		await h.engine.sync();
		expect(h.vault.paths()).toEqual(['F/Note.md', 'Other.md']);
		expect(h.store.load().pendingRemote).toHaveProperty('b');
	});

	it('file unreadable for a moment (cloud placeholder)', async () => {
		const h = await synced();
		h.vault.put('Other.md', '---\nsimplenote-id: b\n---\nbody', 5);
		h.vault.unreadable.add('other.md');
		seed(h, 'b', 'Other\nedited on the web');
		await h.engine.sync();
		expect(h.vault.paths()).toEqual(['F/Note.md', 'Other.md']);
		h.vault.unreadable.clear();
		await h.engine.sync();
		expect(h.vault.get('Other.md')).toContain('edited on the web');
		expect(h.server.notes.size).toBe(2);
	});

	it('the recorded file is gone and an unreadable file has the note\'s name: wait, never create "Note (2).md"', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nline one', ['obsidian:F']);
		await h.engine.sync();
		// iCloud for Windows renamed the file; the state follows the rename
		await h.vault.rename('F/Note.md', 'F/Note(1).md');
		await h.engine.sync();
		expect(h.store.load().notes.a?.path).toBe('F/Note(1).md');
		// another device cleaned up: the vault sync removes Note(1).md and delivers Note.md, not downloaded yet
		h.vault.remove('F/Note(1).md');
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\n---\nline one', 5);
		h.vault.unreadable.add('f/note.md');
		seed(h, 'a', 'Note\nline one\nedited on the web', ['obsidian:F']);
		await h.engine.sync();
		expect(h.vault.paths()).toEqual(['F/Note.md']);
		expect(h.store.load().pendingRemote).toHaveProperty('a');
		expect(logText(h)).toContain('cannot be read yet');
		await h.engine.sync();
		expect(h.vault.paths()).toEqual(['F/Note.md']);
		// the download finishes: the edit lands in the one file
		h.vault.unreadable.clear();
		await h.engine.sync();
		expect(h.vault.paths()).toEqual(['F/Note.md']);
		expect(h.vault.get('F/Note.md')).toContain('edited on the web');
		expect(h.store.load().notes.a?.path).toBe('F/Note.md');
	});

	it('file in an excluded folder on a device that never synced it', async () => {
		const h = await makeHarness({ settings: { excludedFolders: ['Private'] } });
		seed(h, 'p', 'Secret\nbody', ['obsidian:Private']);
		h.vault.put('Private/Secret.md', '---\nsimplenote-id: p\n---\nbody');
		await h.engine.sync();
		seed(h, 'p', 'Secret\nchanged on the web', ['obsidian:Private']);
		await h.engine.sync();
		expect(h.vault.paths()).toEqual(['Private/Secret.md']);
		expect(h.vault.get('Private/Secret.md')).toContain('body');
	});

	it('a file that really vanished is still recreated when the note changes', async () => {
		const h = await synced();
		h.vault.remove('Other.md');
		seed(h, 'b', 'Other\nedited on the web');
		await h.engine.sync();
		expect(h.vault.get('Other.md')).toContain('edited on the web');
	});
});

describe('two devices and a lagging vault sync', () => {
	/** Two vaults joined by a copy-based "vault sync" the test drives by hand. */
	async function twoDevices(): Promise<{ h1: H; h2: H; v1: MemoryVault; v2: MemoryVault; server: FakeSimperium; clock: { now: number }; copy: (from: MemoryVault, to: MemoryVault) => void }> {
		const server = new FakeSimperium();
		server.addUser('u', 'p');
		const clock = { now: 1_800_000_000_000 };
		const v1 = new MemoryVault(() => clock.now);
		const v2 = new MemoryVault(() => clock.now);
		const h1 = await makeHarness({ server, vault: v1, clock });
		const h2 = await makeHarness({ server, vault: v2, clock });
		seed(h1, 'a', 'Note\nline one\nline two', ['obsidian:F', 'todo']);
		await h1.engine.sync();
		await h2.engine.sync();
		const copy = (from: MemoryVault, to: MemoryVault): void => {
			for (const p of from.paths()) if (to.get(p) !== from.get(p)) to.put(p, from.get(p) ?? '');
			for (const p of to.paths()) if (!from.has(p)) to.remove(p);
		};
		return { h1, h2, v1, v2, server, clock, copy };
	}

	it('the second device links the new file to the note the first device created, instead of creating a second note', async () => {
		const { h1, h2, v1, v2, server, clock, copy } = await twoDevices();
		v1.put('Fresh.md', 'hello');
		copy(v1, v2);
		await h1.engine.sync();
		await h2.engine.sync();
		clock.now += NEW_FILE_WAIT_MS + 1;
		await h1.engine.sync(); // creates the note, writes the id into v1 only
		await h2.engine.sync(); // v2 still has no id: must link, not create
		expect(server.notes.size).toBe(2);
		const id = Object.keys(h1.store.load().notes).find((k) => k !== 'a') ?? '';
		expect(v2.get('Fresh.md')).toMatch(new RegExp(`simplenote-id: "?${id}"?`));
		expect(h2.store.load().notes[id]?.path).toBe('Fresh.md');
		expect(logText(h2)).toContain('created by another device');
		copy(v1, v2);
		for (let i = 0; i < 3; i++) {
			clock.now += 15_000;
			await h1.engine.sync();
			await h2.engine.sync();
		}
		expect(v1.paths()).toEqual(['F/Note.md', 'Fresh.md']);
		expect(v2.paths()).toEqual(['F/Note.md', 'Fresh.md']);
		expect(server.notes.size).toBe(2);
	});

	it('a note that only looks similar is not linked: different content still becomes its own file', async () => {
		const h = await synced();
		h.vault.put('Fresh.md', 'hello');
		await h.engine.sync();
		seed(h, 'x', 'Fresh\nhello there');
		await h.engine.sync();
		expect(h.vault.paths()).toEqual(['F/Note.md', 'Fresh (2).md', 'Fresh.md', 'Other.md']);
	});
});

describe('duplicate cleanup command', () => {
	it('trashes identical copies that share an id, keeps copies whose text differs', async () => {
		const h = await synced();
		h.vault.put('F/Note (2).md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nline one\nline two');
		h.vault.put('F/Note 2.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nline one\nline two\nextra line written here');
		await h.engine.sync(); // both copies are paused
		expect(h.store.load().pausedPaths.sort()).toEqual(['F/Note (2).md', 'F/Note 2.md']);
		const r = await h.engine.cleanupDuplicates();
		expect(r.trashed).toEqual(['F/Note (2).md']);
		expect(r.skipped).toEqual(['F/Note 2.md']);
		expect(r.kept).toEqual(['F/Note.md']);
		expect(h.vault.paths()).toEqual(['F/Note 2.md', 'F/Note.md', 'Other.md']);
		expect(h.store.load().pausedPaths).toEqual(['F/Note 2.md']);
		expect(h.server.get('a')?.content).toBe('Note\nline one\nline two');
	});

	it('trashes a "(2)" copy that holds the same text under a second note, and that note on Simplenote', async () => {
		const h = await synced();
		seed(h, 'dup', 'Other\nbody');
		await h.engine.sync();
		expect(h.vault.paths()).toEqual(['F/Note.md', 'Other (2).md', 'Other.md']);
		const r = await h.engine.cleanupDuplicates();
		expect(r.trashed).toEqual(['Other (2).md']);
		expect(r.notesTrashed).toBe(1);
		expect(h.server.get('dup')?.deleted).toBe(true);
		expect(h.vault.paths()).toEqual(['F/Note.md', 'Other.md']);
		await h.engine.sync();
		expect(h.vault.paths()).toEqual(['F/Note.md', 'Other.md']);
		expect(h.store.load().notes.dup).toBeUndefined();
	});

	it('dry run only reports', async () => {
		const h = await synced();
		h.settings.dryRun = true;
		h.vault.put('F/Note (2).md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nline one\nline two');
		const r = await h.engine.cleanupDuplicates();
		expect(r.dryRun).toBe(true);
		expect(r.trashed).toEqual(['F/Note (2).md']);
		expect(h.vault.has('F/Note (2).md')).toBe(true);
	});
});
