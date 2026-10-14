# Security policy

Please report vulnerabilities privately, not in a public issue.

Use the repository's **Security** tab and choose **Report a vulnerability**
(a private GitHub security advisory). Include what you found, how to
reproduce it and which version is affected.

You can expect an acknowledgement, and a fix or a decision, as soon as
the maintainers can manage. Only the latest release is supported.

## What the plugin does with credentials

Version 0.0.1 stores and sends no credentials: a pairing code from a pairing
link is checked, kept in memory until the plugin unloads, and never written to
disk, logs or notices. Once pairing is available:

- A device key received during pairing is stored only in the plugin's local
  data file inside your vault (`.obsidian/plugins/stoa/data.json`).
- Credentials are sent only in an `Authorization` header, never in a URL, and
  are never written to logs or notices.
- Keep `data.json` out of any shared or cloud-synced copy of your vault.
