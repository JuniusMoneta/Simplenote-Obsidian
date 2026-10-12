import { describe, expect, it } from 'vitest';
import { NEW_FILE_WAIT_MS, SUSPICIOUS_WAIT_MS } from '../src/sync';
import { makeHarness, logText } from './harness';

type H = Awaited<ReturnType<typeof makeHarness>>;
const seed = (h: H, id: string, content: string, tags: string[] = [], systemTags = ['markdown']) => h.server.seed(id, { content, tags, systemTags });

async function synced(opts: Parameters<typeof makeHarness>[0] = {}): Promise<H> {
	const h = await makeHarness(opts);
	seed(h, 'a', 'Note\nline one\nline two', ['obsidian:F', 'todo']);
	seed(h, 'b', 'Other\nbody');
	await h.engine.sync();
	return h;
}

describe('push edits (M3)', () => {
	it('pushes a local edit with the base version', async () => {
		const h = await synced();
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nline one edited\nline two');
		const r = await h.engine.sync();
		expect(r.pushed).toBe(1);
		expect(h.server.get('a')?.content).toBe('Note\nline one edited\nline two');
		expect(h.server.get('a')?.tags).toEqual(['todo', 'obsidian:F']);
		expect(h.server.version('a')).toBe(2);
		expect(h.store.load().notes.a?.version).toBe(2);
		// nothing more to do
		const r2 = await h.engine.sync();
		expect(r2.pushed + r2.pulled).toBe(0);
	});

	it('merges simultaneous edits with no lost text', async () => {
		const h = await synced();
		h.server.seed('a', { content: 'Note\nline one\nline two edited on the web', tags: ['obsidian:F', 'todo'] });
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nline one edited locally\nline two');
		const r = await h.engine.sync();
		expect(r.ok).toBe(true);
		const merged = 'Note\nline one edited locally\nline two edited on the web';
		expect(h.server.get('a')?.content).toBe(merged);
		expect(h.vault.get('F/Note.md')).toBe('---\nsimplenote-id: a\ntags:\n  - todo\n---\nline one edited locally\nline two edited on the web');
		expect(h.store.load().notes.a?.version).toBe(h.server.version('a'));
	});

	it('merges locally when the server refuses a stale base', async () => {
		const h = await synced({ fake: { staleVersion: 405 } });
		h.server.seed('a', { content: 'Note\nline one\nline two edited on the web', tags: ['obsidian:F', 'todo'] });
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nline one edited locally\nline two');
		const r = await h.engine.sync();
		expect(r.ok).toBe(true);
		expect(h.server.get('a')?.content).toBe('Note\nline one edited locally\nline two edited on the web');
		expect(h.vault.get('F/Note.md')).toContain('line two edited on the web');
		expect(logText(h)).toContain('merging locally');
	});

	it('pull before push: an edit that already arrived from another device is not pushed again', async () => {
		const h = await synced();
		// another device pushed exactly this content already
		h.server.seed('a', { content: 'Note\nsame edit', tags: ['obsidian:F', 'todo'] });
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nsame edit');
		const r = await h.engine.sync();
		expect(r.pushed).toBe(0);
		expect(h.server.version('a')).toBe(2);
		expect(h.store.load().notes.a?.version).toBe(2);
	});

	it('two devices pushing the same edit from the same base send the same ccid', async () => {
		const h1 = await synced();
		const h2 = await h1.newDevice();
		await h2.engine.sync();
		h1.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nedit from vault sync');
		await h1.engine.sync();
		// device 2 sees the same file change through vault sync before it pulls: it must not double-apply
		await h2.engine.sync();
		expect(h1.server.version('a')).toBe(2);
		expect(h1.server.get('a')?.content).toBe('Note\nedit from vault sync');
		const posts = h1.server.requests.filter((r) => r.method === 'POST' && r.url.includes('/i/a/'));
		expect(posts).toHaveLength(1);
	});

	it('same-ccid duplicate push is harmless even without a pull first', async () => {
		const h1 = await synced();
		const h2 = await h1.newDevice();
		await h2.engine.sync();
		h1.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nedit X');
		// both devices compute the plan from the same base; simulate by syncing device 2 with a pre-fetched state
		const st2 = h2.store.load();
		await h1.engine.sync();
		h2.store.save(st2); // device 2 did not see the new cursor (stale)
		await h2.engine.sync();
		expect(h1.server.version('a')).toBe(2);
		expect(h1.server.get('a')?.content).toBe('Note\nedit X');
	});

	it('invalid frontmatter is pushed as text without crashing and keeps the note identity', async () => {
		const h = await synced();
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\nbroken: [\n---\nbody');
		const r = await h.engine.sync();
		expect(r.ok).toBe(true);
		expect(logText(h)).toContain('not valid YAML');
		expect(h.server.get('a')?.content).toBe('Note\n---\nsimplenote-id: a\nbroken: [\n---\nbody');
		expect(h.vault.get('F/Note.md')).toBe('---\nsimplenote-id: a\nbroken: [\n---\nbody');
		h.advance(NEW_FILE_WAIT_MS + 1);
		await h.engine.sync();
		expect(h.server.notes.size).toBe(2);
		// a new file with invalid frontmatter gets a new block in front
		h.vault.put('Bad.md', '---\nbroken: [\n---\ntext');
		await h.engine.sync();
		h.advance(NEW_FILE_WAIT_MS + 1);
		await h.engine.sync();
		expect(h.vault.get('Bad.md')).toMatch(/^---\nsimplenote-id: "?[0-9a-f]{32}"?\n---\n---\nbroken: \[\n---\ntext$/);
	});

	it('rename in Obsidian pushes the new first line', async () => {
		const h = await synced();
		await h.vault.rename('F/Note.md', 'F/Renamed.md');
		await h.engine.sync();
		expect(h.server.get('a')?.content).toBe('Renamed\nline one\nline two');
		expect(h.store.load().notes.a?.path).toBe('F/Renamed.md');
	});

	it('an unreadable file is skipped and retried', async () => {
		const h = await synced();
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\n---\nchanged');
		h.vault.unreadable.add('f/note.md');
		const r = await h.engine.sync();
		expect(r.ok).toBe(true);
		expect(h.server.version('a')).toBe(1);
		expect(logText(h)).toContain('cannot read');
		h.vault.unreadable.clear();
		await h.engine.sync();
		expect(h.server.get('a')?.content).toBe('Note\nchanged');
	});
});

describe('create, delete, move, tags, pinned (M4)', () => {
	it('creates a note for a new file after the 2-minute wait and writes the id first', async () => {
		const h = await synced();
		h.vault.put('New/Fresh.md', 'hello');
		let r = await h.engine.sync();
		expect(r.pushed).toBe(0);
		expect(h.server.notes.size).toBe(2);
		h.advance(NEW_FILE_WAIT_MS + 1);
		r = await h.engine.sync();
		expect(r.pushed).toBe(1);
		const text = h.vault.get('New/Fresh.md') ?? '';
		const id = /simplenote-id: "?([0-9a-f]{32})"?/.exec(text)?.[1] ?? '';
		expect(id).toHaveLength(32);
		const n = h.server.get(id);
		expect(n?.content).toBe('Fresh\nhello');
		expect(n?.tags).toEqual(['obsidian:New']);
		expect(n?.systemTags).toEqual(['markdown']);
	});

	it('device B links a new file once the id arrives instead of creating a second note', async () => {
		const h1 = await synced();
		const h2 = await h1.newDevice();
		await h2.engine.sync();
		h1.vault.put('Fresh.md', 'hello');
		await h1.engine.sync(); // A sees it, starts waiting
		await h2.engine.sync(); // B sees it too, starts waiting
		h1.advance(NEW_FILE_WAIT_MS + 1);
		await h1.engine.sync(); // A creates the note and writes the id
		await h2.engine.sync(); // B re-reads: id present
		expect(h1.server.notes.size).toBe(3);
		expect(h2.store.load().notes[Object.keys(h1.store.load().notes).find((k) => k !== 'a' && k !== 'b') ?? '']).toBeDefined();
	});

	it('a file with an id that is not on the server is created with that id', async () => {
		const h = await synced();
		h.vault.put('Carried.md', '---\nsimplenote-id: feedfacefeedfacefeedfacefeedface\n---\nbody');
		await h.engine.sync();
		expect(h.server.get('feedfacefeedfacefeedfacefeedface')?.content).toBe('Carried\nbody');
	});

	it('deleting a file trashes the note after the suspicious-change wait', async () => {
		const h = await synced();
		h.vault.remove('Other.md');
		let r = await h.engine.sync();
		expect(r.trashed).toBe(0);
		expect(h.server.get('b')?.deleted).toBe(false);
		expect(logText(h)).toContain('vanished');
		h.advance(SUSPICIOUS_WAIT_MS + 1);
		r = await h.engine.sync();
		expect(r.trashed).toBe(1);
		expect(h.server.get('b')?.deleted).toBe(true);
		expect(h.store.load().notes.b).toBeUndefined();
	});

	it('a file that vanishes and comes back is not trashed', async () => {
		const h = await synced();
		const text = h.vault.get('Other.md') ?? '';
		h.vault.remove('Other.md');
		await h.engine.sync();
		h.vault.put('Other.md', text);
		h.advance(SUSPICIOUS_WAIT_MS + 1);
		await h.engine.sync();
		expect(h.server.get('b')?.deleted).toBe(false);
		expect(h.store.load().pendingDeletes.b).toBeUndefined();
	});

	it('an empty body is pushed only after the wait', async () => {
		const h = await synced();
		h.vault.put('Other.md', '---\nsimplenote-id: b\n---\n');
		await h.engine.sync();
		expect(h.server.get('b')?.content).toBe('Other\nbody');
		h.advance(SUSPICIOUS_WAIT_MS + 1);
		await h.engine.sync();
		expect(h.server.get('b')?.content).toBe('Other\n');
	});

	it('moving a file replaces the folder tag', async () => {
		const h = await synced();
		await h.vault.rename('F/Note.md', 'G/Sub/Note.md');
		await h.engine.sync();
		expect(h.server.get('a')?.tags).toEqual(['todo', 'obsidian:G/Sub']);
		await h.vault.rename('G/Sub/Note.md', 'Note.md');
		await h.engine.sync();
		expect(h.server.get('a')?.tags).toEqual(['todo']);
	});

	it('tags and pinned round trip both ways', async () => {
		const h = await synced();
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags: [todo, urgent]\npinned: true\n---\nline one\nline two');
		await h.engine.sync();
		expect(h.server.get('a')?.tags).toEqual(['todo', 'urgent', 'obsidian:F']);
		expect(h.server.get('a')?.systemTags).toEqual(['markdown', 'pinned']);
		h.server.seed('a', { content: 'Note\nline one\nline two', tags: ['obsidian:F', 'web'], systemTags: ['markdown'] });
		await h.engine.sync();
		expect(h.vault.get('F/Note.md')).toBe('---\nsimplenote-id: a\ntags:\n  - web\n---\nline one\nline two');
	});

	it('a tag added on the web survives a simultaneous local text edit', async () => {
		const h = await synced();
		h.server.seed('a', { content: 'Note\nline one\nline two', tags: ['obsidian:F', 'todo', 'web'] });
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nline one local\nline two');
		await h.engine.sync();
		expect(h.server.get('a')?.tags.sort()).toEqual(['obsidian:F', 'todo', 'web']);
		expect(h.server.get('a')?.content).toBe('Note\nline one local\nline two');
	});

	it('extra folder tags are removed on the next push', async () => {
		const h = await synced();
		h.server.seed('a', { content: 'Note\nline one\nline two', tags: ['obsidian:F', 'obsidian:Zed', 'todo'] });
		await h.engine.sync();
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nedited');
		await h.engine.sync();
		expect(h.server.get('a')?.tags).toEqual(['todo', 'obsidian:F']);
	});

	it('duplicate ids: the conflict copy is paused, never uploaded', async () => {
		const h = await synced();
		h.vault.put('F/Note (conflict 2026-10-11).md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nconflict text');
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nline one!\nline two');
		const r = await h.engine.sync();
		expect(r.ok).toBe(true);
		expect(h.notices.some((n) => n.includes('Duplicate simplenote-id'))).toBe(true);
		expect(h.store.load().pausedPaths).toEqual(['F/Note (conflict 2026-10-11).md']);
		expect(h.server.get('a')?.content).toBe('Note\nline one!\nline two');
		expect(h.server.notes.size).toBe(2);
		h.advance(NEW_FILE_WAIT_MS * 2);
		await h.engine.sync();
		expect(h.server.notes.size).toBe(2);
	});

	it('files that become excluded are left alone on both sides', async () => {
		const h = await synced({ settings: { excludedFolders: ['Keep'] } });
		await h.vault.rename('Other.md', 'Keep/Other.md');
		await h.engine.sync();
		h.advance(SUSPICIOUS_WAIT_MS * 2);
		await h.engine.sync();
		expect(h.server.get('b')?.deleted).toBe(false);
		expect(h.server.get('b')?.content).toBe('Other\nbody');
		expect(logText(h)).toContain('excluded: Keep/Other.md (in an excluded folder');
		expect(h.engine.excludedFiles().map((e) => e.path)).toEqual(['Keep/Other.md']);
	});

	it('excluded folders and dot folders never sync', async () => {
		const h = await synced({ settings: { excludedFolders: ['Private'] } });
		h.vault.put('Private/Secret.md', 'secret');
		h.vault.put('.obsidian/plugins/x/README.md', 'nope');
		h.vault.put('Draw.excalidraw.md', 'nope');
		h.advance(NEW_FILE_WAIT_MS * 2);
		await h.engine.sync();
		expect(h.server.notes.size).toBe(2);
	});

	it('folders that differ only by case: the second one is skipped with a warning', async () => {
		const h = await synced();
		h.vault.put('Work/A.md', 'a');
		h.vault.put('work/B.md', 'b');
		await h.engine.sync();
		h.advance(NEW_FILE_WAIT_MS + 1);
		await h.engine.sync();
		expect(h.server.notes.size).toBe(3);
		expect(h.vault.get('Work/A.md')).toContain('simplenote-id');
		expect(h.vault.get('work/B.md')).toBe('b');
		expect(logText(h)).toContain('differs only by case');
	});

	it('mass-change guard asks before trashing many files', async () => {
		const h = await makeHarness();
		for (let i = 0; i < 12; i++) seed(h, `n${i}`, `N${i}\nbody`);
		await h.engine.sync();
		for (let i = 0; i < 12; i++) h.server.seed(`n${i}`, { content: `N${i}\nbody`, deleted: true });
		h.answers.confirmPlan = false;
		let r = await h.engine.sync();
		expect(r.skipped).toBe('guard-declined');
		expect(h.confirmations[0]?.trash).toBe(12);
		expect(h.vault.paths()).toHaveLength(12);
		expect(h.engine.paused).toBe(true);
		h.engine.resume();
		h.answers.confirmPlan = true;
		r = await h.engine.sync();
		expect(r.trashed).toBe(12);
	});

	it('a folder rename is described as one cause', async () => {
		const h = await makeHarness();
		for (let i = 0; i < 25; i++) seed(h, `n${i}`, `N${i}\nbody`, ['obsidian:Old']);
		await h.engine.sync();
		for (let i = 0; i < 25; i++) await h.vault.rename(`Old/N${i}.md`, `New/N${i}.md`);
		await h.engine.sync();
		expect(h.confirmations).toHaveLength(1);
		expect(h.confirmations[0]?.move).toBe(25);
		expect(h.confirmations[0]?.causes.join('\n')).toContain('Folder "Old" -> "New": 25 note(s)');
		expect(h.server.get('n0')?.tags).toEqual(['obsidian:New']);
	});

	it('writes a backup before the first push', async () => {
		const h = await synced();
		expect(h.vault.pluginFiles.size).toBe(0);
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nedit');
		await h.engine.sync();
		const names = [...h.vault.pluginFiles.keys()];
		expect(names).toHaveLength(1);
		expect(names[0]).toMatch(/^backup-\d{8}-\d{4}\.json$/);
		const parsed = JSON.parse(h.vault.pluginFiles.get(names[0] ?? '') ?? '[]') as { id: string; content: string }[];
		expect(parsed.map((n) => n.id).sort()).toEqual(['a', 'b']);
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nedit 2');
		await h.engine.sync();
		expect(h.vault.pluginFiles.size).toBe(1);
	});

	it('serializes concurrent sync calls', async () => {
		const h = await synced();
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\ntags:\n  - todo\n---\nedit');
		const [r1, r2, r3] = await Promise.all([h.engine.sync(), h.engine.sync(), h.engine.sync()]);
		expect(r1.pushed + r2.pushed + r3.pushed).toBe(1);
		expect(h.server.version('a')).toBe(2);
	});
});

describe('no ccid dedupe on the server (verified live)', () => {
	it('an identical edit pushed by another device during the sync is adopted, not applied twice', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nline one', ['obsidian:F']);
		await h.engine.sync();
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\n---\nline one\nappended');
		// simulate device A pushing the very same edit after this device fetched the index but before it pushes
		let fired = false;
		h.server.opts.beforeRequest = (req) => {
			if (!fired && req.url.includes('/i/a')) {
				fired = true;
				h.server.seed('a', { content: 'Note\nline one\nappended', tags: ['obsidian:F'] });
			}
		};
		const r = await h.engine.sync();
		expect(r.ok).toBe(true);
		expect(fired).toBe(true);
		expect(h.server.get('a')?.content).toBe('Note\nline one\nappended');
		expect(h.server.version('a')).toBe(2);
		expect(h.store.load().notes.a?.version).toBe(2);
		expect(logText(h)).toContain('identical content already on Simplenote');
	});

	it('a different edit pushed meanwhile is merged by the server', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nline one\nline two', ['obsidian:F']);
		await h.engine.sync();
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\n---\nline one local\nline two');
		let fired = false;
		h.server.opts.beforeRequest = (req) => {
			if (!fired && req.url.includes('/i/a')) {
				fired = true;
				h.server.seed('a', { content: 'Note\nline one\nline two web', tags: ['obsidian:F'] });
			}
		};
		await h.engine.sync();
		expect(h.server.get('a')?.content).toBe('Note\nline one local\nline two web');
		expect(h.vault.get('F/Note.md')).toContain('line two web');
	});

	it('an oversize note is announced once with a remedy, retried only when it changes, and clears itself', async () => {
		const h = await makeHarness({ fake: { maxContentBytes: 50 }, settings: { maxNoteSizeKb: 200 } });
		seed(h, 'a', 'Note\nshort');
		await h.engine.sync();
		h.vault.put('Note.md', `---\nsimplenote-id: a\n---\n${'x'.repeat(100)}`);
		let r = await h.engine.sync();
		expect(r.ok).toBe(true);
		expect(h.notices.filter((n) => n.includes('is not syncing'))).toHaveLength(1);
		expect(h.notices[0]).toContain('Shorten the note');
		expect(h.engine.problems().map((p) => p.path)).toEqual(['Note.md']);
		expect(h.engine.status).toMatchObject({ kind: 'idle', problems: 1 });
		const posts = h.server.requests.filter((q) => q.method === 'POST').length;
		await h.engine.sync();
		expect(h.server.requests.filter((q) => q.method === 'POST').length).toBe(posts); // not retried while unchanged
		expect(h.notices.filter((n) => n.includes('is not syncing'))).toHaveLength(1);
		// the note must not be trashed on the server while blocked
		h.advance(SUSPICIOUS_WAIT_MS * 2);
		await h.engine.sync();
		expect(h.server.get('a')?.deleted).toBe(false);
		// shrink it: syncs again, problem cleared
		h.vault.put('Note.md', '---\nsimplenote-id: a\n---\nsmall');
		r = await h.engine.sync();
		expect(h.server.get('a')?.content).toBe('Note\nsmall');
		expect(h.engine.problems()).toHaveLength(0);
	});

	it('a file over the plugin size limit is announced the same way', async () => {
		const h = await synced({ settings: { maxNoteSizeKb: 1 } });
		h.vault.put('Other.md', `---\nsimplenote-id: b\n---\n${'x'.repeat(2000)}`);
		await h.engine.sync();
		expect(h.notices.some((n) => n.includes('"Other.md" is not syncing') && n.includes('maximum note size'))).toBe(true);
		expect(h.engine.problems()).toHaveLength(1);
	});
});

describe('vanished files and remote trash (iCloud eviction)', () => {
	it('a file that vanishes long enough to trash the note, then comes back, restores the note instead of being deleted', async () => {
		const h = await synced();
		const text = h.vault.get('Other.md') ?? '';
		h.vault.remove('Other.md');
		await h.engine.sync();
		h.advance(SUSPICIOUS_WAIT_MS + 1);
		await h.engine.sync();
		expect(h.server.get('b')?.deleted).toBe(true);
		// iCloud brings the file back unchanged
		h.vault.put('Other.md', text);
		const r = await h.engine.sync();
		expect(r.ok).toBe(true);
		expect(h.vault.has('Other.md')).toBe(true);
		expect(h.vault.trashed).toHaveLength(0);
		expect(h.server.get('b')?.deleted).toBe(false);
		expect(h.server.get('b')?.content).toBe('Other\nbody');
		expect(h.store.load().notes.b?.path).toBe('Other.md');
		expect(logText(h)).toContain('restoring its note');
	});

	it('a note trashed on the web removes the local file only when it is unchanged, and says so', async () => {
		const h = await synced();
		h.server.seed('b', { content: 'Other\nbody', deleted: true });
		await h.engine.sync();
		expect(h.vault.has('Other.md')).toBe(false);
		expect(h.notices.some((n) => n.includes('moved to the Obsidian trash') && n.includes('Other.md'))).toBe(true);
	});

	it('a note trashed on the web while the file was edited locally keeps the file and restores the note', async () => {
		const h = await synced();
		h.server.seed('b', { content: 'Other\nbody', deleted: true });
		h.vault.put('Other.md', '---\nsimplenote-id: b\n---\nbody edited locally');
		await h.engine.sync();
		expect(h.vault.has('Other.md')).toBe(true);
		expect(h.server.get('b')?.deleted).toBe(false);
		expect(h.server.get('b')?.content).toBe('Other\nbody edited locally');
	});
});
