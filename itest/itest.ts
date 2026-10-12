/**
 * Integration test against a DEDICATED test Simplenote account.
 * Env: SN_TEST_USER, SN_TEST_PASS. Optional: SN_APP_ID, SN_API_KEY.
 * Creates notes tagged `obsidian-sync-itest`, exercises the API, prints findings
 * for NOTES.md, and permanently deletes only the notes it created.
 */
import { SimperiumClient, type HttpFn, type NoteData } from '../src/simperium';
import { computeCcid, newNoteId, noteHash } from '../src/hash';

const APP_ID = process.env.SN_APP_ID ?? 'chalk-bump-f49';
const API_KEY = process.env.SN_API_KEY ?? 'c8c2b86337154cdabc989b23e30c6bf4';
const USER = process.env.SN_TEST_USER;
const PASS = process.env.SN_TEST_PASS;
const MARKER_TAG = 'obsidian-sync-itest';

const http: HttpFn = async (req) => {
	const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => {
		headers[k] = v;
	});
	return { status: res.status, headers, text: await res.text() };
};

const findings: string[] = [];
function note(msg: string): void {
	findings.push(msg);
	console.log(`  → ${msg}`);
}
function step(msg: string): void {
	console.log(`\n== ${msg}`);
}
function nowSec(): number {
	return Date.now() / 1000;
}

async function rawRequest(client: SimperiumClient, token: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: string) {
	void client;
	return http({
		url: `https://api.simperium.com/1/${APP_ID}/note${path}`,
		method,
		headers: { 'X-Simperium-Token': token, 'Content-Type': 'application/json' },
		body,
	});
}

async function main(): Promise<void> {
	if (!USER || !PASS) {
		console.error('Set SN_TEST_USER and SN_TEST_PASS (a dedicated test account).');
		process.exit(2);
	}
	const created: string[] = [];
	const client = new SimperiumClient({ appId: APP_ID, apiKey: API_KEY, http, log: (m) => console.log(`    [client] ${m}`) });
	const client2 = new SimperiumClient({ appId: APP_ID, apiKey: API_KEY, http });
	let failures = 0;
	const check = (cond: boolean, msg: string): void => {
		if (cond) console.log(`  ok   ${msg}`);
		else {
			failures++;
			console.log(`  FAIL ${msg}`);
		}
	};

	try {
		step('Log in (two separate logins)');
		const token1 = await client.authorize(USER, PASS);
		const token2 = await client2.authorize(USER, PASS);
		check(token1.length > 0 && token2.length > 0, 'got two tokens');
		note(`Two logins give ${token1 === token2 ? 'the SAME' : 'different'} tokens.`);

		step('List notes (full index with pagination)');
		const pages: number[] = [];
		const full = await client.fetchIndex(undefined, (p) => pages.push(p.index.length));
		check(full.current.length > 0, `index has ${full.entries.length} notes, cursor=${full.current}, pages=${pages.join('+')}`);
		note(`Full index: ${full.entries.length} notes in ${pages.length} page(s). Cursor format example: ${full.current}`);
		const stale = full.entries.filter((e) => e.d?.tags.includes(MARKER_TAG));
		if (stale.length > 0) {
			console.log(`  cleaning ${stale.length} leftover itest notes`);
			for (const e of stale) await rawRequest(client, token1, 'DELETE', `/i/${e.id}`);
		}

		step('Create a note');
		const id = newNoteId();
		created.push(id);
		const base: Partial<NoteData> = {
			content: 'itest note\nline one\nline two',
			tags: [MARKER_TAG],
			systemTags: ['markdown'],
			deleted: false,
			creationDate: nowSec(),
			modificationDate: nowSec(),
			shareURL: '',
			publishURL: '',
		};
		const c1 = await client.postNote(id, base);
		check(c1.outcome === 'updated' && c1.version === 1, `created version ${c1.version}`);
		const got = await client.getNote(id);
		check(got?.data.content === base.content, 'get returns the content');

		step('Edit with base version');
		const e1 = await client.postNote(id, { content: 'itest note\nline one edited\nline two', modificationDate: nowSec() }, { baseVersion: 1 });
		check(e1.outcome === 'updated' && e1.version === 2, `edit gave version ${e1.version}`);

		step('412 on an unchanged POST');
		const same = await client.postNote(id, { content: 'itest note\nline one edited\nline two' }, { baseVersion: 2 });
		check(same.outcome === 'unchanged', `unchanged POST reported as '${same.outcome}' (version ${same.version})`);
		note(`Unchanged POST: outcome=${same.outcome}, version stays ${same.version}.`);

		step('Conflict edit from a stale base version (server merge?)');
		const conflictRes = await rawRequest(
			client,
			token2,
			'POST',
			`/i/${id}/v/1?response=1`,
			JSON.stringify({ content: 'itest note\nline one\nline two edited', modificationDate: nowSec() }),
		);
		const after = await client.getNote(id);
		note(`Stale-base POST (/v/1 when current was 2): HTTP ${conflictRes.status}; resulting content = ${JSON.stringify(after?.data.content)}, version ${after?.version}`);
		if (after?.data.content === 'itest note\nline one edited\nline two edited') {
			note('SERVER MERGE: confirmed. The server merged both edits.');
		} else if (after?.data.content === 'itest note\nline one\nline two edited') {
			note('SERVER MERGE: NOT merged; the stale write overwrote the newer version (last write wins).');
		} else {
			note('SERVER MERGE: refused or unexpected; plugin falls back to a local 3-way merge.');
		}

		step('ccid deduplication from two separate logins');
		const cur = await client.getNote(id);
		const v0 = cur?.version ?? 0;
		const newContent = `${cur?.data.content ?? ''}\nccid line`;
		const h = await noteHash(newContent, [MARKER_TAG], false);
		const ccid = await computeCcid(id, v0, h);
		const p1 = await rawRequest(client, token1, 'POST', `/i/${id}/v/${v0}?response=1&ccid=${ccid}`, JSON.stringify({ content: newContent }));
		const p2 = await rawRequest(client, token2, 'POST', `/i/${id}/v/${v0}?response=1&ccid=${ccid}`, JSON.stringify({ content: newContent }));
		const afterCcid = await client.getNote(id);
		note(`Same ccid twice from two logins: HTTP ${p1.status} then ${p2.status}; version ${v0} → ${afterCcid?.version}; content ${afterCcid?.data.content === newContent ? 'as sent (applied once)' : 'DIFFERENT: ' + JSON.stringify(afterCcid?.data.content)}`);
		check(afterCcid?.data.content === newContent, 'ccid: change applied exactly once (content equals the sent content)');
		// Different ccid, same content from a stale base: does the server dedupe by content (412) or append twice?
		const p3 = await rawRequest(client, token2, 'POST', `/i/${id}/v/${v0}?response=1&ccid=${ccid.slice(0, 31)}x`, JSON.stringify({ content: newContent }));
		const afterP3 = await client.getNote(id);
		note(`Same content, DIFFERENT ccid, stale base: HTTP ${p3.status}; content ${afterP3?.data.content === newContent ? 'unchanged (safe)' : 'CHANGED: ' + JSON.stringify(afterP3?.data.content)}`);

		step('Tag characters and case');
		const tagId = newNoteId();
		created.push(tagId);
		const tags = [MARKER_TAG, 'obsidian:Projects/Client_Work', 'obsidian:a-b', 'obsidian:x&y', 'obsidian:café', 'obsidian:emoji😀', 'obsidian:Case', 'obsidian:case', 'obsidian:with space', 'obsidian:comma,here', 'obsidian:colon:more'];
		await client.postNote(tagId, { ...base, content: 'itest tags\nbody', tags });
		const tagNote = await client.getNote(tagId);
		note(`Tags sent: ${JSON.stringify(tags)}`);
		note(`Tags stored: ${JSON.stringify(tagNote?.data.tags)}`);
		const stored = tagNote?.data.tags ?? [];
		note(`Case: ${stored.includes('obsidian:Case') && stored.includes('obsidian:case') ? 'both kept (case-sensitive)' : 'collapsed or changed (treat as case-insensitive)'}`);
		note('Check the Simplenote website now: which of these tags show, and how? (The API may store what the UI cannot show.)');

		step('Maximum note size');
		const sizeId = newNoteId();
		created.push(sizeId);
		await client.postNote(sizeId, { ...base, content: 'itest size\n' });
		let largest = 0;
		for (const kb of [100, 200, 500, 1000, 2000, 5000]) {
			const content = `itest size\n${'x'.repeat(kb * 1024 - 11)}`;
			const r = await rawRequest(client, token1, 'POST', `/i/${sizeId}?response=0`, JSON.stringify({ content }));
			const ok = r.status === 200 || r.status === 412;
			console.log(`  ${kb} KB → HTTP ${r.status}`);
			if (ok) largest = kb;
			else break;
		}
		note(`Largest accepted note content: ${largest} KB (next size tested was rejected).`);

		step('Trash (deleted: true) and index since cursor');
		const beforeTrash = await client.fetchIndex();
		const t = await client.postNote(id, { deleted: true, modificationDate: nowSec() });
		check(t.data.deleted === true, 'trash flag set');
		const changes = await client.fetchIndex(beforeTrash.current);
		check(changes.entries.some((e) => e.id === id && e.d?.deleted === true), `since-cursor index lists the trashed note (${changes.entries.length} change(s))`);
		note(`Trashed notes appear in the since index with deleted=true and data present: ${changes.entries.some((e) => e.id === id && e.d !== undefined)}`);

		step('Permanent delete and since cursor');
		const beforeDel = await client.fetchIndex();
		const d = await rawRequest(client, token1, 'DELETE', `/i/${id}`);
		check(d.status === 200, `DELETE → HTTP ${d.status}`);
		created.splice(created.indexOf(id), 1);
		const afterDel = await client.fetchIndex(beforeDel.current);
		const delEntry = afterDel.entries.find((e) => e.id === id);
		note(`After permanent delete, since index: ${delEntry ? `entry present, d ${delEntry.d ? 'present' : 'ABSENT'}, v=${delEntry.v}` : 'no entry'}; GET → ${(await client.getNote(id)) ? 'found' : '404'}`);
	} finally {
		step('Cleanup');
		const token = (client as unknown as { token?: string }).token ?? '';
		for (const cid of created) {
			const r = await rawRequest(client, token, 'DELETE', `/i/${cid}`);
			console.log(`  deleted ${cid} → HTTP ${r.status}`);
		}
	}

	console.log('\n==== Findings for NOTES.md ====');
	for (const f of findings) console.log(`- ${f}`);
	console.log(failures === 0 ? '\nITEST PASSED' : `\nITEST FAILED (${failures} check(s))`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
	console.error(e);
	process.exit(1);
});
