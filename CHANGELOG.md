# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-15

First preview that syncs. Needs Obsidian 1.6.6 or later and an account on a
compatible server.

### Added

- Pairing with your server, by opening the pairing link from your server's
  console or by typing the server address and pairing code in the settings
  tab. Disconnecting asks the server to revoke the device key.
- Version check: the plugin does not pair or sync with a server that needs a
  newer plugin version, and says so.
- Two-way live sync of one vault folder with your personal space, including
  new, renamed, moved and deleted Markdown notes.
- Offline editing: synced notes are kept on the device, and offline edits are
  merged when the connection returns.
- Edits made to a synced note outside Obsidian are merged with edits from
  other devices instead of replacing them.
- Conflict copies when two devices create a note at the same path.
- Sync state in the status bar on desktop and in the settings tab.

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
