# NOTES

Working notes on the Simplenote (Simperium) API and the decisions taken from them.

## Environment of the build session

The plugin was built in a sandbox that cannot reach `simperium.com`, and no test-account
credentials were available. All checks marked **PENDING** below must be run by the owner:

```
SN_TEST_USER=... SN_TEST_PASS=... npm run itest
```

The script prints a "Findings for NOTES.md" block. Paste it into the sections below.

## Credentials

- `APP_ID = chalk-bump-f49`
- `API_KEY = c8c2b86337154cdabc989b23e30c6bf4` (base64 `YzhjMmI4NjMzNzE1NGNkYWJjOTg5YjIzZTMwYzZiZjQ=` in `simplenote.py` 2.1.4).
  This is the public client key of the official Simplenote apps. It cannot be hidden.

## API facts confirmed from documentation and the Simplenote Electron source

- `412` on a POST = "empty change": the object was not modified. The plugin treats it as success.
- `ccid`: "If you need to resubmit this operation, you should send the same ccid to prevent duplicate
  operations." In the Simperium protocol a duplicate change answers `409` (duplicate change). The
  client treats a 409/405/440 as "conflict": it re-reads the note and, if the content already equals
  what it wanted to send, counts the push as done; otherwise it merges locally and retries.
- Index: `GET note/index?limit=N&data=true[&since=cursor][&mark=mark]` → `{index:[{id,v,d}], current, mark?}`.
  `mark` is present only while more pages remain. `current` is the next `since` cursor.
  An unknown `since` cursor must make the client fall back to a full index (the WebSocket protocol
  answers `cv:?`; over HTTP the plugin treats any 4xx other than 401 the same way).
- Partial updates: a POST without `replace=1` changes only the fields sent.
- Older versions: `GET note/i/{id}/v/{n}` returns a historical version (used for the local-merge fallback).
- Tags (Simplenote Electron `lib/utils/tag-hash.ts`): tag identity is
  `encodeURIComponent(name.normalize('NFC').toLocaleLowerCase('en-US'))` → **tags are
  case-insensitive** and NFC-normalized. The encoded hash may be at most 256 characters.
  The web tag input strips whitespace and commas (`/[\s,]/`), so tags with spaces or commas
  cannot be typed on the website even if the API stores them.
- Note size: the Simplenote Electron importer rejects files over 1,000,000 bytes. The default
  maximum note size of the plugin is 200 KB, well below that.

## Decisions

### Folder tag encoding

`obsidian:` + folder path, with:

- space → `_`
- `%` → `%25`, `,` → `%2C` (commas break the web tag input)
- everything else (including `/`, `:`, `-`, `&`, accented letters, emoji) unchanged.

Decoding reverses the three rules. Because `_` is ambiguous, decoding first looks for an existing
vault folder whose encoded path equals the tag (compared case-insensitively and NFC-normalized).
Two vault folders that differ only in case map to the same tag: the second one is skipped with a warning.

### Change hash and ccid

`contentHash = sha256(content + "\0" + sortedTags.join("\x01") + "\0" + ("pinned"|""))`.
`ccid = sha256(noteId + baseVersion + contentHash).slice(0, 32)`.

### Server merge fallback

The plugin pushes with `/v/{baseVersion}`. If the server answers with the merged note, that is written back.
If the server refuses (405/409/440), the plugin fetches the base version from `/v/{base}`, merges locally
(`src/merge.ts`: line-level diff3, character-level inside conflicting regions, never drops text) and
posts again against the current version.

## Live check results (`npm run itest`, 2026-10-12, dedicated test account)

- **Server-side merge: confirmed.** A POST to `/v/1` while the server was at v2 answered HTTP 200 with
  both edits merged (`line one edited` + `line two edited`), new version 3.
- **ccid deduplication: NOT provided over HTTP.** The same change with the same ccid sent twice from two
  logins answered 200 both times and was applied twice (version 3 → 5, the appended line appears twice).
  The server applies a stale-base POST as a patch, so an identical edit arriving from two devices would be
  duplicated. Consequences for the plugin (implemented):
  1. Every sync pulls first; a local edit whose content already equals the server copy is adopted, not pushed.
  2. Immediately before each push the plugin re-reads the note. If the server version moved and the server
     content equals what the plugin wants to push, it adopts that version and skips the push. If the content
     differs, the push goes ahead against the old base and the server merges.
  3. The deterministic ccid is still sent (harmless) in case the server starts honoring it.
  Residual risk: another device pushing the identical edit in the fraction of a second between that
  re-read and the POST would still duplicate lines. No text is lost in that case.
- **Unchanged POST:** outcome reported as unchanged, version unchanged (412 as documented).
- **Two logins give different tokens.** Each device keeps its own token.
- **Cursor format:** opaque 24-character hex string (for example `6acc5308a5cc2b14e584c9ac`).
- **Trashed notes** appear in the since-cursor index with `deleted: true` and full data.
- **Permanently deleted notes do NOT appear in the since-cursor index**; GET answers 404. Such deletions are
  only noticed by the full reconcile (daily, or the "Full reconcile" command), which is what the plugin does.
- **Permanent DELETE requires the note to be trashed first**; otherwise the server answers HTTP 400.
  The plugin never deletes permanently; the itest cleanup trashes first.
- **Tags over the API are stored verbatim and case-sensitively:** `obsidian:Case` and `obsidian:case` were
  both kept; spaces, commas, colons, `&`, `/`, accented letters and emoji were all stored. The web app's tag
  index is case-insensitive (`tag-hash.ts`), so the plugin keeps comparing tags case-insensitively and skips
  a second folder that differs from another only by case. How the website *displays* tags with spaces or
  commas is still to be checked by eye (see below).
- **Maximum note size:** second run: 100 to 500 KB accepted, 1000 KB rejected with HTTP 413 (a first run had
  rejected 500 KB once, so the limit is not sharp; the Electron importer's 1,000,000-byte cap is the likely
  value). Default maximum note size stays at 200 KB, well below. A 413 on push is logged as a warning and
  the file is skipped until it shrinks.

- **Website tag display (checked by eye, screenshot 2026-10-12):** every stored tag is shown verbatim on the
  note, including `obsidian:with space`, `obsidian:comma,here`, `obsidian:emoji😀`, `obsidian:café`,
  `obsidian:x&y`, `obsidian:colon:more`, and `obsidian:Case` and `obsidian:case` as two separate chips.
  The encoding (space → `_`, `,` → `%2C`, `%` → `%25`) is kept because the website's tag input strips
  spaces and commas, so a tag with a space could not be retyped on the web.

### Still to check by eye on the Simplenote website

- Whether `[Title](simplenote://note/<id>)` opens the note when clicked (link translation, M7).
