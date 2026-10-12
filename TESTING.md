# Manual test checklist

Run on macOS, Windows, and iOS. Use a **dedicated test Simplenote account** and a copy of a vault.
Tick each box per platform. "Web" = the Simplenote website.

Setup: install through BRAT on each device, log in, keep the default settings, turn on debug logging.

## First run

- [ ] Vault with files that equal notes (same text, extra frontmatter allowed): linked, no duplicates, `simplenote-id` written.
- [ ] Files that still contain the title as first line: listed as title-line fixes; after confirming, the first line is removed and the note content is unchanged on the web.
- [ ] Probable matches (same title, small edits): shown with a percentage; confirming links them; declining creates a separate file.
- [ ] More than 10 % unmatched notes: the dialog explains it; "Import" creates the files; "Cancel" writes nothing and pauses.
- [ ] Dry-run mode: same dialog, nothing written, the log shows `[dry-run]` lines.
- [ ] `backup-YYYYMMDD-HHMM.json` appears in the plugin folder before the first push.
- [ ] Second device with the same vault (through iCloud): first sync links everything by id without a dialog.

## Editing

- [ ] Edit in Obsidian → appears on the web within the interval.
- [ ] Edit on the web → appears in Obsidian (file content, not the file name).
- [ ] Offline edit in Obsidian, reconnect → pushed once.
- [ ] Simultaneous edits (different lines) on the web and in Obsidian → both edits present on both sides, nothing lost.
- [ ] Simultaneous edits on the same line → both versions kept, nothing lost.
- [ ] A plugin that rewrites the note on every save (for example a "modified" property): at most one push per 3 seconds per note.
- [ ] Invalid YAML in the frontmatter: logged, note keeps syncing as text, file not rewritten.

## Titles and names

- [ ] Rename in Obsidian → first line changes on the web.
- [ ] Retitle on the web → file renamed in Obsidian; links in other notes updated by Obsidian.
- [ ] Title with characters that are not allowed in file names (`# Heading`, `a: b?`) → file name cleaned, `simplenote-title` keeps the exact title, title unchanged on the web after a round trip.
- [ ] Two notes with the same title in one folder → `Name (2).md`; the web never shows ` (2)`.
- [ ] Accented title (type it on macOS and on Windows) → no rename loop.
- [ ] Case-only rename (`note` → `Note`) → works, no loop.

## Folders and tags

- [ ] Move a file to another folder → `obsidian:` tag replaced on the web.
- [ ] Change the `obsidian:` tag on the web → file moved in Obsidian (folder created if needed).
- [ ] Note created on the web without a folder tag → file created in the vault root.
- [ ] Folder with a space (`Client Work`) → tag `obsidian:Client_Work`; existing folder `my_folder` is reused, not duplicated.
- [ ] Two `obsidian:` tags on one note → first in sort order used, warning logged, the other removed on the next push.
- [ ] Rename a folder with many notes → one confirmation describing the folder rename; all notes retagged.
- [ ] Other tags (`tags:` in frontmatter) ↔ Simplenote tags, both directions. `pinned: true` ↔ pin on the web.

## Delete, exclude, size

- [ ] Delete a file in Obsidian → after about 60 s the note is in the Simplenote trash (not deleted permanently).
- [ ] Trash a note on the web → file moved to the Obsidian trash (`.trash` or system trash per Obsidian setting).
- [ ] Note deleted permanently on the web → file trashed on the next full reconcile (command or daily).
- [ ] File in an excluded folder → never uploaded. Move a synced file into it → note unchanged on the web.
- [ ] File over the size limit → skipped and logged; its note unchanged on the web.
- [ ] `*.excalidraw.md` and files in dot folders are never uploaded.
- [ ] Mass-change guard: trash more than 10 notes on the web → confirmation dialog; "Cancel" pauses; "Apply" trashes them.

## Multi-device (vault synced by iCloud)

- [ ] The same edit arrives on two devices through iCloud while both have Obsidian open → pushed once (version number on the web increases by one).
- [ ] New file created on device A while device B is open → exactly one note on the web; B links the file after the id arrives (log: "got id … from another device").
- [ ] A conflict copy with the same `simplenote-id` (`Note (conflict …).md`) → notice shown, the copy is never uploaded, the original keeps syncing.
- [ ] iCloud for Windows: file briefly vanishes or shows as empty → nothing pushed until it is stable for 60 s.
- [ ] "Sync with Simplenote on this device" off on one device → that device never calls Simplenote, the others still sync.

## iOS

- [ ] Plugin loads (no desktop-only error).
- [ ] Background the app, edit on the web, foreground the app → sync runs on resume (log: "app resumed").
- [ ] Login with the password field (secret storage) works; the token survives an app restart.
- [ ] Status bar is absent on mobile; the ribbon icon and commands work.

## Commands and UI

- [ ] Sync now, Pause / resume, Full reconcile, Open sync log, Log out.
- [ ] Status bar text: `synced Xm ago`, `syncing…`, `paused`, `error (…)`.
- [ ] Expired token (log out on the web or wait) → notice asking to log in again, sync stops, no crash.
- [ ] No password or token appears in the log.

## Link translation (setting, default off)

- [ ] Turn it on on all devices. `[[Note]]` shows as a working link on the web.
- [ ] Click the link on the web → opens the right note (record the format in NOTES.md).
- [ ] Edit on the web and pull → `[[Note]]` is back in Obsidian. `[[Note|Alias]]` keeps its alias.
- [ ] Embeds, `[[Note#Heading]]`, `[[Note^block]]`, links to excluded or missing notes stay as text.
- [ ] Two devices open the same vault for an hour: no push loop (version numbers stable on the web).
