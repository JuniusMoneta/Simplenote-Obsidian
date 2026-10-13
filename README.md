# Simplenote Sync for Obsidian

Keeps every Markdown note in an Obsidian vault in two-way, one-to-one sync with a Simplenote account.
Obsidian is the home of the notes. Simplenote is a web window onto the whole vault, for computers
where Obsidian cannot be installed.

- One `.md` file = one Simplenote note. The file name is the note title (first line on Simplenote).
- Folders map to Simplenote tags that start with `obsidian:` (`Projects/Client Work/Plan.md` → `obsidian:Projects/Client_Work`). A space and a real `_` share one tag; the folder that exists in the vault wins. Tags are compared without regard to case.
- Other Simplenote tags become a hashtag line at the end of the note. A pinned note is a bookmark in Obsidian's core Bookmarks list, and bookmarking a note pins it on Simplenote.
- Works on macOS, Windows, and iOS. The plugin runs on every device; whichever device has Obsidian open syncs.
- Images and attachments are not uploaded. Notes that embed them sync as text.

## Before the first run

1. **Make a full copy of the vault folder.** The first run links existing files to existing notes
   and may write ids and remove duplicated title lines. A copy makes any mistake reversible.
2. Use a **dedicated test Simplenote account** first if you can. Switch to the main account only after
   the manual tests in `TESTING.md` pass.
3. Read the privacy and risk notes below.

## Install (BRAT)

This plugin is not in the community plugin directory (see "Risks"). Install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install and enable BRAT from the community plugins.
2. BRAT settings → "Add beta plugin" → `JuniusMoneta/Simplenote-Obsidian`.
3. Enable "Simplenote Sync" in Settings → Community plugins.

Do the same on each device (Mac, Windows, iPhone). The release assets are `main.js`, `manifest.json`, and `styles.css`.

## Setup

1. Settings → Simplenote Sync → enter the email → **Send code** → enter the code from the email →
   **Log in with code**. This is the same flow the Simplenote website uses. The resulting token is kept
   in Obsidian's secret storage, never in `data.json`. The token belongs to the vault, so two vaults on one
   device can sync two Simplenote accounts (log in once per vault).
2. Leave "Sync with Simplenote on this device" on (it is device-local).
3. Optional: excluded folders, maximum note size (default 975 KB, just under Simplenote's own limit of about 1,000,000 bytes), dry-run mode.
4. Click the ribbon icon or run **Simplenote: Sync now**.

### First run

On the first sync the plugin compares the Simplenote notes with the vault and shows a summary before writing anything:

- Files that equal a note (ignoring frontmatter and whitespace) are **linked** by writing `simplenote-id`.
- Files that still contain the note title as first line are linked and the duplicated line is removed (you can turn this off).
- Same title and at least 90 % similar body → "probable match", to confirm one by one or all at once.
- Notes without a file are created in the vault (in the folder from their `obsidian:` tag, else the root).
- Files without a note are uploaded as new notes.

If more than 10 % of the notes have no matching file, the dialog asks whether to import them or cancel.
Dry-run mode shows the same dialog and changes nothing.

## How sync works

- Every sync pulls first, then pushes. Polling is adaptive: every 10 s for five minutes after any change
  on either side, then every 60 s when idle (both settings, minimum 10 s). Local edits sync 3 s after you
  stop typing, and a sync runs on "Sync now" and when the app comes back to the foreground (iOS).
- Simultaneous edits on both sides are merged. The server merges text changes; if it refuses, the
  plugin merges locally (line by line, never dropping text).
- Deleting a file moves the note to the Simplenote trash. Trashing a note on Simplenote moves the
  file to the Obsidian trash. Nothing is ever deleted permanently on the server.
- Renaming a file changes the first line on Simplenote. Changing the first line on Simplenote renames the file.
  Titles that cannot be file names (`# Heading`, `a: b`, very long lines) are kept in `simplenote-title`.
- Moving a file replaces its `obsidian:` tag. Changing the tag on the web moves the file.
- Frontmatter keys managed by the plugin: `simplenote-id`, `tags`, `pinned`, `simplenote-title`.
  Other frontmatter keys sync as text (they appear below the title on Simplenote).

### Safety rules

- Before the first push on a device, a JSON export of all notes is written to the plugin folder (`backup-YYYYMMDD-HHMM.json`).
- A sync that would trash more than 10 notes, move more than 20, or change more than 50 asks for confirmation first.
- A file that vanishes or becomes empty is re-checked after 60 seconds before anything is pushed
  (iCloud for Windows briefly hides files).
- A new file waits 2 minutes before a note is created, so that an id assigned by another device can arrive through the vault sync.
- Conflict copies with a duplicated `simplenote-id` are paused and reported; they are never uploaded as new notes.
  A conflict name that a vault sync gives a file (`Note(1).md`, `Note(1)(1).md` from iCloud for Windows, `Note 2.md`
  from iCloud on a Mac) is never pushed as the note title.
- A second file is never created for a note whose file exists. A note that changes on Simplenote while its
  file is unreadable (iCloud placeholder), blocked, paused, or excluded is applied once the file takes part
  in a sync again.
- A new file is linked to a note with identical content that another device created meanwhile (the vault
  sync had not delivered the id yet), instead of getting a second note.
- A note whose file is missing is not recreated as `Title (2).md` while a file named `Title.md` exists but
  cannot be read yet (the vault sync is still downloading it); the change waits for that file.
- **Clean up duplicate copies of notes** moves `Title (2).md`-style copies to the Obsidian trash when their
  text equals the kept file or the note on Simplenote, and trashes a duplicate note on Simplenote when a
  copy carries a second id. Copies whose text differs are left alone and listed in the sync log.
- Device-local state (cursor, versions) is kept in local storage, so every device syncs independently.
- **Shared vault (iCloud, Obsidian Sync) with the plugin on several devices:** turn on the setting
  "Shared vault: one device syncs at a time". One device holds a *sync lease* and syncs the vault in both
  directions; the others stand by and change nothing (they only keep their records up to date), and the vault
  sync carries the holder's writes to them. Their edits reach Simplenote through the holder, via the vault sync.
  Without the lease, every edit is pushed once per device, and the intermediate snapshots the vault sync delivers
  get merged into the note as duplicated fragments; two devices writing the same pulled note at the same time
  also make iCloud for Windows rename files to `Note(1).md` and folders to `Folder(1)`. The lease is a small note
  kept in the Simplenote trash. It moves by itself when the holder stops syncing for 3 minutes (app closed, phone
  in the background); the command "Take over sync on this device" moves it at once. A device that takes the lease
  over starts with a full reconcile. The status bar shows `standby (Windows abcd syncs)` on the other devices.
  On a shared vault a file that vanishes is re-checked for 10 minutes (not 60 seconds) before its note is trashed,
  because the vault sync can hide files for minutes while it renames folders.
- Uploads are throttled to 2 requests per second and resume after Obsidian restarts.

### Exclusions

Never synced: dot folders (`.obsidian`, `.trash`, …), non-Markdown files, `*.excalidraw.md`, files over the
size limit, and folders in the excluded list. A synced file that becomes excluded is left alone on both sides.

## Commands

Sync now · Pause / resume sync · Full reconcile · Open sync log · List excluded and failing files ·
Clean up duplicate copies of notes · Take over sync on this device (shared vault) · Log out.
The status bar shows `Simplenote: synced 2m ago`, `syncing…`, `paused`, or `error`.

## Optional: link translation

Off by default. When on, `[[Note]]` is pushed as `[Note](simplenote://note/<id>)` so links work on the
Simplenote website, and translated back on pull. Embeds, heading and block links, and links to notes
without an id stay as text. **Turn it on or off on every device at the same time**; otherwise the devices push each other's version in a loop.

## Login problems

Login uses the Simplenote account service at `app.simplenote.com` (email code), the same flow as the
website, and works from Obsidian on all platforms. If it ever fails, a Simperium access token obtained
elsewhere can be pasted into "Paste a token" in the settings; the token the website stores in its local
storage (`stored_user`) works too.

## Privacy

Every synced note is stored in Simplenote **without end-to-end encryption**. Put sensitive notes in an
excluded folder.

## Risks

- Simplenote has no official public API. This plugin talks to Simperium with the client key of the
  official Simplenote apps, like other third-party clients. Automattic may change or revoke that key at any time.
- Simplenote is in maintenance mode.
- Obsidian's community-plugin review may reject a plugin that embeds another app's key, so this
  plugin is distributed through BRAT.
- Vault-sync services (iCloud, especially iCloud for Windows) can produce conflict copies and
  temporary placeholders. The rules above limit the damage, but keep backups. With the plugin running on
  several devices of one shared vault, turn on "Shared vault: one device syncs at a time".

## Development

```
npm install
npm test          # unit tests with a fake Simperium server
npm run build     # main.js
npm run itest     # live checks against a dedicated test account (SN_TEST_USER / SN_TEST_PASS)
```

`NOTES.md` records the API facts and decisions. `TESTING.md` is the manual test checklist.
