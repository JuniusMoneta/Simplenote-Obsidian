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

- `%` → `%25`, `,` → `%2C` (commas break the web tag input)
- space → `_`
- everything else (including `/`, `:`, `-`, `&`, `_`, accented letters, emoji) unchanged.

**This format is frozen.** A real `_` is not escaped, so `my_folder` and `my folder` share
`obsidian:my_folder`; decoding first looks for an existing vault folder whose encoded path equals the tag,
then for one whose name equals the decoded tag (both case-insensitive, NFC-normalized), otherwise it
decodes with `_` = space. The small ambiguity is the price of never changing the wire format again: see
"0.4.4 incident" below for what happened when 0.4.4 changed it.

Decoding also understands the two forms 0.4.4 wrote: `%5F` and `%255F` (0.4.4 re-encoding a folder that
an older device had literally named `my%5Ffolder`) both mean `_`. Change hashes (`tagKey`) count them as
`_`, and a note that still carries such a tag is pushed once with the plain tag (one grouped change for
the mass-change guard, `folderTagUpdate`).

Two vault folders that differ only in case map to the same tag. The one that holds notes wins (an empty
leftover from a rename does no harm); if both hold notes, the first in sort order wins, the notes of the
other are skipped, and a notice (once per session) asks the owner to rename or merge one of them.
**Folder case is never a reason to push.** Pulled notes go into the existing folder whatever its case, and
a local push writes the folder tag as the folder is spelled on that device. 0.4.3 and 0.4.4 pushed a tag
rewrite on a case-only rename; see the incident below.

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
  value). Default maximum note size 975 KB (998,400 bytes), just under the presumed 1,000,000-byte server limit; refused notes answer 413 and are reported as sync problems. A 413 on push is logged as a warning and
  the file is skipped until it shrinks.

- **Website tag display (checked by eye, screenshot 2026-10-12):** every stored tag is shown verbatim on the
  note, including `obsidian:with space`, `obsidian:comma,here`, `obsidian:emoji😀`, `obsidian:café`,
  `obsidian:x&y`, `obsidian:colon:more`, and `obsidian:Case` and `obsidian:case` as two separate chips.
  The encoding (space → `_`, `,` → `%2C`, `%` → `%25`) is kept because the website's tag input strips
  spaces and commas, so a tag with a space could not be retyped on the web.

- **auth.simperium.com renegotiates TLS mid-request** (seen with `curl -v` on Windows: "schannel: renegotiating
  SSL/TLS connection" twice before the response). Chromium refuses renegotiation, so `requestUrl` on desktop
  fails with `ERR_CONNECTION_CLOSED`; .NET's `Invoke-RestMethod` fails too. Node's TLS and curl accept it.
  The plugin therefore sends the login request through Node `https` on desktop (guarded; falls back to
  `requestUrl` on mobile) and offers a paste-a-token field. `api.simperium.com` does not renegotiate and
  works from Chromium. This is the one deliberate exception to the "no Node APIs" rule; it is feature-detected
  and never runs on mobile.

- **Email-code login (the web app's default since Simplenote 2.22):** `POST https://app.simplenote.com/account/request-login`
  with `{"username": email, "request_source": "electron"}` emails a code; `POST https://app.simplenote.com/account/complete-login`
  with `{"username": email, "auth_code": CODE}` answers `{"sync_token": ...}`, which is a Simperium access token.
  No API key involved. `app.simplenote.com` is reachable from Chromium, so this is the plugin's primary login
  (source: simplenote-electron `lib/boot-without-auth.tsx`, `requestLogin` / `completeLogin`).

### Still to check by eye on the Simplenote website

- Whether `[Title](simplenote://note/<id>)` opens the note when clicked (link translation, M7).

## Duplicate copies of a note (0.4.2)

Reported as "at least 5 versions of a note" on a vault shared through iCloud between Windows and iOS.
Reproduced in the unit harness (`tests/sync-duplicates.test.ts`). Two causes, both in the plugin:

1. The planner treated "no scanned file for this id" as "file gone" and created `Title (2).md` when the
   note changed on Simplenote. The scan also drops files that exist: unreadable (iCloud placeholder),
   blocked after three failed pushes, over the size setting, paused, or excluded. Fix: ids of such files
   are collected (`presentIds`, now also from the state and for unreadable files) and the planner never
   creates a file for them. Because the since-cursor index does not repeat the change, the id is kept in
   `pendingRemote` and fetched again every sync until the file takes part in a sync; then the normal
   update applies.
2. Two devices both waited two minutes for the same new file and both created a note, because the id
   written by the first device needs longer than the difference between the two deadlines to cross the
   vault sync. Fix: before a new remote note (no state, no file) becomes a `(2)` file, the planner looks
   for a local file without an id whose content and tags equal the note, and links it instead.
   Residual: both devices creating within the same second or two. That leaves two notes and a `(2)` file;
   the cleanup command resolves it. An automatic rule "my file now carries another id, my unchanged note
   is a duplicate: trash it" was tried and rejected: with a lagging vault sync both devices can apply it
   to each other's note, both notes end up trashed, and the unchanged local files follow them into the
   trash.

Cleanup command (`SyncEngine.cleanupDuplicates`): copies are compared by body and tags only (file names,
hence titles, differ between copies in one folder). Same id: identical copies are trashed locally, the
state path (else the shortest non-conflict name) is kept. `Title (n).md` under a second id with the same
body as `Title.md`: the file is trashed locally and its note on Simplenote. Different text is never touched.

Secret storage is device-wide, not per vault (Obsidian 1.11.4+). The token id now carries the vault id
(`simplenote-sync-token-<appId>`); the old id is migrated by the first vault that loads and then cleared,
so a second vault asks for its own login instead of silently syncing the first vault's account.

## 0.4.4 incident (2026-10-12) and the 0.4.5 rules

A vault shared through iCloud between Windows and an iPhone, both running the plugin with the shared-vault
setting on. Windows updated to 0.4.4 through BRAT at 22:45 while the phone still ran the previous version.
Within fifteen minutes:

1. **Tag format change.** Windows pushed `obsidian:Projects/therapy%5Fproject` (the new `_` escape) for 19
   notes. The phone, on the old version, decoded that literally and moved the 19 files into a new folder
   `Projects/therapy%5Fproject`; iCloud carried the move to Windows, which re-encoded the folder as
   `obsidian:Projects/therapy%255Fproject`. Rule: the wire format never changes again; both 0.4.4 forms decode
   to `_`; the plugin never creates a folder for a tag when an existing folder's name equals the decoded tag.
2. **Case rewrites.** The phone's vault had the folder as `writing`, Windows as `Writing` (iCloud does not
   reliably propagate a case-only rename). Each device saw "the folder case changed since my last sync" and
   pushed `obsidian:writing` / `obsidian:Writing` for all 74 notes, in turn. Rule: folder case is never a
   reason to push (`folderTagUpdate` only rewrites the 0.4.4 `%5F` forms).
3. **Both devices writing the same files.** The "pull-only" device of 0.4.3 still wrote every pulled note.
   Two devices writing the same file within seconds made iCloud for Windows produce conflict copies named
   `Note(1).md`, `Note(1)(1).md`, whole folders `A New Dream(1)`, `Rosmini Essay(2)`, and even `(1).obsidian`.
   Rule: a standby device applies nothing but `adopt` (state only). The holder does all reading and writing;
   the vault sync carries its writes. A device that takes the lease over does a full reconcile on its next sync
   and resets the vanished-file timers, and trashes nothing on the takeover sync.
4. **Conflict names became titles.** When iCloud renamed `Syncretic System.md` to `Syncretic System(1).md`, the
   plugin treated it as a user rename and pushed the title `Syncretic System(1)`; the other device renamed its
   file to match, iCloud produced `(1)(1)`, and so on four times. Rule: `stripConflictSuffix` removes trailing
   `(n)` groups written directly after the name before a file name is read as a title or compared with one;
   `pickKeeper` treats such names as conflict copies. (The plugin's own collision suffix is ` (n)` with a space
   and is unaffected; "Journal Red (1)" stays a title.)
5. **Vanished files trashed on Simplenote.** While iCloud renamed folders, nine files were missing for more
   than 60 seconds; the holder trashed their notes, and the other device then moved the files to the trash.
   Rule: on a shared vault the wait is 10 minutes (`SHARED_VAULT_VANISH_WAIT_MS`).
6. **`Title (2).md` during the repair (0.4.6).** While the Windows copy was being cleaned (conflict copies
   removed, titles reverted on Simplenote), the phone still ran the plugin. Its recorded path for a note was
   the removed `Title(1).md`; the cleaned `Title.md` had arrived through iCloud but was not downloaded yet, so
   it was unreadable and carried no readable id. The planner saw "file gone, note changed", found `Title.md`
   taken, and created `Title (2).md`. Rule: when the file a note would get exists but is unreadable, the note
   waits in `pendingRemote` instead (`scan.unreadable`), for notes with and without state.
7. **A device without the setting pushed next to the holder (0.4.7).** The next night two notes gained
   `Note 2.md` / `Note(1).md` copies again and one title became "Obsidian Sync 21. PC move the vault…": the
   macOS conflict name `Obsidian Sync 2` was pushed as the title, then two devices pushed overlapping edits and
   the server merge dropped the newline after the title. The PC held the lease and logged no pushes, so the other
   pusher was a device whose `.obsidian` (and therefore `data.json`) never synced and had the shared-vault
   setting off. Rules: a lease note in the account makes every device follow the lease (`PushLease.exists`), with
   a notice to turn the setting on; and a synced file whose new name is its old name plus a conflict suffix
   (`isConflictCopyName`) keeps its title instead of pushing the suffix.

Repair was done by hand on the Windows copy of the vault (duplicates compared body by body, the newest
body kept, the stored `simplenote-title` kept, copies moved to `.trash/repair-20261012`), the nine notes
restored from the Simplenote trash, the 19 tags rewritten, and the ten mangled titles reverted to the
version before the `(1)` push through the Simplenote version history.

## Push lease for shared vaults (0.4.3)

Observed: a vault shared through iCloud between Windows and iOS, plugin running on both. Every edit was
pushed twice, once per device, and because iCloud delivers intermediate snapshots while the owner is still
typing, the second device pushed old snapshots against old bases. The server merge applied them as patches:
sentences repeated with fragments ("He disappearg white robes. He disappearg white robes."). No pre-push
re-read can prevent this; two bridges for one vault is the problem.

Decision: with the `sharedVault` setting on, only one device pushes. Coordination goes through the one
channel every device reaches within seconds, the Simplenote account itself (`src/lease.ts`):

- One note with a fixed id (`LEASE_NOTE_ID`), kept in the Simplenote trash (`deleted: true`), never mapped
  to a file, filtered out of the index before planning.
- Each device owns one line: `deviceId priority until name`. Holder = valid line (until > now) with the
  lowest priority, ties by device id. A device only rewrites its own line, so a stale-base POST that the
  real server merges (NOTES above: it merges instead of refusing) still leaves both lines intact and every
  device derives the same holder. No compare-and-swap needed.
- Claim when free (priority = now), renew when less than half the TTL (3 min) is left, take over when the
  owner asks (priority below the current holder's, so an in-flight renewal cannot win).
- Writes by other devices arrive through the since-cursor index (trashed notes are included with data), so
  a non-holder costs no extra request; the holder costs one POST per 90 s while active.
- Pull-only devices (0.4.3) dropped push / merge / create-remote / trash-remote actions but still wrote
  pulled notes. Since 0.4.5 a standby device drops everything but `adopt`: see the 0.4.4 incident above.
  Local changes are re-detected from the local scan on every sync, so nothing is lost when the lease arrives;
  remote changes are caught up by the full reconcile the new holder runs on its next sync.
- Two devices claiming an empty lease at the same instant both believe they hold it for one sync; the
  next index fetch shows one line winning and the other device goes pull-only.

Rejected: a lock file in the vault (iCloud lag of minutes), a separate helper plugin (devices have no
channel but iCloud and Simplenote). Making the lease the default was rejected at first (with independent
vaults a standby device could never push its own edits); since 0.4.8 it is the default anyway, at the owner's
request, because every known installation shares one vault and a device whose settings did not sync was the
cause of the 0.4.7 incident. Owners with separate vaults per device turn it off.

