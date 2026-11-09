import { describe, expect, it } from 'vitest';
import { applyChanges, mergeStrings, mergeWithoutBase } from '../src/merge';

describe('mergeStrings', () => {
	it('returns the other side when one side is unchanged', () => {
		expect(mergeStrings('a\nb', 'a\nb', 'a\nc')).toBe('a\nc');
		expect(mergeStrings('a\nb', 'a\nc', 'a\nb')).toBe('a\nc');
	});
	it('merges non-overlapping edits', () => {
		const base = 'one\ntwo\nthree\nfour\nfive';
		const a = 'ONE\ntwo\nthree\nfour\nfive';
		const b = 'one\ntwo\nthree\nfour\nFIVE';
		expect(mergeStrings(base, a, b)).toBe('ONE\ntwo\nthree\nfour\nFIVE');
	});
	it('merges an insertion with a deletion elsewhere', () => {
		const base = 'a\nb\nc\nd\ne';
		const a = 'a\nb\nc\nx\nd\ne';
		const b = 'a\nc\nd\ne';
		expect(mergeStrings(base, a, b)).toBe('a\nc\nx\nd\ne');
	});
	it('keeps an insertion adjacent to a deletion (conflict, no loss)', () => {
		const m = mergeStrings('a\nb\nc\nd', 'a\nb\nx\nc\nd', 'a\nc\nd');
		expect(m).toContain('x');
		expect(m.endsWith('c\nd')).toBe(true);
	});
	it('keeps both sides on a conflict, losing no text', () => {
		const base = 'a\nb\nc';
		const a = 'a\nB1\nc';
		const b = 'a\nB2\nc';
		const m = mergeStrings(base, a, b);
		expect(m).toContain('B1');
		expect(m).toContain('B2');
		expect(m.startsWith('a\n')).toBe(true);
		expect(m.endsWith('\nc')).toBe(true);
	});
	it('handles appends on both sides', () => {
		const base = 'title\nbody';
		const a = 'title\nbody\nfrom A';
		const b = 'title\nbody\nfrom B';
		const m = mergeStrings(base, a, b);
		expect(m).toContain('from A');
		expect(m).toContain('from B');
	});
	it('handles empty base', () => {
		expect(mergeStrings('', 'x', '')).toBe('x');
		expect(mergeStrings('', '', 'y')).toBe('y');
	});
	it('identical edits are not duplicated', () => {
		expect(mergeStrings('a\nb', 'a\nz', 'a\nz')).toBe('a\nz');
	});
	it('a base with CRLF line endings does not make every line a conflict', () => {
		const base = 'T\r\none\r\ntwo\r\nthree';
		expect(mergeStrings(base, 'T\none\ntwo\nthree\nadded', 'T\none\ntwo\nthree')).toBe('T\none\ntwo\nthree\nadded');
		expect(mergeStrings(base, 'T\nONE\ntwo\nthree', 'T\none\ntwo\nTHREE')).toBe('T\nONE\ntwo\nTHREE');
	});
	it('a large conflicting region keeps shared lines once instead of both whole blocks', () => {
		const lines = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(30)}`);
		const base = lines.map((l) => `${l} old`).join('\n');
		const a = [...lines.slice(0, 150), 'ours', ...lines.slice(150)].join('\n');
		const b = [...lines, 'theirs'].join('\n');
		const m = mergeStrings(base, a, b);
		expect(m.split('\n').filter((l) => l === lines[10])).toHaveLength(1);
		expect(m).toContain('ours');
		expect(m).toContain('theirs');
		expect(m.split('\n')).toHaveLength(302);
	});
});

describe('mergeWithoutBase', () => {
	it('keeps the lines of both sides, shared lines once', () => {
		expect(mergeWithoutBase('a\nb\nc', 'a\nc\nd')).toBe('a\nb\nc\nd');
		expect(mergeWithoutBase('a\r\nb', 'a\nb')).toBe('a\nb');
		expect(mergeWithoutBase('same', 'same')).toBe('same');
	});
});

describe('applyChanges (server-style patch application)', () => {
	it('applies an identical append twice, like the real server', () => {
		expect(applyChanges('base', 'base\nedit', 'base\nedit')).toBe('base\nedit\nedit');
	});
	it('applies non-overlapping edits', () => {
		expect(applyChanges('T\nline one\nline two', 'T\nline one\nline two web', 'T\nline one local\nline two')).toBe('T\nline one local\nline two web');
	});
	it('applies deletions and insertions at the start', () => {
		expect(applyChanges('a\nb\nc', 'a\nb\nc\nd', 'x\nb\nc')).toBe('x\nb\nc\nd');
		expect(applyChanges('a\nb\nc', 'a\nb\nc', 'a\nc')).toBe('a\nc');
	});
});
