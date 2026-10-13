/**
 * File <-> note mapping (spec section 5). Pure functions, no Obsidian API.
 */
import { joinFrontmatter, MANAGED_KEYS, removeKeys, setKeys, splitFrontmatter, tagsFromValue } from './frontmatter';
import type { NoteData } from './simperium';

export const FOLDER_TAG_PREFIX = 'obsidian:';
export const MAX_FILENAME_LENGTH = 100;
export const UNTITLED = 'Untitled';

export function nfc(s: string): string {
	return s.normalize('NFC');
}

/** Case-insensitive, NFC-normalized key for name comparisons. */
export function nameKey(s: string): string {
	return nfc(s).toLocaleLowerCase('en-US');
}

// ---------- 5.1 Title ----------

/** File name (without .md) for a note title. Lossy; see `fileToNote` for the simplenote-title key. */
export function titleToFileName(title: string): string {
	let s = nfc(title).replace(/\r$/, '');
	s = s.replace(/[\\/:*?"<>|#^[\]]/g, '');
	// eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
	s = s.replace(/[\u0000-\u001f\u007f]/g, '');
	s = s.replace(/^[.\s]+/, '');
	s = s.replace(/[.\s]+$/, '');
	s = s.trim();
	if (s.length > MAX_FILENAME_LENGTH) s = s.slice(0, MAX_FILENAME_LENGTH).replace(/[.\s]+$/, '');
	if (s.length === 0) return UNTITLED;
	return s;
}

const SUFFIX_RE = / \((\d+)\)$/;
/** `(1)`, `(1)(2)`, ... written directly after the name: iCloud for Windows names a conflicting copy this way. */
const CONFLICT_SUFFIX_RE = /(\S)(\(\d+\))+$/;

/** "Foo(1)" and "Foo(1)(1)" -> "Foo": the conflict suffix iCloud for Windows appends is never part of a title. */
export function stripConflictSuffix(basename: string): string {
	return basename.replace(CONFLICT_SUFFIX_RE, '$1');
}

/** "Foo (2)" -> "Foo". A bare name is returned unchanged. */
export function stripCollisionSuffix(basename: string): string {
	const m = SUFFIX_RE.exec(basename);
	if (!m || Number.parseInt(m[1] ?? '0', 10) < 2) return basename;
	return basename.slice(0, m.index);
}

/** First free basename: desired, then "desired (2)", "desired (3)"... `taken` must compare case-insensitively. */
export function uniqueBasename(desired: string, taken: (basename: string) => boolean): string {
	if (!taken(desired)) return desired;
	for (let n = 2; n < 10_000; n++) {
		const candidate = `${desired} (${n})`;
		if (!taken(candidate)) return candidate;
	}
	return `${desired} (${Date.now()})`;
}

/** Splits Simplenote content into first line and the rest. */
export function splitContent(content: string): { title: string; body: string } {
	const i = content.indexOf('\n');
	if (i === -1) return { title: content, body: '' };
	return { title: content.slice(0, i), body: content.slice(i + 1) };
}

// ---------- 5.3 Folders <-> tags ----------

/**
 * Folder tag for a vault folder: `obsidian:` + path, with `%` -> `%25`, `,` -> `%2C`, space -> `_`.
 * A real `_` is not escaped, so `a_b` and `a b` share one tag (the folder that exists wins when
 * decoding). 0.4.4 escaped `_` as `%5F`; 0.4.5 withdrew that, because a device still on an older
 * version read the new tag as a folder named `my%5Ffolder` and moved every file there. This format
 * must never change again: every version in use has to read every tag the same way.
 */
export function encodeFolderTag(folder: string): string | null {
	const f = nfc(folder).replace(/^\/+|\/+$/g, '');
	if (f.length === 0) return null;
	const enc = f.replace(/%/g, '%25').replace(/,/g, '%2C').replace(/ /g, '_');
	return `${FOLDER_TAG_PREFIX}${enc}`;
}

/** Decodes a folder tag. `%5F` (written by 0.4.4) and `%255F` (0.4.4 re-encoding a `%5F` folder) both mean `_`. */
export function decodeFolderTag(tag: string): string {
	const enc = tag.slice(FOLDER_TAG_PREFIX.length);
	return enc.replace(/_/g, ' ').replace(/%255F/gi, '_').replace(/%5F/gi, '_').replace(/%2C/gi, ',').replace(/%25/g, '%');
}

/**
 * Tag key for change hashes: case-insensitive, and a folder tag's `%5F` / `%255F` (the 0.4.4 forms)
 * count as `_`, so a note still tagged that way compares equal to its file (the tag is rewritten separately).
 */
export function tagKey(tag: string): string {
	const k = nameKey(tag);
	return k.startsWith(FOLDER_TAG_PREFIX) ? k.replace(/%255f/g, '_').replace(/%5f/g, '_') : k;
}

export function isFolderTag(tag: string): boolean {
	return nameKey(tag).startsWith(FOLDER_TAG_PREFIX);
}

/** Folder tags of a note in sort order (first one wins) and the remaining tags. */
export function splitTags(tags: string[]): { folderTags: string[]; otherTags: string[] } {
	const folderTags = tags.filter(isFolderTag).sort();
	const otherTags = tags.filter((t) => !isFolderTag(t));
	return { folderTags, otherTags };
}

/**
 * Resolves a folder tag to a vault folder path. Prefers an existing folder whose encoded path equals
 * the tag (case-insensitive), then an existing folder named like the decoded tag (so the 0.4.4 forms
 * `%5F` and `%255F` land in the folder with the real `_`); otherwise decodes the tag.
 */
export function folderFromTag(tag: string, existingFolders: Iterable<string>): string {
	const want = nameKey(tag);
	const folders = [...existingFolders];
	for (const f of folders) {
		const enc = encodeFolderTag(f);
		if (enc && nameKey(enc) === want) return f;
	}
	const decoded = decodeFolderTag(tag).replace(/^\/+|\/+$/g, '');
	for (const f of folders) if (nameKey(f) === nameKey(decoded)) return f;
	return decoded;
}

export function folderOfPath(path: string): string {
	const i = path.lastIndexOf('/');
	return i === -1 ? '' : path.slice(0, i);
}

export function basenameOfPath(path: string): string {
	const i = path.lastIndexOf('/');
	const name = i === -1 ? path : path.slice(i + 1);
	return name.endsWith('.md') ? name.slice(0, -3) : name;
}

export function joinPath(folder: string, basename: string): string {
	return folder.length === 0 ? `${basename}.md` : `${folder}/${basename}.md`;
}

// ---------- 5.5 Exclusions ----------

export interface ExclusionSettings {
	excludedFolders: string[];
	maxNoteSizeKb: number;
}

export type ExclusionReason = 'not-markdown' | 'dot-folder' | 'excalidraw' | 'excluded-folder' | 'too-large' | 'case-conflict';

export function exclusionReason(path: string, size: number | undefined, settings: ExclusionSettings): ExclusionReason | null {
	if (!path.endsWith('.md')) return 'not-markdown';
	if (path.endsWith('.excalidraw.md')) return 'excalidraw';
	const folder = folderOfPath(path);
	if (folder.split('/').some((seg) => seg.startsWith('.'))) return 'dot-folder';
	const fk = nameKey(folder);
	for (const ex of settings.excludedFolders) {
		const ek = nameKey(ex.replace(/^\/+|\/+$/g, ''));
		if (ek.length === 0) continue;
		if (fk === ek || fk.startsWith(`${ek}/`)) return 'excluded-folder';
	}
	if (size !== undefined && size > settings.maxNoteSizeKb * 1024) return 'too-large';
	return null;
}

// ---------- inline tag line ----------

/** Obsidian inline tags: letters, digits, _, -, /; must contain a non-digit. */
const INLINE_TAG_RE = /^[\p{L}\p{N}_\-/]+$/u;

export function canBeInlineTag(tag: string): boolean {
	return INLINE_TAG_RE.test(tag) && /[^\p{N}]/u.test(tag);
}

/** If the last non-blank line consists only of #tags, returns the tags and the body without that line. */
export function splitTagLine(body: string): { body: string; tags: string[] } {
	const lines = body.split('\n');
	let i = lines.length - 1;
	while (i >= 0 && (lines[i] ?? '').trim().length === 0) i--;
	if (i < 0) return { body, tags: [] };
	const line = (lines[i] ?? '').replace(/\r$/, '').trim();
	const tokens = line.split(/\s+/);
	if (!tokens.every((t) => t.startsWith('#') && t.length > 1 && canBeInlineTag(t.slice(1)))) return { body, tags: [] };
	const tags = tokens.map((t) => t.slice(1));
	// drop the tag line and the single blank line the plugin puts before it (a body that ended with
	// one newline loses it; the plugin's own hash is taken from this converted form, so no push loop)
	let end = i;
	if (end > 0 && (lines[end - 1] ?? '').trim().length === 0) end--;
	return { body: lines.slice(0, end).join('\n'), tags };
}

/** Appends a #tag line to a body, separated by one blank line. */
export function appendTagLine(body: string, tags: string[]): string {
	if (tags.length === 0) return body;
	const line = tags.map((t) => `#${t}`).join(' ');
	if (body.length === 0) return line;
	return body.endsWith('\n') ? `${body}\n${line}` : `${body}\n\n${line}`;
}

// ---------- file -> note ----------

export interface LocalNote {
	id: string | null;
	/** First line to push. */
	title: string;
	/** Text after the plugin-managed keys were removed. */
	body: string;
	/** `title + "\n" + body` */
	content: string;
	/** Non-folder tags from frontmatter. */
	tags: string[];
	pinned: boolean;
	/** True when the file carries a simplenote-title key that is still valid. */
	usesTitleKey: boolean;
	invalidFrontmatter: boolean;
}

/** Title to push for a file: the stored simplenote-title while it still maps to the basename, else the basename. */
export function effectiveTitle(basename: string, storedTitle: string | null): { title: string; usesTitleKey: boolean } {
	const base = stripConflictSuffix(nfc(basename));
	if (storedTitle !== null) {
		const fn = titleToFileName(storedTitle);
		if (fn === base || fn === stripCollisionSuffix(base)) return { title: nfc(storedTitle), usesTitleKey: true };
	}
	return { title: base, usesTitleKey: false };
}

export function fileToNote(text: string, basename: string): LocalNote {
	const fm = splitFrontmatter(text);
	let body: string;
	let id: string | null = null;
	let tags: string[] = [];
	let pinned = false;
	let storedTitle: string | null = null;
	const tagLine = splitTagLine(fm.body);
	if (fm.hasBlock && !fm.invalid) {
		const d = fm.data;
		id = typeof d['simplenote-id'] === 'string' && d['simplenote-id'].length > 0 ? d['simplenote-id'] : null;
		tags = tagsFromValue(d.tags).filter((t) => !isFolderTag(t));
		pinned = d.pinned === true;
		const st = d['simplenote-title'];
		storedTitle = typeof st === 'string' ? st : typeof st === 'number' || typeof st === 'boolean' ? String(st) : null;
		const yaml = removeKeys(fm.yaml, MANAGED_KEYS);
		body = joinFrontmatter(yaml, tagLine.body, fm.eol);
	} else {
		body = tagLine.body;
		if (fm.invalid) id = idFromRawYaml(fm.yaml);
	}
	for (const t of tagLine.tags) if (!tags.some((x) => nameKey(x) === nameKey(t))) tags.push(t);
	const { title, usesTitleKey } = effectiveTitle(basename, storedTitle);
	return { id, title, body, content: `${title}\n${body}`, tags, pinned, usesTitleKey, invalidFrontmatter: fm.invalid };
}

/** Fallback for invalid YAML: find a simplenote-id line by regex so the note keeps its identity. */
export function idFromRawYaml(yaml: string): string | null {
	const m = /^["']?simplenote-id["']?\s*:\s*["']?([^\s"']+)["']?\s*$/m.exec(yaml);
	return m?.[1] ?? null;
}

// ---------- note -> file ----------

export interface RenderedFile {
	text: string;
	title: string;
}

/**
 * Builds file text for a remote note at a given basename. Plugin keys are merged into a
 * frontmatter block at the start of the body when there is a valid one; otherwise a new block is added.
 */
export type TagStyle = 'inline' | 'property';

export function noteToFileText(
	note: Pick<NoteData, 'content' | 'tags' | 'systemTags'>,
	id: string,
	basename: string,
	tagStyle: TagStyle = 'inline',
	/** false when pinned is represented by an Obsidian bookmark instead of the property. */
	pinnedAsProperty = true,
): RenderedFile {
	const { title, body: rawBody } = splitContent(note.content);
	const { otherTags } = splitTags(note.tags);
	const pinned = pinnedAsProperty && note.systemTags.includes('pinned');
	const needsTitleKey = nfc(title) !== nfc(basename);
	const inlineTags = tagStyle === 'inline' ? otherTags.filter(canBeInlineTag) : [];
	const propertyTags = otherTags.filter((t) => !inlineTags.includes(t));
	const values: Record<string, unknown> = {
		'simplenote-id': id,
		tags: propertyTags.length > 0 ? propertyTags : undefined,
		pinned: pinned ? true : undefined,
		'simplenote-title': needsTitleKey ? title : undefined,
	};
	const fm = splitFrontmatter(rawBody);
	if (fm.hasBlock && !fm.invalid) {
		const yaml = setKeys(removeKeys(fm.yaml, MANAGED_KEYS), values);
		return { text: joinFrontmatter(yaml, appendTagLine(fm.body, inlineTags), fm.eol), title };
	}
	const yaml = setKeys('', values);
	return { text: joinFrontmatter(yaml, appendTagLine(rawBody, inlineTags)), title };
}

/** Basename a remote note should have, before collision handling. */
export function desiredBasename(content: string): string {
	return titleToFileName(splitContent(content).title);
}

/** Whether a pulled note needs a rename: true when the current basename no longer represents the title. */
export function basenameMatchesTitle(basename: string, title: string): boolean {
	const fn = titleToFileName(title);
	const base = stripConflictSuffix(nfc(basename));
	return fn === base || fn === stripCollisionSuffix(base);
}
