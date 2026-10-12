/**
 * Optional translation between Obsidian wikilinks and Simplenote internal links (spec 5.6).
 * Pure functions take a LinkResolver; LinkTranslatorImpl binds them to Obsidian.
 */
import type { App } from 'obsidian';
import type { LinkTranslator } from './sync';

export const SIMPLENOTE_LINK_PREFIX = 'simplenote://note/';

export interface LinkResolver {
	/** Note id for a wikilink target written in `sourcePath`, or null (missing, excluded, or no id yet). */
	resolve(linkpath: string, sourcePath: string): string | null;
	/** Current file name (without .md) of the note with this id, or null when unknown. */
	nameForId(id: string): string | null;
}

const WIKILINK_RE = /(!?)\[\[([^\]|#^]*?)(#[^\]|]*|\^[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
const SN_LINK_RE = /\[([^\]\n]*)\]\(simplenote:\/\/note\/([A-Za-z0-9_-]+)\)/g;

/** Applies `fn` to text outside fenced code blocks. */
function outsideFences(text: string, fn: (chunk: string) => string): string {
	const lines = text.split('\n');
	const out: string[] = [];
	let buf: string[] = [];
	let inFence = false;
	let fence = '';
	const flush = (): void => {
		if (buf.length > 0) out.push(fn(buf.join('\n')));
		buf = [];
	};
	for (const line of lines) {
		const m = /^\s*(`{3,}|~{3,})/.exec(line);
		if (!inFence && m) {
			flush();
			inFence = true;
			fence = m[1] ?? '```';
			out.push(line);
		} else if (inFence) {
			out.push(line);
			if (m && (m[1] ?? '').startsWith(fence[0] ?? '`') && (m[1] ?? '').length >= fence.length) inFence = false;
		} else {
			buf.push(line);
		}
	}
	flush();
	return out.join('\n');
}

/** [[Note]] / [[Note|Alias]] -> [Text](simplenote://note/<id>). Embeds, headings, blocks, and unresolved links stay as text. */
export function translateToRemote(body: string, sourcePath: string, resolver: LinkResolver): string {
	return outsideFences(body, (chunk) =>
		chunk.replace(WIKILINK_RE, (whole, bang: string, target: string, sub: string | undefined, alias: string | undefined) => {
			if (bang || sub || target.trim().length === 0) return whole;
			const id = resolver.resolve(target.trim(), sourcePath);
			if (!id) return whole;
			const text = alias !== undefined && alias.length > 0 ? alias : target;
			if (/[\]\n]/.test(text)) return whole;
			return `[${text}](${SIMPLENOTE_LINK_PREFIX}${id})`;
		}),
	);
}

/** [Text](simplenote://note/<id>) -> [[Name]] or [[Name|Text]]. Unknown ids stay as written. */
export function translateToLocal(body: string, resolver: LinkResolver, onUnknown?: (id: string) => void): string {
	return outsideFences(body, (chunk) =>
		chunk.replace(SN_LINK_RE, (whole, text: string, id: string) => {
			const name = resolver.nameForId(id);
			if (!name) {
				onUnknown?.(id);
				return whole;
			}
			if (/[[\]|]/.test(text)) return whole;
			return text === name ? `[[${name}]]` : `[[${name}|${text}]]`;
		}),
	);
}

/** Obsidian binding: resolves links the way Obsidian does and reads ids from the metadata cache. */
export class LinkTranslatorImpl implements LinkTranslator, LinkResolver {
	constructor(
		private readonly app: App,
		private readonly knownNotes: () => Map<string, string>,
		private readonly isExcluded: (path: string) => boolean,
		private readonly log?: (msg: string) => void,
	) {}

	resolve(linkpath: string, sourcePath: string): string | null {
		const f = this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
		if (!f || f.extension !== 'md' || this.isExcluded(f.path)) return null;
		const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
		const id: unknown = fm?.['simplenote-id'];
		if (typeof id === 'string' && id.length > 0) return id;
		for (const [kid, path] of this.knownNotes()) if (path === f.path) return kid;
		return null;
	}

	nameForId(id: string): string | null {
		const path = this.knownNotes().get(id);
		if (path) return basename(path);
		for (const f of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			if (fm?.['simplenote-id'] === id) return f.basename;
		}
		return null;
	}

	toRemote(body: string, path: string): string {
		return translateToRemote(body, path, this);
	}

	toLocal(body: string): string {
		return translateToLocal(body, this, (id) => this.log?.(`link to unknown note ${id} left as written`));
	}

	backlinks(path: string): string[] {
		const out: string[] = [];
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const [source, targets] of Object.entries(resolved)) if (path in targets) out.push(source);
		return out;
	}
}

function basename(path: string): string {
	const i = path.lastIndexOf('/');
	const name = i === -1 ? path : path.slice(i + 1);
	return name.endsWith('.md') ? name.slice(0, -3) : name;
}
