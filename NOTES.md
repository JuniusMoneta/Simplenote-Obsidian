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

## PENDING live checks (fill in from `npm run itest`)

- Server-side merge of a stale-base POST: **PENDING**
- ccid deduplication across two logins: **PENDING** (if the server does NOT dedupe, the
  "pull before push, skip when equal" rule in sync.ts still prevents double application of
  identical content; a different-content duplicate is merged by the server or locally.)
- Which tag characters the website shows: **PENDING**
- Largest accepted note: **PENDING** (default limit 200 KB)
- Simplenote internal link format on the website (`simplenote://note/<id>`): **PENDING**
