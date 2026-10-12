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

export function encodeFolderTag(folder: string): string | null {
	const f = nfc(folder).replace(/^\/+|\/+$/g, '');
	if (f.length === 0) return null;
	const enc = f.replace(/%/g, '%25').replace(/,/g, '%2C').replace(/ /g, '_');
	return `${FOLDER_TAG_PREFIX}${enc}`;
}

export function decodeFolderTag(tag: string): string {
	const enc = tag.slice(FOLDER_TAG_PREFIX.length);
	return enc.replace(/_/g, ' ').replace(/%2C/gi, ',').replace(/%25/g, '%');
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
 * Resolves a folder tag to a vault folder path. Prefers an existing folder whose encoded
 * path equals the tag (case-insensitive); otherwise decodes the tag.
 */
export function folderFromTag(tag: string, existingFolders: Iterable<string>): string {
	const want = nameKey(tag);
	for (const f of existingFolders) {
		const enc = encodeFolderTag(f);
		if (enc && nameKey(enc) === want) return f;
	}
	return decodeFolderTag(tag).replace(/^\/+|\/+$/g, '');
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
	const base = nfc(basename);
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
	if (fm.hasBlock && !fm.invalid) {
		const d = fm.data;
		id = typeof d['simplenote-id'] === 'string' && d['simplenote-id'].length > 0 ? d['simplenote-id'] : null;
		tags = tagsFromValue(d.tags).filter((t) => !isFolderTag(t));
		pinned = d.pinned === true;
		const st = d['simplenote-title'];
		storedTitle = typeof st === 'string' ? st : typeof st === 'number' || typeof st === 'boolean' ? String(st) : null;
		const yaml = removeKeys(fm.yaml, MANAGED_KEYS);
		body = joinFrontmatter(yaml, fm.body, fm.eol);
	} else {
		body = fm.body;
		if (fm.invalid) id = idFromRawYaml(fm.yaml);
	}
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
export function noteToFileText(note: Pick<NoteData, 'content' | 'tags' | 'systemTags'>, id: string, basename: string): RenderedFile {
	const { title, body } = splitContent(note.content);
	const { otherTags } = splitTags(note.tags);
	const pinned = note.systemTags.includes('pinned');
	const needsTitleKey = nfc(title) !== nfc(basename);
	const values: Record<string, unknown> = {
		'simplenote-id': id,
		tags: otherTags.length > 0 ? otherTags : undefined,
		pinned: pinned ? true : undefined,
		'simplenote-title': needsTitleKey ? title : undefined,
	};
	const fm = splitFrontmatter(body);
	if (fm.hasBlock && !fm.invalid) {
		const yaml = setKeys(removeKeys(fm.yaml, MANAGED_KEYS), values);
		return { text: joinFrontmatter(yaml, fm.body, fm.eol), title };
	}
	const yaml = setKeys('', values);
	return { text: joinFrontmatter(yaml, body), title };
}

/** Basename a remote note should have, before collision handling. */
export function desiredBasename(content: string): string {
	return titleToFileName(splitContent(content).title);
}

/** Whether a pulled note needs a rename: true when the current basename no longer represents the title. */
export function basenameMatchesTitle(basename: string, title: string): boolean {
	const fn = titleToFileName(title);
	const base = nfc(basename);
	return fn === base || fn === stripCollisionSuffix(base);
}
