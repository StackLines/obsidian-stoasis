# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
