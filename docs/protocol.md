# Server protocol

What the plugin expects from a compatible server, as of plugin version 0.1.0.
This page describes the plugin's side of the exchange; it is not a server
specification.

## HTTP

All requests go to `<server>/notes/api/...` over HTTPS and carry
`Accept: application/json`. Requests with a body send JSON. After pairing,
requests carry the device key as `Authorization: Bearer <key>`; a credential
never appears in a URL.

| Request | Credential | Used for |
| --- | --- | --- |
| `GET /notes/api/version` | none | `{"api": 1, "min_plugin": "0.1.0"}`: the protocol version and the oldest plugin version the server accepts |
| `POST /notes/api/pair` | none | Trades a pairing code and a device name (`{"code", "device_label"}`) for a device key |
| `GET /notes/api/spaces` | device key | Lists the spaces the person can use |
| `POST /notes/api/spaces` | device key | Creates the personal space if there is none (`{"name", "kind": "personal"}`); repeating it is harmless |
| `POST /notes/api/sync-token` | device key | Returns a sync token valid for ten minutes |
| `DELETE /notes/api/devices/<key id>` | device key | Revokes this device's own key |

The client code also covers `GET /notes/api/me` and the scan settings
(`GET`/`PUT /notes/api/scan-settings`, `PUT /notes/api/spaces/<id>/scan-mode`),
but version 0.1.0 does not call them from its interface. A later version will
ask the server to suggest frontmatter properties for a note; 0.1.0 sends no
such request.

Errors are JSON objects `{"error": "<code>", "message": "<text>"}`. The plugin
maps the status and code to a message: a refused credential, missing
permission, an invalid or expired pairing code, a malformed request, a missing
resource, a temporary lockout after repeated failures (`429` with
`Retry-After`), or an unavailable server.

Pairing codes are case-insensitive; spaces and dashes typed in a code are
ignored. A code is valid once, for a short time.

## Version gate

Before pairing, and each time the plugin fetches a sync token, it reads
`/notes/api/version`. If the server speaks a newer protocol (`api` greater than
1) or needs a newer plugin (`min_plugin` above the installed version), the
plugin stops and asks you to update.

## Sync

Sync runs over one WebSocket per device, `wss://<server>/notes/sync`, shared
by all documents, using the Hocuspocus protocol for Yjs documents. Each
document authenticates with the current sync token.

The space document is opened first. Notes are opened only once the space is
synced and the server has confirmed every change to it, so a new note is
already listed in the space when it authenticates. At most 40 notes wait for
authentication at a time, below the server's limit of documents pending on
one connection.

If the server refuses the space, the plugin reconnects with a fresh token
once; refused again, it stops and reports that the device lost access. If the
server refuses a note, the plugin authenticates it once more on the same
connection with a fresh token. Refused again, the note is left alone for the
rest of the session: its changes stay on the device and the plugin reports it
as refused. After three refusals on one connection the plugin opens a new
connection rather than reach the server's limit of refusals per connection.

A space is a Yjs document named `space:<space id>`. Its map `index` maps a
note's path inside the synced folder (relative, with `/` separators) to
`{"id": "<note id>", "kind": "markdown"}`. Each note is a Yjs document named
`note:<note id>` whose text `content` holds the Markdown. Clients create note
ids as random version 4 UUIDs.

Renaming a note changes only the index; deleting one removes it from the
index. If concurrent renames leave one note id at several paths, clients keep
the path that sorts first and remove the others. A client that had changes
to a note the server had not yet confirmed when another device deleted it
lists the note again rather than delete it. Only Markdown notes are synced;
canvas files and attachments are not.

Every document is also kept in the app's local database on the device, so it
can be edited offline and merged when the connection returns.

## Origin

The sync connection is opened by the app's web view, which sends its own
`Origin` header. A server that checks it must accept the values Obsidian
sends: `app://obsidian.md` on desktop and `http://localhost` on Android. On
iOS and iPadOS the expected value is `capacitor://localhost`; if a server
refuses the connection there, its log shows the value that was sent.
