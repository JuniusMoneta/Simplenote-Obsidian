import { describe, expect, it } from 'vitest';
import { translateToLocal, translateToRemote, type LinkResolver } from '../src/links';
import { basenameOfPath, nameKey } from '../src/mapping';
import { NEW_FILE_WAIT_MS, type LinkTranslator } from '../src/sync';
import { splitFrontmatter } from '../src/frontmatter';
import { makeHarness, type Harness } from './harness';
import type { MemoryVault } from './memory-vault';

/** Translator for the memory vault: resolves [[Name]] by basename (first match), ids from frontmatter. */
function memoryTranslator(vault: MemoryVault, known: () => Map<string, string>, isExcluded: (p: string) => boolean = () => false): LinkTranslator & LinkResolver {
	const idOf = (path: string): string | null => {
		const fm = splitFrontmatter(vault.get(path) ?? '');
		const id = fm.data['simplenote-id'];
		return typeof id === 'string' ? id : null;
	};
	const t: LinkTranslator & LinkResolver = {
		resolve(linkpath) {
			const want = nameKey(linkpath.endsWith('.md') ? linkpath.slice(0, -3) : linkpath);
			const paths = vault.paths().filter((p) => nameKey(basenameOfPath(p)) === want || nameKey(p.replace(/\.md$/, '')) === want);
			const p = paths[0];
			if (!p || isExcluded(p)) return null;
			return idOf(p);
		},
		nameForId(id) {
			for (const p of vault.paths()) if (idOf(p) === id) return basenameOfPath(p);
			const planned = known().get(id);
			return planned ? basenameOfPath(planned) : null;
		},
		toRemote: (body, path) => translateToRemote(body, path, t),
		toLocal: (body) => translateToLocal(body, t),
		backlinks(path) {
			const name = basenameOfPath(path);
			return vault.paths().filter((p) => p !== path && (vault.get(p) ?? '').includes(`[[${name}`));
		},
	};
	return t;
}

async function linkedHarness(): Promise<Harness> {
	const h = await makeHarness({ settings: { translateLinks: true } });
	(h.engine as unknown as { deps: { translator: LinkTranslator } }).deps.translator = memoryTranslator(h.vault, () => h.engine.knownNotes());
	return h;
}

describe('link translation through the engine (M7)', () => {
	it('pushes wikilinks as Simplenote links and pulls them back', async () => {
		const h = await linkedHarness();
		h.server.seed('t', { content: 'Target\nbody' });
		h.server.seed('s', { content: 'Source\nsee [Target](simplenote://note/t) and [alias](simplenote://note/t) and [x](simplenote://note/unknown)' });
		await h.engine.sync();
		expect(h.vault.get('Source.md')).toBe('---\nsimplenote-id: s\n---\nsee [[Target]] and [[Target|alias]] and [x](simplenote://note/unknown)');
		// no push loop: the pulled file converts back to exactly the remote content
		const r = await h.engine.sync();
		expect(r.pushed).toBe(0);
		h.vault.put('Source.md', '---\nsimplenote-id: s\n---\nsee [[Target]] and [[Target|alias]] and [[Missing]] and ![[Target]]');
		await h.engine.sync();
		expect(h.server.get('s')?.content).toBe('Source\nsee [Target](simplenote://note/t) and [alias](simplenote://note/t) and [[Missing]] and ![[Target]]');
	});

	it('re-pushes linking notes once the target gets its id, counted as one change', async () => {
		const h = await linkedHarness();
		h.server.seed('s', { content: 'Source\nsee [[New note]]' });
		await h.engine.sync();
		expect(h.server.get('s')?.content).toBe('Source\nsee [[New note]]');
		h.vault.put('New note.md', 'fresh');
		await h.engine.sync();
		h.advance(NEW_FILE_WAIT_MS + 1);
		await h.engine.sync();
		const id = h.store.load().notes;
		const newId = Object.keys(id).find((k) => k !== 's') ?? '';
		expect(newId).not.toBe('');
		const r = await h.engine.sync();
		expect(r.pushed).toBe(1);
		expect(h.server.get('s')?.content).toBe(`Source\nsee [New note](simplenote://note/${newId})`);
	});

	it('two devices produce identical content (no loop)', async () => {
		const h1 = await linkedHarness();
		h1.server.seed('t', { content: 'Target\nbody' });
		h1.server.seed('s', { content: 'Source\nsee [Target](simplenote://note/t)' });
		await h1.engine.sync();
		const h2 = await h1.newDevice();
		(h2.engine as unknown as { deps: { translator: LinkTranslator } }).deps.translator = memoryTranslator(h2.vault, () => h2.engine.knownNotes());
		await h2.engine.sync();
		const v = h1.server.version('s');
		for (let i = 0; i < 3; i++) {
			await h1.engine.sync();
			await h2.engine.sync();
		}
		expect(h1.server.version('s')).toBe(v);
		expect(h1.vault.get('Source.md')).toBe('---\nsimplenote-id: s\n---\nsee [[Target]]');
	});

	it('links to excluded notes stay as text', async () => {
		const h = await makeHarness({ settings: { translateLinks: true, excludedFolders: ['Private'] } });
		(h.engine as unknown as { deps: { translator: LinkTranslator } }).deps.translator = memoryTranslator(h.vault, () => h.engine.knownNotes(), (p) => p.startsWith('Private/'));
		h.vault.put('Private/Secret.md', '---\nsimplenote-id: sec\n---\nx');
		h.server.seed('s', { content: 'Source\nsee [[Secret]]' });
		await h.engine.sync();
		h.vault.put('Source.md', '---\nsimplenote-id: s\n---\nsee [[Secret]] now');
		await h.engine.sync();
		expect(h.server.get('s')?.content).toBe('Source\nsee [[Secret]] now');
	});
});
