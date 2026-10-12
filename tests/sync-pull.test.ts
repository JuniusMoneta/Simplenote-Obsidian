import { describe, expect, it } from 'vitest';
import { makeHarness, logText } from './harness';

const seed = (h: Awaited<ReturnType<typeof makeHarness>>, id: string, content: string, tags: string[] = [], systemTags = ['markdown']) =>
	h.server.seed(id, { content, tags, systemTags });

describe('pull-only mirror', () => {
	it('imports a test account into the right folders', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Plan\nbody of plan', ['obsidian:Projects/Client_Work', 'todo']);
		seed(h, 'b', 'Root note\nhello');
		seed(h, 'c', '# Heading: with colon\ntext', ['obsidian:Ideas']);
		seed(h, 'd', 'Plan\nanother plan', ['obsidian:Projects/Client_Work']);
		seed(h, 'e', 'Trashed\nold', [], ['markdown']);
		h.server.seed('e', { content: 'Trashed\nold', deleted: true });
		seed(h, 'f', 'Pinned\nbody', [], ['markdown', 'pinned']);
		const r = await h.engine.sync();
		expect(r.ok).toBe(true);
		expect(r.pulled).toBe(5);
		expect(h.vault.paths()).toEqual(['Ideas/Heading with colon.md', 'Pinned.md', 'Projects/Client Work/Plan (2).md', 'Projects/Client Work/Plan.md', 'Root note.md']);
		expect(h.vault.get('Projects/Client Work/Plan.md')).toBe('---\nsimplenote-id: a\ntags:\n  - todo\n---\nbody of plan');
		expect(h.vault.get('Projects/Client Work/Plan (2).md')).toBe('---\nsimplenote-id: d\nsimplenote-title: Plan\n---\nanother plan');
		expect(h.vault.get('Ideas/Heading with colon.md')).toContain('simplenote-title: "# Heading: with colon"');
		expect(h.vault.get('Pinned.md')).toContain('pinned: true');
		expect(h.firstRunProposals).toHaveLength(1);
		expect(h.firstRunProposals[0]?.unmatchedRemote).toHaveLength(5);
		const state = h.store.load();
		expect(Object.keys(state.notes).sort()).toEqual(['a', 'b', 'c', 'd', 'f']);
		expect(state.cursor).toBe(String(h.server.cv));
		expect(state.firstRunDone).toBe(true);
	});

	it('is idempotent: a second sync changes nothing', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nbody', ['obsidian:F']);
		await h.engine.sync();
		const before = h.vault.events.length;
		const r = await h.engine.sync();
		expect(r.pulled + r.pushed + r.trashed).toBe(0);
		expect(h.vault.events.length).toBe(before);
	});

	it('applies remote edits, retitles, retags, and trash', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nbody', ['obsidian:F']);
		seed(h, 'b', 'Gone\nbye', ['obsidian:F']);
		await h.engine.sync();
		// edit
		h.server.seed('a', { content: 'Note\nbody edited', tags: ['obsidian:F'] });
		await h.engine.sync();
		expect(h.vault.get('F/Note.md')).toBe('---\nsimplenote-id: a\n---\nbody edited');
		// retitle
		h.server.seed('a', { content: 'New title\nbody edited', tags: ['obsidian:F'] });
		await h.engine.sync();
		expect(h.vault.has('F/Note.md')).toBe(false);
		expect(h.vault.get('F/New title.md')).toBe('---\nsimplenote-id: a\n---\nbody edited');
		// retag (move)
		h.server.seed('a', { content: 'New title\nbody edited', tags: ['obsidian:G/Sub_folder', 'x'] });
		await h.engine.sync();
		expect(h.vault.has('F/New title.md')).toBe(false);
		expect(h.vault.get('G/Sub folder/New title.md')).toBe('---\nsimplenote-id: a\ntags:\n  - x\n---\nbody edited');
		// remove folder tag -> root
		h.server.seed('a', { content: 'New title\nbody edited', tags: ['x'] });
		await h.engine.sync();
		expect(h.vault.get('New title.md')).toContain('body edited');
		// trash
		h.server.seed('b', { content: 'Gone\nbye', tags: ['obsidian:F'], deleted: true });
		const r = await h.engine.sync();
		expect(r.trashed).toBe(1);
		expect(h.vault.has('F/Gone.md')).toBe(false);
		expect(h.vault.trashed.map((t) => t.path)).toEqual(['F/Gone.md']);
		expect(h.store.load().notes.b).toBeUndefined();
	});

	it('a title change that still maps to the same file name only updates the key', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nbody');
		await h.engine.sync();
		h.server.seed('a', { content: 'Note?\nbody' });
		await h.engine.sync();
		expect(h.vault.get('Note.md')).toBe('---\nsimplenote-id: a\nsimplenote-title: "Note?"\n---\nbody');
		expect(h.vault.events.filter((e) => e.kind === 'rename')).toHaveLength(0);
	});

	it('case-only folder differences do not move files', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nbody', ['obsidian:Work']);
		await h.engine.sync();
		h.server.seed('a', { content: 'Note\nbody 2', tags: ['obsidian:work'] });
		await h.engine.sync();
		expect(h.vault.get('Work/Note.md')).toContain('body 2');
		expect(h.vault.events.filter((e) => e.kind === 'rename')).toHaveLength(0);
	});

	it('prefers an existing folder with underscores when decoding a tag', async () => {
		const h = await makeHarness();
		h.vault.put('my_folder/existing.md', 'x');
		seed(h, 'a', 'Note\nbody', ['obsidian:my_folder']);
		await h.engine.sync();
		expect(h.vault.has('my_folder/Note.md')).toBe(true);
	});

	it('uses the first folder tag in sort order when there are several', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nbody', ['obsidian:Zeta', 'obsidian:Alpha']);
		await h.engine.sync();
		expect(h.vault.has('Alpha/Note.md')).toBe(true);
		expect(logText(h)).toContain('2 folder tags');
	});

	it('handles permanently deleted notes on full reconcile', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nbody');
		seed(h, 'b', 'Other\nbody');
		await h.engine.sync();
		h.server.purge('b');
		await h.engine.sync();
		expect(h.vault.has('Other.md')).toBe(false);
		expect(h.store.load().notes.b).toBeUndefined();
		// and via the daily reconcile when the index entry is missing entirely
		seed(h, 'c', 'Third\nbody');
		await h.engine.sync();
		h.server.notes.delete('c');
		await h.engine.sync({ full: true });
		expect(h.vault.has('Third.md')).toBe(false);
	});

	it('falls back to a full index when the cursor is rejected', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nbody');
		await h.engine.sync();
		const st = h.store.load();
		st.cursor = 'bogus';
		h.store.save(st);
		seed(h, 'b', 'B\nbody');
		const r = await h.engine.sync();
		expect(r.ok).toBe(true);
		expect(h.vault.has('B.md')).toBe(true);
		expect(h.store.load().cursor).toBe(String(h.server.cv));
	});

	it('dry run changes nothing', async () => {
		const h = await makeHarness({ settings: { dryRun: true } });
		seed(h, 'a', 'Note\nbody');
		const r = await h.engine.sync();
		expect(r.dryRun).toBe(true);
		expect(h.vault.paths()).toEqual([]);
		expect(h.store.load().cursor).toBe('');
		expect(h.store.load().firstRunDone).toBe(false);
		expect(logText(h)).toContain('[dry-run] create Note.md');
	});

	it('stops on an expired token', async () => {
		const h = await makeHarness();
		h.client.setToken('expired');
		const r = await h.engine.sync();
		expect(r.ok).toBe(false);
		expect(h.notices.some((n) => n.includes('log in'))).toBe(true);
		expect(h.engine.status.kind).toBe('error');
	});
});

describe('first run linking', () => {
	it('links pre-placed files instead of duplicating them', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Exact\nbody a\n', ['x']);
		seed(h, 'b', 'With title\nbody b');
		seed(h, 'c', 'Probable\n' + Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n'));
		seed(h, 'd', 'Only remote\nbody d');
		h.vault.put('Folder/Exact.md', '---\nimported: 2020\n---\nbody a');
		h.vault.put('With title.md', 'With title\nbody b');
		h.vault.put('Probable.md', Array.from({ length: 20 }, (_, i) => (i === 5 ? 'changed' : `l${i}`)).join('\n'));
		h.vault.put('Only local.md', 'local only');
		const r = await h.engine.sync();
		expect(r.ok).toBe(true);
		const p = h.firstRunProposals[0];
		expect(p?.matches.map((m) => [m.local.path, m.method])).toEqual([
			['Folder/Exact.md', 'exact'],
			['With title.md', 'title-line'],
			['Probable.md', 'probable'],
		]);
		expect(p?.unmatchedRemote.map((x) => x.id)).toEqual(['d']);
		expect(p?.unmatchedLocal.map((x) => x.path)).toEqual(['Only local.md']);
		expect(h.vault.paths()).toEqual(['Folder/Exact.md', 'Only local.md', 'Only remote.md', 'Probable.md', 'With title.md']);
		// ids written, title line removed, tags merged
		expect(h.vault.get('Folder/Exact.md')).toBe('---\nimported: 2020\nsimplenote-id: a\ntags:\n  - x\n---\nbody a');
		expect(h.vault.get('With title.md')).toBe('---\nsimplenote-id: b\n---\nbody b');
		expect(h.vault.get('Probable.md')).toContain('simplenote-id: c');
		// linked files were pushed: folder tag set from the file's folder, local body kept
		expect(h.server.get('a')?.tags).toEqual(['x', 'obsidian:Folder']);
		expect(h.server.get('c')?.content).toContain('changed');
		expect(h.server.get('b')?.content).toBe('With title\nbody b');
		// the local-only file is uploaded right away (approved in the first run)
		const local = h.vault.get('Only local.md') ?? '';
		expect(local).toMatch(/simplenote-id: "?[0-9a-f]{32}"?/);
		expect([...h.server.notes.values()].some((n) => n.data?.content === 'Only local\nlocal only')).toBe(true);
	});

	it('does not relink probable matches the owner declined', async () => {
		const h = await makeHarness();
		const body = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
		seed(h, 'c', `Probable\n${body}`);
		h.vault.put('Probable.md', body.replace('l5', 'changed'));
		h.answers.firstRun = () => ({ confirmedProbable: new Set(), applyTitleFixes: true, importUnmatched: true, uploadUnmatched: true });
		await h.engine.sync();
		expect(h.vault.has('Probable (2).md')).toBe(true);
		expect(h.vault.get('Probable.md')).toMatch(/simplenote-id: "?[0-9a-f]{32}"?/);
		expect(h.vault.get('Probable.md')).not.toContain('simplenote-id: c\n');
	});

	it('cancel writes nothing and pauses', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nbody');
		h.vault.put('Local.md', 'x');
		h.answers.firstRun = () => null;
		const r = await h.engine.sync();
		expect(r.skipped).toBe('first-run-cancelled');
		expect(h.vault.paths()).toEqual(['Local.md']);
		expect(h.vault.get('Local.md')).toBe('x');
		expect(h.server.notes.size).toBe(1);
		expect(h.store.load().firstRunDone).toBe(false);
	});

	it('files that already carry an id are linked by id without matching', async () => {
		const h = await makeHarness();
		seed(h, 'a', 'Note\nbody', ['obsidian:F']);
		h.vault.put('F/Note.md', '---\nsimplenote-id: a\n---\nbody');
		const r = await h.engine.sync();
		expect(r.ok).toBe(true);
		expect(h.firstRunProposals).toHaveLength(0);
		expect(h.vault.paths()).toEqual(['F/Note.md']);
		expect(h.store.load().notes.a?.path).toBe('F/Note.md');
		expect(h.server.version('a')).toBe(1);
	});

	it('first run in dry-run mode only reports', async () => {
		const h = await makeHarness({ settings: { dryRun: true } });
		seed(h, 'a', 'Note\nbody');
		h.vault.put('Note.md', 'body');
		await h.engine.sync();
		expect(h.firstRunProposals).toHaveLength(1);
		expect(h.vault.get('Note.md')).toBe('body');
		expect(logText(h)).toContain('[dry-run] first run: link Note.md -> a');
	});
});

describe('file dates follow Simplenote', () => {
	it('created files carry the note creation and modification dates; remote edits set the modified time', async () => {
		const h = await makeHarness();
		h.server.seed('a', { content: 'Dated\nbody', creationDate: 1_600_000_000, modificationDate: 1_650_000_000 });
		await h.engine.sync();
		expect(h.vault.ctimeOf('Dated.md')).toBe(1_600_000_000_000);
		expect(h.vault.mtimeOf('Dated.md')).toBe(1_650_000_000_000);
		h.server.seed('a', { content: 'Dated\nbody 2', creationDate: 1_600_000_000, modificationDate: 1_700_000_000 });
		await h.engine.sync();
		expect(h.vault.mtimeOf('Dated.md')).toBe(1_700_000_000_000);
		expect(h.store.load().notes.a?.mtime).toBe(1_700_000_000_000);
		const r = await h.engine.sync();
		expect(r.pushed + r.pulled).toBe(0);
	});
});
