import { describe, expect, it } from 'vitest';
import { joinFrontmatter, removeKeys, setKeys, splitFrontmatter, tagsFromValue, yamlScalar } from '../src/frontmatter';

describe('splitFrontmatter', () => {
	it('returns the whole text as body without a block', () => {
		const r = splitFrontmatter('hello\n---\nnot frontmatter');
		expect(r.hasBlock).toBe(false);
		expect(r.body).toBe('hello\n---\nnot frontmatter');
	});
	it('parses a valid block', () => {
		const r = splitFrontmatter('---\nsimplenote-id: abc\ntags:\n  - a\n  - b\nfoo: bar\n---\nbody text\n');
		expect(r.hasBlock).toBe(true);
		expect(r.invalid).toBe(false);
		expect(r.data['simplenote-id']).toBe('abc');
		expect(r.data.tags).toEqual(['a', 'b']);
		expect(r.body).toBe('body text\n');
	});
	it('treats invalid YAML as body text', () => {
		const text = '---\nfoo: [unclosed\nbar: : :\n---\nbody';
		const r = splitFrontmatter(text);
		expect(r.hasBlock).toBe(true);
		expect(r.invalid).toBe(true);
		expect(r.body).toBe(text);
	});
	it('treats a non-mapping block as invalid', () => {
		const r = splitFrontmatter('---\n- a\n- b\n---\nbody');
		expect(r.invalid).toBe(true);
	});
	it('handles an empty block and CRLF', () => {
		const r = splitFrontmatter('---\r\n---\r\nbody');
		expect(r.hasBlock).toBe(true);
		expect(r.invalid).toBe(false);
		expect(r.data).toEqual({});
		expect(r.eol).toBe('\r\n');
	});
	it('needs a closing delimiter', () => {
		const r = splitFrontmatter('---\nfoo: bar\nbody');
		expect(r.hasBlock).toBe(false);
	});
});

describe('removeKeys / setKeys', () => {
	const yaml = 'simplenote-id: abc\ntags:\n  - a\n  - b\nfoo: bar\npinned: true\naliases:\n- x\n';
	it('removes managed keys and keeps the rest verbatim', () => {
		expect(removeKeys(yaml, ['simplenote-id', 'tags', 'pinned'])).toBe('foo: bar\naliases:\n- x');
	});
	it('removes non-indented sequence items with their key', () => {
		expect(removeKeys(yaml, ['aliases'])).toBe('simplenote-id: abc\ntags:\n  - a\n  - b\nfoo: bar\npinned: true');
	});
	it('replaces in place and appends missing keys', () => {
		const out = setKeys('foo: bar\ntags:\n  - old\n', { 'simplenote-id': 'id1', tags: ['new'], pinned: true });
		expect(out).toBe('foo: bar\ntags:\n  - new\nsimplenote-id: id1\npinned: true');
	});
	it('removes a key when the value is undefined', () => {
		expect(setKeys('a: 1\npinned: true\nb: 2', { pinned: undefined })).toBe('a: 1\nb: 2');
	});
	it('builds from empty', () => {
		expect(setKeys('', { 'simplenote-id': 'x' })).toBe('simplenote-id: x');
	});
	it('handles quoted keys', () => {
		expect(removeKeys('"simplenote-id": x\nfoo: 1', ['simplenote-id'])).toBe('foo: 1');
	});
});

describe('joinFrontmatter', () => {
	it('omits an empty block', () => {
		expect(joinFrontmatter('', 'body')).toBe('body');
		expect(joinFrontmatter('a: 1', 'body')).toBe('---\na: 1\n---\nbody');
	});
});

describe('yamlScalar', () => {
	it('quotes unsafe values', () => {
		expect(yamlScalar('Simple title')).toBe('Simple title');
		expect(yamlScalar('# Heading')).toBe('"# Heading"');
		expect(yamlScalar('a: b')).toBe('"a: b"');
		expect(yamlScalar('true')).toBe('"true"');
		expect(yamlScalar('123')).toBe('"123"');
		expect(yamlScalar('café')).toBe('café');
		expect(yamlScalar('ends with space ')).toBe('"ends with space "');
	});
	it('round-trips through the parser', () => {
		for (const s of ['# Heading', 'a: b', 'true', '  lead', 'with "quotes"', 'tab\there', 'emoji 😀', '[x]', '- dash']) {
			const r = splitFrontmatter(`---\nsimplenote-title: ${yamlScalar(s)}\n---\n`);
			expect(r.data['simplenote-title']).toBe(s);
		}
	});
});

describe('tagsFromValue', () => {
	it('accepts arrays and strings', () => {
		expect(tagsFromValue(['a', '#b', 'a'])).toEqual(['a', 'b']);
		expect(tagsFromValue('a, b c')).toEqual(['a', 'b', 'c']);
		expect(tagsFromValue(undefined)).toEqual([]);
		expect(tagsFromValue(42)).toEqual(['42']);
	});
});
