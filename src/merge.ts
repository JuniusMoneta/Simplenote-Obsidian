/**
 * Three-way merge used by the fake Simperium server in tests and as the
 * client-side fallback when the server refuses a stale-version update.
 * Works line by line; regions that both sides changed are merged again
 * character by character. Never drops text: a true conflict keeps both
 * versions (ours first, then theirs).
 */

const MAX_DP_CELLS = 4_000_000;

/** For each item of `x`, the index of the matching item in `y`, or -1 (LCS). */
function lcsMatch<T>(x: T[], y: T[]): Int32Array {
	const match = new Int32Array(x.length).fill(-1);
	let start = 0;
	while (start < x.length && start < y.length && x[start] === y[start]) {
		match[start] = start;
		start++;
	}
	let xEnd = x.length;
	let yEnd = y.length;
	while (xEnd > start && yEnd > start && x[xEnd - 1] === y[yEnd - 1]) {
		xEnd--;
		yEnd--;
		match[xEnd] = yEnd;
	}
	const n = xEnd - start;
	const m = yEnd - start;
	if (n === 0 || m === 0) return match;
	if (n * m > MAX_DP_CELLS) return match; // treat the middle as one changed block
	const w = m + 1;
	const dp = new Int32Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) {
		const xi = x[start + i];
		for (let j = m - 1; j >= 0; j--) {
			dp[i * w + j] =
				xi === y[start + j]
					? (dp[(i + 1) * w + j + 1] as number) + 1
					: Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
		}
	}
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (x[start + i] === y[start + j]) {
			match[start + i] = start + j;
			i++;
			j++;
		} else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number)) {
			i++;
		} else {
			j++;
		}
	}
	return match;
}

function sameRange<T>(a: T[], aStart: number, aEnd: number, b: T[], bStart: number, bEnd: number): boolean {
	if (aEnd - aStart !== bEnd - bStart) return false;
	for (let k = 0; k < aEnd - aStart; k++) if (a[aStart + k] !== b[bStart + k]) return false;
	return true;
}

type Conflict<T> = (base: T[], a: T[], b: T[]) => T[];

function diff3<T>(base: T[], a: T[], b: T[], onConflict: Conflict<T>): T[] {
	const ma = lcsMatch(base, a);
	const mb = lcsMatch(base, b);
	const out: T[] = [];
	let i = 0;
	let ia = 0;
	let ib = 0;
	for (;;) {
		let k = i;
		while (k < base.length && (ma[k] === -1 || mb[k] === -1)) k++;
		const ka = k < base.length ? (ma[k] as number) : a.length;
		const kb = k < base.length ? (mb[k] as number) : b.length;
		const aChanged = !sameRange(base, i, k, a, ia, ka);
		const bChanged = !sameRange(base, i, k, b, ib, kb);
		if (!aChanged && !bChanged) {
			for (let t = i; t < k; t++) out.push(base[t] as T);
		} else if (aChanged && !bChanged) {
			for (let t = ia; t < ka; t++) out.push(a[t] as T);
		} else if (!aChanged && bChanged) {
			for (let t = ib; t < kb; t++) out.push(b[t] as T);
		} else if (sameRange(a, ia, ka, b, ib, kb)) {
			for (let t = ia; t < ka; t++) out.push(a[t] as T);
		} else {
			out.push(...onConflict(base.slice(i, k), a.slice(ia, ka), b.slice(ib, kb)));
		}
		if (k >= base.length) break;
		out.push(base[k] as T);
		i = k + 1;
		ia = ka + 1;
		ib = kb + 1;
	}
	return out;
}

const keepBoth = <T>(_base: T[], a: T[], b: T[]): T[] => [...a, ...b];

function mergeChars(base: string, a: string, b: string): string {
	return diff3(Array.from(base), Array.from(a), Array.from(b), keepBoth).join('');
}

/** Three-way merge of strings. `a` is "ours", `b` is "theirs". */
export function mergeStrings(base: string, a: string, b: string): string {
	if (a === b) return a;
	if (base === a) return b;
	if (base === b) return a;
	const lineConflict: Conflict<string> = (bl, al, bbl) => mergeChars(bl.join('\n'), al.join('\n'), bbl.join('\n')).split('\n');
	return diff3(base.split('\n'), a.split('\n'), b.split('\n'), lineConflict).join('\n');
}
