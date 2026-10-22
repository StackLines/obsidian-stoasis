# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.2] - 2026-10-23

### Added

- A window with the sync status and history: when the server was last reached,
  the note synced last, and the last 500 uploads and downloads with date and
  time, name and folder. Open it from the command palette, the status bar or
  the settings tab. The list stays on the device and holds names and paths
  only.

## [0.3.1] - 2026-10-22

### Fixed

- Deleting many synced notes at once is held until you confirm, from 25 notes
  whatever share of the vault they are (it also required a quarter of it
  before), and for a synced folder as well as the whole vault.
- Once a space syncs the whole vault it can only be synced as the whole
  vault; choosing a folder says so, where it used to leave the device paused.
- A device that syncs a folder no longer writes notes into a space that was
  moved to the vault root while it was starting up.
- The scan progress shows nothing for a space the server does not list, where
  it showed the count of every space.
- The leak check also rejects a commit made with a personal address.
- Pairing and loading the space now pick the space you own. A personal space
  that another person shared with you could be chosen when it was listed first,
  and the whole vault would have been uploaded into it. If you own no space,
  one is created.

## [0.3.0] - 2026-10-22

### Added

- **Space storage** in the settings tab: how much of its quota your space uses,
  such as "1.2 GB of 10 GB", for any role, with a warning from 90%. It reads
  the usage the server lists with the space and shows nothing when the server
  does not report it. Tested with simulated settings and in desktop Obsidian;
  not tested on iOS.
- **Scan progress** in the Brain section while scanning is on: how many of
  your notes wait to be read, whether the scanner is paused, and when the last
  scan ran. The status is read when the settings tab opens and then once a
  minute while it stays open, never faster; it shows nothing on a server
  without it, and a failed read keeps what was shown. It carries counts and
  times only. Tested with simulated settings and in desktop Obsidian; not
  tested on iOS.
- **Stoasis: Note history**, a command (and an entry in the editor menu) for a
  synced note. It lists the note's earlier versions with when, who and why,
  shows how one differs from the note now, and **Restore** writes it back as
  one ordinary edit that every device merges; the text it replaces is usually
  kept in the history, once it was saved as a version. A note that changed while the window was open is compared
  again instead of overwritten. Tested with a real sync server and simulated
  editors, and in two desktop Obsidian instances with the note open on both;
  not tested on iOS.
- **Whole vault**: the space can map to the entire vault instead of one
  folder. Every Markdown note syncs, at the same path in the space, except
  Obsidian's configuration folder and hidden folders. Choose **Whole vault**
  in the settings tab; a window states how many notes will be uploaded and
  asks first, with a longer warning above 500 notes.
- **Moving a folder space to the whole vault**: a space synced from a folder
  (say `notes`, next to `inbox` and `projects`) can grow to the whole vault.
  Choosing **Whole vault** on the device that syncs the folder asks first, then
  puts every note of the space under that folder's path in one change (note
  ids, history and links stay), marks the space as starting at the vault
  root, and uploads the notes in the other folders as new notes. Nothing moves
  in the vault. Another device that syncs a folder stops and asks to follow:
  it renames its folder to the one the space expects, then syncs the whole
  vault. A device that has not followed changes nothing. A new device can join
  a space that starts at the vault root. Update the plugin on all devices
  before moving: a 0.2 device does not understand the change.
  Renaming or deleting a folder inside the vault moves or deletes its notes
  and sync keeps running. Folder warnings are worded for the vault.
  Many notes missing from the vault at once, as when a folder is deleted or a
  sync tool evicts files, are held until you confirm deleting them everywhere.
  Switching from the vault to a folder asks first.
  Tested with simulated devices and a real sync server, 2,500 notes, and in
  two desktop Obsidian instances (edits, a rename, a folder delete, the large
  delete window, the move above); not tested on iOS.

### Changed

- The frontmatter patch applier follows version 3 of the tagging contract.
  It reads scanner patches that remove tags (at most five, matched by
  normalised value, applied before additions) and can replace the id and date
  of a copied note when given the note's own id. Neither changes what the
  plugin does on its own: "Tag this note now" stays add-only. This is the first
  plugin version that passes the version 3 vectors, so it is the one a server
  should name as its minimum before it sends removals.
- The README and the plugin's Network and privacy text now say what the
  whole-vault sync, the note history, the storage figure and the scan
  progress send and read.
- The saved setting `folder` becomes `mapping`. An existing folder setting is
  read as a folder mapping, so no space is re-keyed.

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
  replaced while the window was open, and the copy is kept if it changes, or
  either file goes, before it would go to the trash; if it changes in the
  instant it is trashed, the trash keeps that version.
- A warning, once for each folder, when the vault seems to be in iCloud Drive
  or Dropbox, Obsidian Sync is turned on, the folder may be in a git working
  tree, or new attachments go outside the folder.

### Changed

- The disclosure says that a note you tag is sent to your server.
- The notice for a new conflict copy says how to compare it with the note.

### Fixed

- Deleting many synced notes at once is held until you confirm, from 25 notes
  whatever share of the vault they are (it was also required that they be a
  quarter of it), and for a synced folder as well as the whole vault.
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
- Opening a note in an editor and switching to another note straight away,
  while an edit from another device was still on its way to the first note's
  file, could put the first note's text into the second note, on every synced
  device. This was already the case in 0.1.1.
- Text typed in a note just before switching to another could be added to
  the note twice when another device edited the note at the same moment.
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
