/**
 * First-run matching (spec 9.6): link remote notes to existing local files
 * without creating duplicates. Pure logic; the engine applies the result.
 */
import { similarity } from './merge';
import { splitFrontmatter } from './frontmatter';
import { basenameOfPath, nameKey, nfc, splitContent, titleToFileName } from './mapping';
import type { NoteData } from './simperium';

export interface LocalCandidate {
	path: string;
	text: string;
}

export interface RemoteCandidate {
	id: string;
	version: number;
	data: NoteData;
}

export type MatchMethod = 'exact' | 'title-line' | 'probable';

export interface Match {
	remote: RemoteCandidate;
	local: LocalCandidate;
	method: MatchMethod;
	similarity: number;
}

export interface FirstRunProposal {
	matches: Match[];
	/** Remote notes with no local file (to be imported). */
	unmatchedRemote: RemoteCandidate[];
	/** Local files with no remote note (to be uploaded). */
	unmatchedLocal: LocalCandidate[];
	/** Share of remote notes without a match, 0..1. */
	missRate: number;
}

export interface FirstRunDecision {
	/** Remote note ids whose probable match the owner confirmed. */
	confirmedProbable: Set<string>;
	/** Apply the title-line fix to files matched by method 2. */
	applyTitleFixes: boolean;
	/** Import unmatched remote notes as new files. */
	importUnmatched: boolean;
	/** Upload unmatched local files as new notes. */
	uploadUnmatched: boolean;
}

/** Normalization for comparisons: NFC, LF, no trailing whitespace per line, no trailing blank lines. */
export function normalizeForMatch(s: string): string {
	return nfc(s)
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((l) => l.replace(/[ \t]+$/, ''))
		.join('\n')
		.replace(/\n+$/, '');
}

/** Body of a local file with the whole frontmatter block removed (valid or not). */
export function bodyWithoutFrontmatter(text: string): string {
	const fm = splitFrontmatter(text);
	if (!fm.hasBlock) return text;
	if (!fm.invalid) return fm.body;
	// invalid block: drop up to and including the closing delimiter
	const lines = text.split('\n');
	for (let i = 1; i < lines.length; i++) {
		const l = (lines[i] ?? '').replace(/\r$/, '');
		if (l === '---' || l === '...') return lines.slice(i + 1).join('\n');
	}
	return text;
}

export function matchFirstRun(remote: RemoteCandidate[], local: LocalCandidate[], minSimilarity = 0.9): FirstRunProposal {
	const byContent = new Map<string, LocalCandidate[]>(); // method 1: basename + "\n" + body
	const byBody = new Map<string, LocalCandidate[]>(); // method 2: body alone
	const byName = new Map<string, LocalCandidate[]>(); // method 3: basename
	const prepared = new Map<LocalCandidate, { body: string; normBody: string; basename: string }>();
	for (const l of local) {
		const basename = nfc(basenameOfPath(l.path));
		const body = bodyWithoutFrontmatter(l.text);
		const normBody = normalizeForMatch(body);
		prepared.set(l, { body, normBody, basename });
		push(byContent, normalizeForMatch(`${basename}\n${body}`), l);
		push(byBody, normBody, l);
		push(byName, nameKey(basename), l);
	}
	const used = new Set<LocalCandidate>();
	const matches: Match[] = [];
	const unmatchedRemote: RemoteCandidate[] = [];
	const live = remote.filter((r) => !r.data.deleted);
	// pass 1 and 2: exact matches first so probable matches cannot steal them
	const pending: RemoteCandidate[] = [];
	for (const r of live) {
		const normContent = normalizeForMatch(r.data.content);
		const m1 = firstFree(byContent.get(normContent), used);
		if (m1) {
			used.add(m1);
			matches.push({ remote: r, local: m1, method: 'exact', similarity: 1 });
			continue;
		}
		const m2 = firstFree(byBody.get(normContent), used);
		if (m2) {
			used.add(m2);
			matches.push({ remote: r, local: m2, method: 'title-line', similarity: 1 });
			continue;
		}
		pending.push(r);
	}
	for (const r of pending) {
		const { title, body } = splitContent(r.data.content);
		const candidates = (byName.get(nameKey(titleToFileName(title))) ?? []).filter((c) => !used.has(c));
		let best: { local: LocalCandidate; sim: number } | null = null;
		const normRemoteBody = normalizeForMatch(body);
		const normRemoteContent = normalizeForMatch(r.data.content);
		for (const c of candidates) {
			const p = prepared.get(c);
			if (!p) continue;
			const sim = Math.max(similarity(p.normBody, normRemoteBody), similarity(p.normBody, normRemoteContent));
			if (sim >= minSimilarity && (!best || sim > best.sim)) best = { local: c, sim };
		}
		if (best) {
			used.add(best.local);
			matches.push({ remote: r, local: best.local, method: 'probable', similarity: best.sim });
		} else {
			unmatchedRemote.push(r);
		}
	}
	const unmatchedLocal = local.filter((l) => !used.has(l));
	const missRate = live.length === 0 ? 0 : unmatchedRemote.length / live.length;
	return { matches, unmatchedRemote, unmatchedLocal, missRate };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
	const arr = m.get(k);
	if (arr) arr.push(v);
	else m.set(k, [v]);
}

function firstFree(list: LocalCandidate[] | undefined, used: Set<LocalCandidate>): LocalCandidate | null {
	if (!list) return null;
	for (const l of list) if (!used.has(l)) return l;
	return null;
}

/** Removes the first body line (the duplicated title) from a file, keeping its frontmatter. */
export function removeTitleLine(text: string): string {
	const fm = splitFrontmatter(text);
	if (fm.hasBlock && !fm.invalid) {
		const i = fm.body.indexOf('\n');
		const body = i === -1 ? '' : fm.body.slice(i + 1);
		return `---${fm.eol}${fm.yaml}${fm.eol}---${fm.eol}${body}`;
	}
	const i = text.indexOf('\n');
	return i === -1 ? '' : text.slice(i + 1);
}
