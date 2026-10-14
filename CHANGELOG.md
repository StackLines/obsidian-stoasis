# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.1] - 2026-10-14

First preview. The plugin loads and shows its state; it does not sync yet.

### Added

- Settings tab with the pairing status and a short disclosure about network use.
- Status bar item that reads "Stoa: not paired".
- Handler for `obsidian://stoa?server=<url>&code=<code>` links. It validates
  the link and tells you that pairing is not available yet; it makes no
  network request and stores nothing.
