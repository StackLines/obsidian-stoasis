# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-16

Tags a note when you ask, adds the Brain settings, and lets you choose
between a conflict copy and its note.

### Added

- **Tag this note now**, from the command palette or the editor menu of a
  Markdown note. Your server suggests tags and properties for the note's text
  and keeps nothing; a window shows each proposed change and where it came
  from, and **Apply** writes them into the frontmatter, unless the note's
  properties changed since the suggestion. It works for notes that are not
  synced, on a device that is only paired.
- Frontmatter changes follow version 2 of the tagging contract: new
  properties, base properties that are only ever filled in, task and open
  point lists that are replaced, and the new order of added properties.
- A **Brain** section in the settings tab, when your server offers it:
  **Scan my notes automatically**, and for the owner of the synced space its
  scan mode, base metadata, and **Add base metadata to existing notes**.
- **Compare with the synced note**, for a conflict copy: shows the lines that
  differ, then **Use conflict copy** or **Keep current synced note**, moving
  the copy to the trash. Nothing is written if either file changed or was
  replaced while the window was open.
- A warning, once for each folder, when the vault seems to be in iCloud Drive
  or Dropbox, Obsidian Sync is turned on, the folder may be in a git working
  tree, or new attachments go outside the folder.

### Changed

- The disclosure says that a note you tag is sent to your server.
- The notice for a new conflict copy says how to compare it with the note.

### Fixed

- Renaming a note so that only the case of its name changes (`note.md` to
  `Note.md`) failed on devices whose file system ignores case, as on macOS,
  iOS and Windows.
- Two notes whose names differ only in case stopped every later note from
  arriving on a device whose file system ignores case. That device now skips
  the one it cannot keep, with a warning, and syncs the rest.
- Text typed in a note open in an editor while the note was renamed could be
  added to the note twice, or, during a case-only rename, lost.
- An editor that reloaded a note's file while edits from another device were
  arriving could undo those edits.
- Properties your server adds to a note open in an editor no longer move the
  cursor out of the text you are typing. One case remains: text typed at the
  very start of a note while your server adds its first properties can end up
  in front of them, so that they show as body text. Nothing is lost, and the
  README says how to put them back at the start.

## [0.1.1] - 2026-10-15

Downloads your space to a new device in one step, and fixes a note's text
being replaced by another note's after switching files in an editor.

### Added

- **Download to this device** in the settings tab. On a device that syncs no
  folder yet, one step creates a folder named after your space, downloads your
  notes into it and turns sync on.
- While a folder downloads the space for the first time, a notice shows how
  many notes are on the device so far, on mobile too. The status bar and the
  settings tab show the same count.

### Changed

- After pairing, the notice points to **Download to this device**. Syncing a
  folder you already have is offered next to it, and says that notes in that
  folder are added to the space.
- On a first sync, files appear as notes arrive, instead of only after every
  note has been loaded.

### Fixed

- Opening another note in an editor that showed a note before could replace
  the new note's text with the previous note's, on every synced device. An
  editor's text now goes into a note only when it was loaded from that note's
  file; otherwise the editor shows the note's synced text. Loading a file
  into an editor is never sent as typing.
- An editor's text that would replace most of a note without anyone typing
  is no longer merged into it; the plugin keeps the synced text and says so.

## [0.1.0] - 2026-10-15

First preview that syncs. Needs Obsidian 1.6.6 or later and an account on a
compatible server.

### Added

- Pairing with your server, by opening the pairing link from your server's
  console or by typing the server address and pairing code in the settings
  tab. Disconnecting asks the server to revoke the device key; if the server
  cannot be reached, the plugin says so and keeps trying, for every key left
  unrevoked this way.
- Version check: the plugin does not pair or sync with a server that needs a
  newer plugin version, and says so.
- Two-way live sync of one vault folder with your personal space, including
  new, renamed, moved and deleted Markdown notes.
- Offline editing: synced notes are kept on the device, and offline edits are
  merged when the connection returns. A note deleted elsewhere while this
  device had unsent changes to it is kept, together with an open editor's
  unsaved text.
- Edits made to a synced note outside Obsidian are merged with edits from
  other devices instead of replacing them.
- Conflict copies when two devices create a note at the same path. Two
  devices renaming the same note differently settle on one name.
- Notes the server refuses are asked for once more with a fresh token, then
  kept on the device and reported.
- Sync state in the status bar on desktop and in the settings tab, which
  updates while open.

### Changed

- The settings tab now holds pairing, the synced folder and the sync switch.
- The minimum Obsidian version is now 1.6.6.

## [0.0.1] - 2026-10-14

First preview. The plugin loads and shows its state; it does not sync yet.

### Added

- Settings tab with the pairing status and a short disclosure about network use.
- Status bar item that reads "Stoasis: not paired".
- Handler for `obsidian://stoasis?server=<url>&code=<code>` links. It validates
  the link and tells you that pairing is not available yet; it makes no
  network request and stores nothing.
