import { describe, expect, it } from 'vitest';
import { mergeStrings } from '../src/merge';

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
});
