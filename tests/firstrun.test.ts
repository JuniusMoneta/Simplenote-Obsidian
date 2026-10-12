import { describe, expect, it } from 'vitest';
import { bodyWithoutFrontmatter, matchFirstRun, normalizeForMatch, removeTitleLine, type RemoteCandidate } from '../src/firstrun';

const remote = (id: string, content: string, deleted = false): RemoteCandidate => ({
	id,
	version: 1,
	data: { content, tags: [], deleted, systemTags: ['markdown'], creationDate: 0, modificationDate: 0 },
});

describe('matchFirstRun', () => {
	it('matches by basename + body (method 1), ignoring frontmatter and whitespace', () => {
		const r = matchFirstRun([remote('a', 'Note A\nbody line\n')], [{ path: 'Folder/Note A.md', text: '---\nimported: true\n---\nbody line  \r\n\r\n' }]);
		expect(r.matches).toHaveLength(1);
		expect(r.matches[0]?.method).toBe('exact');
		expect(r.unmatchedRemote).toHaveLength(0);
		expect(r.unmatchedLocal).toHaveLength(0);
	});
	it('matches by body alone when the title line is still in the file (method 2)', () => {
		const r = matchFirstRun([remote('a', 'Note A\nbody line')], [{ path: 'Note A.md', text: 'Note A\nbody line' }]);
		expect(r.matches[0]?.method).toBe('title-line');
	});
	it('finds probable matches by title and 90% similarity (method 3)', () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
		const edited = lines.replace('line 3', 'line three');
		const r = matchFirstRun([remote('a', `# Note A\n${lines}`)], [{ path: 'Note A.md', text: `---\nx: 1\n---\n${edited}` }]);
		expect(r.matches[0]?.method).toBe('probable');
		expect(r.matches[0]?.similarity).toBeGreaterThanOrEqual(0.9);
		const r2 = matchFirstRun([remote('a', `Note A\n${lines}`)], [{ path: 'Note A.md', text: 'completely different' }]);
		expect(r2.matches).toHaveLength(0);
		expect(r2.unmatchedRemote).toHaveLength(1);
	});
	it('uses each local file once and reports the miss rate', () => {
		const r = matchFirstRun([remote('a', 'Same\nbody'), remote('b', 'Same\nbody'), remote('c', 'Other\nx')], [{ path: 'Same.md', text: 'body' }]);
		expect(r.matches).toHaveLength(1);
		expect(r.unmatchedRemote.map((x) => x.id)).toEqual(['b', 'c']);
		expect(r.missRate).toBeCloseTo(2 / 3);
	});
	it('ignores trashed remote notes', () => {
		const r = matchFirstRun([remote('a', 'X\ny', true)], [{ path: 'X.md', text: 'y' }]);
		expect(r.matches).toHaveLength(0);
		expect(r.unmatchedLocal).toHaveLength(1);
		expect(r.missRate).toBe(0);
	});
	it('exact matches are not stolen by probable ones', () => {
		const body = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n');
		const r = matchFirstRun(
			[remote('p', `N\n${body}\nextra`), remote('e', `N\n${body}`)],
			[{ path: 'N.md', text: body }],
		);
		expect(r.matches.find((m) => m.remote.id === 'e')?.method).toBe('exact');
		expect(r.unmatchedRemote.map((x) => x.id)).toEqual(['p']);
	});
});

describe('helpers', () => {
	it('normalizes', () => {
		expect(normalizeForMatch('a \r\nb\t\n\n')).toBe('a\nb');
		expect(normalizeForMatch('café')).toBe('café');
	});
	it('strips invalid frontmatter too', () => {
		expect(bodyWithoutFrontmatter('---\nbad: [\n---\nbody')).toBe('body');
		expect(bodyWithoutFrontmatter('---\nok: 1\n---\nbody')).toBe('body');
		expect(bodyWithoutFrontmatter('no fm')).toBe('no fm');
	});
	it('removes the title line and keeps frontmatter', () => {
		expect(removeTitleLine('---\na: 1\n---\nTitle\nbody')).toBe('---\na: 1\n---\nbody');
		expect(removeTitleLine('Title\nbody')).toBe('body');
		expect(removeTitleLine('Title')).toBe('');
	});
});
