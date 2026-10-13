import { describe, expect, it } from 'vitest';
import {
	appendTagLine,
	splitTagLine,
	basenameMatchesTitle,
	decodeFolderTag,
	encodeFolderTag,
	exclusionReason,
	fileToNote,
	folderFromTag,
	tagKey,
	noteToFileText,
	splitTags,
	stripCollisionSuffix,
	stripConflictSuffix,
	effectiveTitle,
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
		for (const f of ['A b/c-d', 'x&y', 'café', 'emoji 😀', 'with,comma', '50% off', 'a:b', 'x,y%']) {
			expect(decodeFolderTag(encodeFolderTag(f) as string)).toBe(f);
		}
		// a real underscore is not escaped (fixed format): it decodes as a space unless the folder exists
		expect(decodeFolderTag(encodeFolderTag('my_folder') as string)).toBe('my folder');
	});
	it('does not escape a real underscore: "a_b" and "a b" share one tag (the format is fixed for compatibility)', () => {
		expect(encodeFolderTag('my_folder')).toBe('obsidian:my_folder');
		expect(encodeFolderTag('my folder')).toBe('obsidian:my_folder');
		expect(folderFromTag('obsidian:my_folder', ['my_folder'])).toBe('my_folder');
		expect(folderFromTag('obsidian:my_folder', ['my_folder', 'my folder'])).toBe('my_folder');
		expect(folderFromTag('obsidian:my_folder', ['other'])).toBe('my folder');
	});
	it('reads the 0.4.4 forms %5F and %255F as an underscore and never creates a folder named my%5Ffolder', () => {
		expect(decodeFolderTag('obsidian:my%5ffolder')).toBe('my_folder');
		expect(decodeFolderTag('obsidian:Projects/therapy%255Fproject')).toBe('Projects/therapy_project');
		expect(folderFromTag('obsidian:my%5Ffolder', ['other'])).toBe('my_folder');
		expect(folderFromTag('obsidian:my%5Ffolder', ['my folder', 'My_Folder'])).toBe('My_Folder');
		expect(folderFromTag('obsidian:Projects/therapy%255Fproject', ['Projects/therapy_project'])).toBe('Projects/therapy_project');
		expect(tagKey('obsidian:My%5FFolder')).toBe(tagKey('obsidian:my_folder'));
		expect(tagKey('obsidian:My%255FFolder')).toBe(tagKey('obsidian:my_folder'));
		expect(tagKey('todo%5f')).toBe('todo%5f');
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

const noteToFileText2 = (n: Parameters<typeof noteToFileText>[0], id: string, basename: string) => noteToFileText(n, id, basename, 'property');

describe('fileToNote / noteToFileText round trip', () => {
	const note = (content: string, tags: string[] = [], systemTags: string[] = ['markdown']) => ({ content, tags, systemTags });

	it('plain note', () => {
		const r = noteToFileText2(note('My Note\nline 1\nline 2', ['obsidian:Work', 'todo']), 'id1', 'My Note');
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
			const r = noteToFileText2(note(content), 'id', basename);
			const back = fileToNote(r.text, basename);
			expect(back.content).toBe(content);
			expect(back.usesTitleKey).toBe(true);
		}
	});

	it('does not add simplenote-title when the file name equals the title', () => {
		const r = noteToFileText2(note('Plain\nbody'), 'id', 'Plain');
		expect(r.text).not.toContain('simplenote-title');
	});

	it('collision suffix is local only', () => {
		const r = noteToFileText2(note('Foo\nbody'), 'id', 'Foo (2)');
		expect(r.text).toContain('simplenote-title: Foo');
		expect(fileToNote(r.text, 'Foo (2)').content).toBe('Foo\nbody');
		// a real title "Report (2)" needs no key
		const r2 = noteToFileText2(note('Report (2)\nbody'), 'id', 'Report (2)');
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
		const r = noteToFileText2(note(content, ['a', 'b'], ['markdown', 'pinned']), 'id', 'T');
		expect(r.text).toBe('---\nauthor: me\nsimplenote-id: id\ntags:\n  - a\n  - b\npinned: true\n---\ntext');
		const back = fileToNote(r.text, 'T');
		expect(back.content).toBe('T\n---\nauthor: me\n---\ntext');
		expect(back.tags).toEqual(['a', 'b']);
		expect(back.pinned).toBe(true);
	});

	it('invalid YAML in the body is kept as text and a new block is added', () => {
		const content = 'T\n---\nbad: [\n---\ntext';
		const r = noteToFileText2(note(content), 'id', 'T');
		expect(r.text).toBe('---\nsimplenote-id: id\n---\n---\nbad: [\n---\ntext');
		const back = fileToNote(r.text, 'T');
		expect(back.content).toBe(content);
		expect(back.id).toBe('id');
	});

	it('invalid YAML in a local file does not crash and is pushed as text', () => {
		const text = '---\nsimplenote-id: id\nbroken: : [\n---\nbody';
		const back = fileToNote(text, 'T');
		expect(back.invalidFrontmatter).toBe(true);
		expect(back.id).toBe('id'); // identity kept by regex fallback
		expect(back.content).toBe(`T\n${text}`);
		expect(fileToNote('---\nbroken: [\n---\nbody', 'T').id).toBeNull();
	});

	it('does not normalize body whitespace or line endings', () => {
		const content = 'T\r\nline  \r\n\r\n\ttab';
		const r = noteToFileText2(note(content), 'id', 'T');
		expect(fileToNote(r.text, 'T').content).toBe(content);
	});

	it('accented names in NFD and NFC map to the same file', () => {
		const nfd = 'café';
		const r = noteToFileText2(note(`${nfd}\nbody`), 'id', titleToFileName(nfd));
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

describe('inline tag line (default tag style)', () => {
	const note = (content: string, tags: string[] = [], systemTags: string[] = ['markdown']) => ({ content, tags, systemTags });
	it('writes tags as a hashtag line at the end and reads them back', () => {
		const r = noteToFileText(note('T\nbody line', ['obsidian:F', 'todo', 'Work/sub', 'has space']), 'id', 'T');
		expect(r.text).toBe('---\nsimplenote-id: id\ntags:\n  - has space\n---\nbody line\n\n#todo #Work/sub');
		const back = fileToNote(r.text, 'T');
		expect(back.content).toBe('T\nbody line');
		expect(back.tags).toEqual(['has space', 'todo', 'Work/sub']);
	});
	it('round-trips bodies with and without trailing newline, and empty bodies', () => {
		for (const body of ['x', 'x\n', '', 'a\n\nb\n\n']) {
			const r = noteToFileText(note(`T\n${body}`, ['t']), 'id', 'T');
			const back = fileToNote(r.text, 'T');
			expect(back.tags).toEqual(['t']);
			// one trailing newline is folded into the blank line before the tag line
			expect(back.content).toBe(`T\n${body.endsWith('\n') ? body.slice(0, -1) : body}`);
		}
	});
	it('a last line that is not only hashtags is body text', () => {
		const back = fileToNote('---\nsimplenote-id: id\n---\nsee #todo later', 'T');
		expect(back.tags).toEqual([]);
		expect(back.content).toBe('T\nsee #todo later');
		expect(fileToNote('---\nsimplenote-id: id\n---\n#123', 'T').tags).toEqual([]);
	});
	it('property tags and the tag line are merged on push', () => {
		const back = fileToNote('---\nsimplenote-id: id\ntags:\n  - a\n---\nbody\n\n#b #a', 'T');
		expect(back.tags).toEqual(['a', 'b']);
	});
	it('helpers', () => {
		expect(appendTagLine('body', ['a'])).toBe('body\n\n#a');
		expect(splitTagLine('body\n\n#a #b')).toEqual({ body: 'body', tags: ['a', 'b'] });
		expect(splitTagLine('#a')).toEqual({ body: '', tags: ['a'] });
	});
});

describe('iCloud for Windows conflict names', () => {
	it('strips (1), (1)(1) written directly after the name, but not the plugin\'s own " (2)" or a user\'s "Journal Red (1)"', () => {
		expect(stripConflictSuffix('Syncretic System(1)(1)(1)(1)')).toBe('Syncretic System');
		expect(stripConflictSuffix('The True Ontology(1)')).toBe('The True Ontology');
		expect(stripConflictSuffix('Untitled (5)(1)')).toBe('Untitled (5)');
		expect(stripConflictSuffix('Journal Red (1)')).toBe('Journal Red (1)');
		expect(stripConflictSuffix('Note (2)')).toBe('Note (2)');
		expect(stripConflictSuffix('(1)')).toBe('(1)');
	});
	it('a conflict copy keeps the note title', () => {
		expect(effectiveTitle('The True Ontology(1)', null).title).toBe('The True Ontology');
		expect(effectiveTitle('Syncretic System(1)(1)', '# Syncretic System')).toEqual({ title: '# Syncretic System', usesTitleKey: true });
		expect(effectiveTitle('Untitled (5)(1)', '')).toEqual({ title: '', usesTitleKey: true });
		expect(basenameMatchesTitle('Note(1)', 'Note')).toBe(true);
		expect(basenameMatchesTitle('Note(1)(1)', '# Note')).toBe(true);
	});
});
