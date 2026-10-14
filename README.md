<h1 align="center">Stoa</h1>

<p align="center">
  <strong>Your notes, in step.</strong><br>
  Real-time note sync and automatic frontmatter tags for Obsidian,<br>
  against a compatible self-hosted server.
</p>

<p align="center">
  <a href="https://github.com/StackLines/obsidian-stoa/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/StackLines/obsidian-stoa/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/StackLines/obsidian-stoa/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/StackLines/obsidian-stoa?include_prereleases&label=release"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue.svg"></a>
  <img alt="Early development" src="https://img.shields.io/badge/status-early%20development-orange.svg">
</p>

A *stoa* was the covered walkway of an ancient city: a place to stop, talk
and keep walking together. This plugin is the walkway between your vault and
your server.

> **Early development.** Version 0.0.1 is a foundation release. It loads,
> shows its state and recognises pairing links, but it does not sync or tag
> anything yet. See [Status](#status).

## What it does

- **Keeps your notes in step** across devices, in real time, against a server
  you run or are given access to.
- **Keeps notes tidy** with automatic frontmatter tags, including notes you
  never sync.
- **Stays out of the way.** Tagging works without syncing anything, and you
  choose which folders leave your device.

## Features

| Feature | Status |
| --- | --- |
| Settings tab and status bar showing the pairing state | shipped |
| Pairing link recognised and validated | shipped |
| Pairing with a compatible server | planned |
| Live sync of notes in chosen folders | planned |
| Offline editing with merge on reconnect | planned |
| Live cursors while co-editing | planned |
| Automatic frontmatter tags | planned |
| Sharing folders with roles | planned |

## Before you install: what you need and what we tell you

- **An account on a compatible server is required** for syncing and tagging.
  Without one the plugin does nothing useful.
- **Network use.** Once pairing and sync ship, the plugin only talks to the
  server address you configure by pairing: HTTPS requests for pairing,
  version checks, sync tokens and tagging suggestions, and a WebSocket for
  live sync. Version 0.0.1 makes no network requests at all.
- **Your note content is sent to that server** for notes in folders you choose
  to sync and for notes you ask to tag. Nothing is sent for other notes.
- **No telemetry, no analytics, no ads and no self-update.** Updates arrive
  only through your normal plugin update channel.
- **Credentials** are stored in the plugin's local data file,
  `.obsidian/plugins/stoa/data.json`, inside your vault. Exclude that file from
  any shared or cloud-synced copy of your vault.
- **Works on desktop and mobile.**

## Install

### Community plugins

Not listed yet. This section will point to the directory entry once the
plugin is accepted.

### BRAT (for testers)

1. Install the **BRAT** plugin from Obsidian's community plugins.
2. Open the command palette and run **BRAT: Add a beta plugin for testing**.
3. Paste `https://github.com/StackLines/obsidian-stoa` and confirm.
4. Enable **Stoa** under **Settings → Community plugins**.

BRAT needs read access to the repository. If you were given access to a
private copy, add a GitHub personal access token in BRAT's settings first.

### Manual

Download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/StackLines/obsidian-stoa/releases/latest)
into `<vault>/.obsidian/plugins/stoa/`, then enable the plugin.

## Pairing

Pairing connects one device to your account on a compatible server. It is
not available in 0.0.1; this is how it will work.

1. In your server's console, create a pairing code for a new device.
2. Either click the pairing link the console shows, which looks like
   `obsidian://stoa?server=<url>&code=<code>`, or paste the server address and
   the code into the plugin's settings tab.
3. The device receives its own key. You can disconnect a device at any time
   from the settings tab, which revokes that key.

Pairing links are only accepted for `https` servers (plain `http` only for
`localhost` and `127.0.0.1`, for development).

## Status

**Current version:** `0.0.1`

What works today:

- The plugin loads on desktop and mobile.
- The settings tab and the status bar read "not paired".
- Pairing links are recognised and validated. The plugin tells you that
  pairing is not available yet and does nothing else: no network request, and
  nothing is stored.

What is next: pairing, then live sync of notes.

Not supported yet: canvas files, attachments and any sharing interface.

See the [changelog](CHANGELOG.md) for release notes.

## Roadmap

1. **Foundations.** Build, release and a plugin that loads and shows its state.
   *This release.*
2. **Live sync.** Pairing, folders mapped to your server, real-time editing
   and offline changes.
3. **Tagging.** Automatic frontmatter tags for synced and unsynced notes.
4. **Sharing.** Shared folders with roles.

## Development

```sh
npm ci
npm run dev       # watch build into main.js
npm test          # unit tests
npm run check     # lint, tests, build, README status and leak check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions, including how
commits, wording and README updates are handled.

## Privacy and security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE). Third-party notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
