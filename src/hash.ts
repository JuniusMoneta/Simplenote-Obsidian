/** Hash and ID helpers. Browser/WebCrypto only; no Node APIs. */

export async function sha256Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest('SHA-256', data);
	const bytes = new Uint8Array(digest);
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

export function newNoteId(): string {
	return crypto.randomUUID().replace(/-/g, '');
}

/** Hash of a Simplenote note as synced: content plus sorted tags plus pinned flag. */
export async function noteHash(content: string, tags: string[], pinned: boolean): Promise<string> {
	const t = [...tags].sort().join('\u0001');
	return sha256Hex(`${content}\u0000${t}\u0000${pinned ? 'pinned' : ''}`);
}

/** Deterministic change id: two devices pushing the same edit from the same base send the same ccid. */
export async function computeCcid(noteId: string, baseVersion: number | undefined, contentHash: string): Promise<string> {
	const h = await sha256Hex(`${noteId}${baseVersion ?? 0}${contentHash}`);
	return h.slice(0, 32);
}
