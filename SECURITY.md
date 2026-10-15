# Security policy

Please report vulnerabilities privately, not in a public issue.

Use the repository's **Security** tab and choose **Report a vulnerability**
(a private GitHub security advisory). Include what you found, how to
reproduce it and which version is affected.

You can expect an acknowledgement, and a fix or a decision, as soon as
the maintainers can manage. Only the latest release is supported.

## What the plugin does with credentials

- A pairing code, from a link or typed, is sent once to your server to pair
  the device and is never written to disk, logs or notices.
- The device key received during pairing is stored only in the plugin's local
  data file inside your vault (`.obsidian/plugins/stoasis/data.json`). It can
  reach your notes on the server and nothing else.
- Sync uses a short-lived token that the plugin asks your server for with the
  device key. Tokens are kept in memory only.
- Credentials are sent only in an `Authorization` header or inside the sync
  connection, never in a URL, and are never written to logs or notices.
- Disconnecting in the settings tab asks the server to revoke the device key
  and removes the key from the data file, even when the server cannot be
  reached.
- Keep `data.json` out of any shared or cloud-synced copy of your vault.
