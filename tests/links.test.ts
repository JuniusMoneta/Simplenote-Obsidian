import { describe, expect, it } from 'vitest';
import { translateToLocal, translateToRemote, type LinkResolver } from '../src/links';

const resolver: LinkResolver = {
	resolve: (target) => ({ Note: 'id1', 'Folder/Other': 'id2', Other: 'id2', 'No id yet': null, Excluded: null })[target] ?? null,
	nameForId: (id) => ({ id1: 'Note', id2: 'Other' })[id] ?? null,
};

describe('link translation', () => {
	it('translates wikilinks to Simplenote links and back', () => {
		const local = 'See [[Note]] and [[Note|the note]] and [[Folder/Other]].';
		const remote = translateToRemote(local, 'x.md', resolver);
		expect(remote).toBe('See [Note](simplenote://note/id1) and [the note](simplenote://note/id1) and [Folder/Other](simplenote://note/id2).');
		expect(translateToLocal(remote, resolver)).toBe('See [[Note]] and [[Note|the note]] and [[Other|Folder/Other]].');
	});
	it('leaves embeds, headings, blocks, missing, excluded, and id-less notes as text', () => {
		const local = '![[photo.png]] ![[Note]] [[Note#Heading]] [[Note^block]] [[Missing]] [[Excluded]] [[No id yet]] [[]]';
		expect(translateToRemote(local, 'x.md', resolver)).toBe(local);
	});
	it('leaves links to unknown ids as written and reports them', () => {
		const unknown: string[] = [];
		const remote = 'see [Text](simplenote://note/deadbeef)';
		expect(translateToLocal(remote, resolver, (id) => unknown.push(id))).toBe(remote);
		expect(unknown).toEqual(['deadbeef']);
	});
	it('does not touch fenced code blocks', () => {
		const local = 'a [[Note]]\n```\n[[Note]] in code\n```\nb [[Note]]\n~~~md\n[[Note]]\n~~~';
		const remote = translateToRemote(local, 'x.md', resolver);
		expect(remote).toBe('a [Note](simplenote://note/id1)\n```\n[[Note]] in code\n```\nb [Note](simplenote://note/id1)\n~~~md\n[[Note]]\n~~~');
		expect(translateToLocal(remote, resolver)).toBe(local);
	});
	it('is deterministic and idempotent', () => {
		const local = 'x [[Note]] y [[Other|alias]] z';
		const r1 = translateToRemote(local, 'a.md', resolver);
		const r2 = translateToRemote(local, 'b/c.md', resolver);
		expect(r1).toBe(r2);
		expect(translateToRemote(translateToLocal(r1, resolver), 'a.md', resolver)).toBe(r1);
	});
	it('aliases with brackets are left alone', () => {
		expect(translateToRemote('[[Note|a]b]]', 'x.md', resolver)).toBe('[[Note|a]b]]');
	});
});
