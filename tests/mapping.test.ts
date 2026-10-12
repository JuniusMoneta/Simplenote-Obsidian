import { describe, expect, it } from 'vitest';
import {
	basenameMatchesTitle,
	decodeFolderTag,
	encodeFolderTag,
	exclusionReason,
	fileToNote,
	folderFromTag,
	noteToFileText,
	splitTags,
	stripCollisionSuffix,
	titleToFileName,
	uniqueBasename,
} from '../src/mapping';

describe('titleToFileName', () => {
	it('strips invalid characters and trims', () => {
		expect(titleToFileName('A/B:C*D?E"F<G>H|I#J^K[L]M')).toBe('ABCDEFGHIJKLM');
		expect(titleToFileName('  spaced  ')).toBe('spaced');
		expect(titleToFileName('...dots')).toBe('dots');
		expect(titleToFileName('trailing.')).toBe('trailing');
		expect(titleToFileName('# Heading')).toBe('Heading');
	});
	it('limits length to 100 and falls back to Untitled', () => {
		expect(titleToFileName('x'.repeat(150))).toHaveLength(100);
		expect(titleToFileName('')).toBe('Untitled');
		expect(titleToFileName('###')).toBe('Untitled');
	});
	it('normalizes to NFC', () => {
		const nfd = 'café';
		expect(titleToFileName(nfd)).toBe('café');
		expect(titleToFileName(nfd)).toBe(titleToFileName('café'));
	});
});

describe('collision helpers', () => {
	it('strips suffixes', () => {
		expect(stripCollisionSuffix('Foo (2)')).toBe('Foo');
		expect(stripCollisionSuffix('Foo (1)')).toBe('Foo (1)');
		expect(stripCollisionSuffix('Foo')).toBe('Foo');
		expect(stripCollisionSuffix('Foo (2) (3)')).toBe('Foo (2)');
	});
	it('finds a unique basename case-insensitively', () => {
		const taken = new Set(['foo', 'foo (2)']);
		expect(uniqueBasename('Foo', (b) => taken.has(b.toLowerCase()))).toBe('Foo (3)');
		expect(uniqueBasename('Bar', (b) => taken.has(b.toLowerCase()))).toBe('Bar');
	});
});

describe('folder tags', () => {
	it('encodes and decodes', () => {
		expect(encodeFolderTag('Projects/Client Work')).toBe('obsidian:Projects/Client_Work');
		expect(encodeFolderTag('')).toBeNull();
		expect(encodeFolderTag('/a/')).toBe('obsidian:a');
		expect(decodeFolderTag('obsidian:Projects/Client_Work')).toBe('Projects/Client Work');
		for (const f of ['A b/c-d', 'x&y', 'café', 'emoji 😀', 'with,comma', '50% off', 'a:b']) {
			expect(decodeFolderTag(encodeFolderTag(f) as string)).toBe(f);
		}
	});
	it('prefers an existing folder with underscores', () => {
		expect(folderFromTag('obsidian:my_folder', ['my_folder', 'other'])).toBe('my_folder');
		expect(folderFromTag('obsidian:my_folder', ['other'])).toBe('my folder');
		expect(folderFromTag('obsidian:work', ['Work'])).toBe('Work');
	});
	it('splits folder tags from other tags, sorted', () => {
		const r = splitTags(['todo', 'obsidian:b', 'Obsidian:a', 'x']);
		expect(r.folderTags).toEqual(['Obsidian:a', 'obsidian:b']);
		expect(r.otherTags).toEqual(['todo', 'x']);
	});
});

describe('exclusions', () => {
	const s = { excludedFolders: ['Private', 'Work/Secrets'], maxNoteSizeKb: 200 };
	it('applies all rules', () => {
		expect(exclusionReason('a.txt', 10, s)).toBe('not-markdown');
		expect(exclusionReason('.obsidian/x.md', 10, s)).toBe('dot-folder');
		expect(exclusionReason('.trash/x.md', 10, s)).toBe('dot-folder');
		expect(exclusionReason('a/.hidden/x.md', 10, s)).toBe('dot-folder');
		expect(exclusionReason('draw.excalidraw.md', 10, s)).toBe('excalidraw');
		expect(exclusionReason('private/x.md', 10, s)).toBe('excluded-folder');
		expect(exclusionReason('Work/Secrets/deep/x.md', 10, s)).toBe('excluded-folder');
		expect(exclusionReason('Work/x.md', 10, s)).toBeNull();
		expect(exclusionReason('Privateer/x.md', 10, s)).toBeNull();
		expect(exclusionReason('big.md', 300 * 1024, s)).toBe('too-large');
		expect(exclusionReason('ok.md', 10, s)).toBeNull();
	});
});

describe('fileToNote / noteToFileText round trip', () => {
	const note = (content: string, tags: string[] = [], systemTags: string[] = ['markdown']) => ({ content, tags, systemTags });

	it('plain note', () => {
		const r = noteToFileText(note('My Note\nline 1\nline 2', ['obsidian:Work', 'todo']), 'id1', 'My Note');
		expect(r.text).toBe('---\nsimplenote-id: id1\ntags:\n  - todo\n---\nline 1\nline 2');
		const back = fileToNote(r.text, 'My Note');
		expect(back.id).toBe('id1');
		expect(back.content).toBe('My Note\nline 1\nline 2');
		expect(back.tags).toEqual(['todo']);
		expect(back.pinned).toBe(false);
		expect(back.usesTitleKey).toBe(false);
	});

	it('keeps long or invalid titles in simplenote-title', () => {
		const titles = ['# Heading with hash', 'A sentence: with colon?', 'x'.repeat(140), '', '  padded  ', 'ends with dot.'];
		for (const t of titles) {
			const content = `${t}\nbody`;
			const basename = titleToFileName(t);
			const r = noteToFileText(note(content), 'id', basename);
			const back = fileToNote(r.text, basename);
			expect(back.content).toBe(content);
			expect(back.usesTitleKey).toBe(true);
		}
	});

	it('does not add simplenote-title when the file name equals the title', () => {
		const r = noteToFileText(note('Plain\nbody'), 'id', 'Plain');
		expect(r.text).not.toContain('simplenote-title');
	});

	it('collision suffix is local only', () => {
		const r = noteToFileText(note('Foo\nbody'), 'id', 'Foo (2)');
		expect(r.text).toContain('simplenote-title: Foo');
		expect(fileToNote(r.text, 'Foo (2)').content).toBe('Foo\nbody');
		// a real title "Report (2)" needs no key
		const r2 = noteToFileText(note('Report (2)\nbody'), 'id', 'Report (2)');
		expect(r2.text).not.toContain('simplenote-title');
		expect(fileToNote(r2.text, 'Report (2)').content).toBe('Report (2)\nbody');
	});

	it('user rename drops the stored title', () => {
		const text = '---\nsimplenote-id: id\nsimplenote-title: "# Old"\n---\nbody';
		expect(fileToNote(text, 'Old').title).toBe('# Old');
		expect(fileToNote(text, 'Renamed').title).toBe('Renamed');
		expect(fileToNote(text, 'Renamed').usesTitleKey).toBe(false);
	});

	it('merges plugin keys into existing frontmatter in the body', () => {
		const content = 'T\n---\nauthor: me\ntags:\n  - stale\n---\ntext';
		const r = noteToFileText(note(content, ['a', 'b'], ['markdown', 'pinned']), 'id', 'T');
		expect(r.text).toBe('---\nauthor: me\nsimplenote-id: id\ntags:\n  - a\n  - b\npinned: true\n---\ntext');
		const back = fileToNote(r.text, 'T');
		expect(back.content).toBe('T\n---\nauthor: me\n---\ntext');
		expect(back.tags).toEqual(['a', 'b']);
		expect(back.pinned).toBe(true);
	});

	it('invalid YAML in the body is kept as text and a new block is added', () => {
		const content = 'T\n---\nbad: [\n---\ntext';
		const r = noteToFileText(note(content), 'id', 'T');
		expect(r.text).toBe('---\nsimplenote-id: id\n---\n---\nbad: [\n---\ntext');
		const back = fileToNote(r.text, 'T');
		expect(back.content).toBe(content);
		expect(back.id).toBe('id');
	});

	it('invalid YAML in a local file does not crash and is pushed as text', () => {
		const text = '---\nsimplenote-id: id\nbroken: : [\n---\nbody';
		const back = fileToNote(text, 'T');
		expect(back.invalidFrontmatter).toBe(true);
		expect(back.id).toBeNull();
		expect(back.content).toBe(`T\n${text}`);
	});

	it('does not normalize body whitespace or line endings', () => {
		const content = 'T\r\nline  \r\n\r\n\ttab';
		const r = noteToFileText(note(content), 'id', 'T');
		expect(fileToNote(r.text, 'T').content).toBe(content);
	});

	it('accented names in NFD and NFC map to the same file', () => {
		const nfd = 'café';
		const r = noteToFileText(note(`${nfd}\nbody`), 'id', titleToFileName(nfd));
		expect(r.text).not.toContain('simplenote-title');
		expect(fileToNote(r.text, 'café').content).toBe('café\nbody');
	});

	it('tags as a string and with # prefixes', () => {
		const back = fileToNote('---\nsimplenote-id: id\ntags: "#a, b"\n---\n', 'T');
		expect(back.tags).toEqual(['a', 'b']);
	});

	it('empty frontmatter block is removed on push', () => {
		const back = fileToNote('---\nsimplenote-id: id\n---\nbody', 'T');
		expect(back.body).toBe('body');
	});
});

describe('basenameMatchesTitle', () => {
	it('accepts suffixes and lossy conversions', () => {
		expect(basenameMatchesTitle('Foo', 'Foo')).toBe(true);
		expect(basenameMatchesTitle('Foo (2)', 'Foo')).toBe(true);
		expect(basenameMatchesTitle('Heading', '# Heading')).toBe(true);
		expect(basenameMatchesTitle('Other', 'Foo')).toBe(false);
	});
});
