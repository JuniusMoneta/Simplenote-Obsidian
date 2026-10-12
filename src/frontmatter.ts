/**
 * Frontmatter handling. Parsing goes through Obsidian's parseYaml (js-yaml);
 * edits are line based so that user keys keep their exact text.
 */
import { parseYaml } from 'obsidian';

export const MANAGED_KEYS = ['simplenote-id', 'tags', 'pinned', 'simplenote-title'] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number];

export interface FrontmatterSplit {
	/** YAML text between the delimiters (without them). Empty string when there is no block. */
	yaml: string;
	/** Whether a syntactically delimited block exists at the start of the file. */
	hasBlock: boolean;
	/** True when the block exists but is not valid YAML (then `body` is the whole text). */
	invalid: boolean;
	/** Parsed mapping, or {} when there is no block or it is invalid. */
	data: Record<string, unknown>;
	/** Text after the block, or the whole text when there is no valid block. */
	body: string;
	/** Line ending used by the block (`\n` or `\r\n`). */
	eol: string;
}

const OPEN_RE = /^---(\r?\n)/;

/** Splits a file into frontmatter and body. An invalid block is reported and treated as body. */
export function splitFrontmatter(text: string): FrontmatterSplit {
	const none: FrontmatterSplit = { yaml: '', hasBlock: false, invalid: false, data: {}, body: text, eol: '\n' };
	const open = OPEN_RE.exec(text);
	if (!open) return none;
	const eol = open[1] ?? '\n';
	const lines = text.split('\n');
	let closeIdx = -1;
	for (let i = 1; i < lines.length; i++) {
		const l = (lines[i] ?? '').replace(/\r$/, '');
		if (l === '---' || l === '...') {
			closeIdx = i;
			break;
		}
	}
	if (closeIdx === -1) return none;
	const yaml = lines.slice(1, closeIdx).join('\n');
	const body = lines.slice(closeIdx + 1).join('\n');
	let parsed: unknown;
	try {
		parsed = parseYaml(yaml.replace(/\r/g, ''));
	} catch {
		return { yaml, hasBlock: true, invalid: true, data: {}, body: text, eol };
	}
	if (parsed === null || parsed === undefined) parsed = {};
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { yaml, hasBlock: true, invalid: true, data: {}, body: text, eol };
	}
	return { yaml, hasBlock: true, invalid: false, data: parsed as Record<string, unknown>, body, eol };
}

const KEY_RE = /^(?:"([^"]+)"|'([^']+)'|([^\s"'#\-?:[\]{}][^:]*?))\s*:(?:\s|$)/;

/** Name of the top-level key that starts on this line, or null. */
export function keyOfLine(line: string): string | null {
	const m = KEY_RE.exec(line.replace(/\r$/, ''));
	if (!m) return null;
	return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

interface KeySpan {
	key: string;
	start: number;
	end: number; // exclusive line index
}

function keySpans(lines: string[]): KeySpan[] {
	const spans: KeySpan[] = [];
	for (let i = 0; i < lines.length; i++) {
		const k = keyOfLine(lines[i] ?? '');
		if (k !== null) {
			const prev = spans[spans.length - 1];
			if (prev) prev.end = i;
			spans.push({ key: k, start: i, end: lines.length });
		}
	}
	return spans;
}

/** Removes top-level keys (with their continuation lines) from YAML text. */
export function removeKeys(yaml: string, keys: readonly string[]): string {
	if (yaml.length === 0) return yaml;
	const lines = yaml.split('\n');
	const drop = new Set<number>();
	for (const span of keySpans(lines)) {
		if (keys.includes(span.key)) for (let i = span.start; i < span.end; i++) drop.add(i);
	}
	const kept = lines.filter((_, i) => !drop.has(i));
	// drop trailing blank lines left behind
	while (kept.length > 0 && (kept[kept.length - 1] ?? '').trim() === '') kept.pop();
	return kept.join('\n');
}

const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~', '']);

/** Serializes a string scalar, plain when safe, otherwise JSON-quoted. */
export function yamlScalar(s: string): string {
	const plain = /^[A-Za-z0-9À-￿][A-Za-z0-9À-￿ _.()/'+]*$/.test(s) && !RESERVED.has(s.toLowerCase()) && !/^\d/.test(s) && !/\s$/.test(s);
	return plain ? s : JSON.stringify(s);
}

export function serializeKey(key: string, value: unknown): string[] {
	if (Array.isArray(value)) {
		if (value.length === 0) return [`${key}: []`];
		return [`${key}:`, ...value.map((v) => `  - ${yamlScalar(String(v))}`)];
	}
	if (typeof value === 'boolean' || typeof value === 'number') return [`${key}: ${String(value)}`];
	return [`${key}: ${yamlScalar(String(value))}`];
}

/** Sets keys in YAML text: replaces existing spans in place, appends missing ones. `undefined` removes a key. */
export function setKeys(yaml: string, values: Record<string, unknown>): string {
	let lines = yaml.length === 0 ? [] : yaml.split('\n');
	const spans = keySpans(lines);
	const replaced = new Set<string>();
	// replace from the end so indices stay valid
	for (const span of [...spans].reverse()) {
		if (!(span.key in values)) continue;
		const v = values[span.key];
		const repl = v === undefined ? [] : serializeKey(span.key, v);
		lines.splice(span.start, span.end - span.start, ...repl);
		replaced.add(span.key);
	}
	while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
	for (const [k, v] of Object.entries(values)) {
		if (replaced.has(k) || v === undefined) continue;
		lines = [...lines, ...serializeKey(k, v)];
	}
	return lines.join('\n');
}

/** Builds file text from YAML text and body. An empty YAML block is omitted. */
export function joinFrontmatter(yaml: string, body: string, eol = '\n'): string {
	if (yaml.trim().length === 0) return body;
	return `---${eol}${yaml}${eol}---${eol}${body}`;
}

/** Reads a tag list from a frontmatter value (array, or comma/space separated string). */
export function tagsFromValue(v: unknown): string[] {
	let raw: string[] = [];
	if (Array.isArray(v)) raw = v.map((x) => String(x));
	else if (typeof v === 'string') raw = v.split(/[,\s]+/);
	else if (typeof v === 'number') raw = [String(v)];
	const out: string[] = [];
	for (const t of raw) {
		const s = t.trim().replace(/^#/, '');
		if (s.length > 0 && !out.includes(s)) out.push(s);
	}
	return out;
}
