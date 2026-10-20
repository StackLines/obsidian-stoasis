import type { RequestUrlParam, RequestUrlResponse } from '../stubs/obsidian';

export const SPACE_ID = '6f1c1d9e-8f0a-4a57-9a51-2f4f3e0f9a10';

/**
 * The HTTP side of a compatible server, enough for pairing and sync: hands
 * out device keys for valid codes and sync tokens for valid keys.
 */
export class FakeControlPlane {
	minPlugin = '0.1.0';
	api = 1;
	/** Codes that can be redeemed once. */
	readonly codes = new Set(['ABCD2345']);
	readonly keys = new Map<string, string>();
	readonly revoked: string[] = [];
	/** Sync token handed out for every valid key. */
	syncToken = 'good';
	spaces: Array<Record<string, unknown>> = [];
	/** What the server counts for the space's notes; zero for a space that never held one. */
	notesBytes = 0;
	/** The answer to suggest-properties for a note's text. */
	suggest: (markdown: string) => { status: number; body: unknown } = () => ({
		status: 200,
		body: { patch: null, matches: [], errors: [] },
	});
	/** Every text sent to suggest-properties. */
	readonly suggested: string[] = [];
	scanSettings = { scan_enabled: true, operator_enabled: true };
	/** False while the server does not offer base metadata yet: its endpoints are 404. */
	baseMetadataLive = true;
	/** Status for scan-settings, before a deploy that has it (404) or when it fails. */
	scanSettingsStatus = 200;
	/** Answers every owner-only change with 403, as for a space someone else owns. */
	notOwner = false;
	private nextKey = 1;

	constructor(readonly server: string) {}

	private usage(): Record<string, number> {
		return {
			notes_bytes: this.notesBytes,
			versions_bytes: 0,
			attachments_bytes: 0,
			derived_bytes: 0,
			total_bytes: this.notesBytes,
			quota_bytes: 10737418240,
		};
	}

	/** Note id → saved versions, as the history endpoints serve them. */
	versions = new Map<
		string,
		Array<{
			version: number;
			created_at: string;
			actor_kind: string;
			actor_label: string;
			reason: string;
			size: number;
			text: string;
		}>
	>();

	handle = (request: RequestUrlParam): RequestUrlResponse => {
		const prefix = `${this.server}/notes/api`;
		if (!request.url.startsWith(prefix)) {
			return json(404, { error: 'not_found', message: 'Not found' });
		}
		const path = request.url.slice(prefix.length);
		const method = request.method ?? 'GET';
		if (method === 'GET' && path === '/version') {
			return json(200, { api: this.api, min_plugin: this.minPlugin });
		}
		if (method === 'POST' && path === '/pair') {
			const body = JSON.parse(request.body ?? '{}') as { code?: string; device_label?: string };
			if (body.code === undefined || !this.codes.delete(body.code)) {
				return json(400, { error: 'invalid_code', message: 'Invalid code' });
			}
			const keyId = `key-${this.nextKey++}`;
			const token = `device-${keyId}`;
			this.keys.set(token, keyId);
			return json(201, {
				token,
				key_id: keyId,
				label: body.device_label ?? '',
				person: { id: 'person-1', display_name: 'Ada' },
				server: this.server,
			});
		}
		const auth = request.headers?.['Authorization'] ?? '';
		const keyId = this.keys.get(auth.replace(/^Bearer /, ''));
		if (keyId === undefined) {
			return json(401, { error: 'unauthenticated', message: 'No' });
		}
		if (method === 'POST' && path === '/sync-token') {
			return json(200, { token: this.syncToken, expires_at: '2099-01-01T00:00:00Z' });
		}
		const history = /^\/notes\/([0-9a-f-]+)\/versions(?:\/(\d+))?(?:\?(.*))?$/.exec(path);
		if (method === 'GET' && history !== null) {
			const all = this.versions.get(history[1] ?? '');
			if (all === undefined) {
				return json(404, { error: 'not_found', message: 'No' });
			}
			if (history[2] !== undefined) {
				const one = all.find((v) => v.version === Number(history[2]));
				return one === undefined ? json(404, { error: 'not_found', message: 'No' }) : json(200, one);
			}
			const query = new URLSearchParams(history[3] ?? '');
			const limit = Number(query.get('limit') ?? 50);
			const before = query.has('before') ? Number(query.get('before')) : Infinity;
			const older = [...all].filter((v) => v.version < before).sort((a, b) => b.version - a.version);
			const page = older.slice(0, limit);
			const last = page[page.length - 1];
			return json(200, {
				versions: page.map(({ text: _text, ...rest }) => rest),
				next_before: older.length > limit && last !== undefined ? last.version : null,
			});
		}
		if (method === 'GET' && path === '/spaces') {
			return json(200, { spaces: this.spaces.map((space) => ({ ...space, usage: this.usage() })) });
		}
		if (method === 'POST' && path === '/spaces') {
			if (this.spaces.length === 0) {
				this.spaces.push({
					space_id: SPACE_ID,
					name: 'Personal',
					kind: 'personal',
					role: 'owner',
					scan_mode: 'off',
					archived: false,
					...(this.baseMetadataLive ? { base_metadata: true, base_backfill_requested: false } : {}),
				});
			}
			return json(201, { ...this.spaces[0], usage: this.usage() });
		}
		if (method === 'POST' && path === '/suggest-properties') {
			const body = JSON.parse(request.body ?? '{}') as { markdown: string };
			this.suggested.push(body.markdown);
			const answer = this.suggest(body.markdown);
			return json(answer.status, answer.body);
		}
		if (path === '/scan-settings') {
			if (this.scanSettingsStatus !== 200) {
				return json(this.scanSettingsStatus, { error: 'not_found', message: 'Not found' });
			}
			if (method === 'PUT') {
				const body = JSON.parse(request.body ?? '{}') as { scan_enabled: boolean };
				this.scanSettings = { ...this.scanSettings, scan_enabled: body.scan_enabled };
			}
			return json(200, this.scanSettings);
		}
		const owned = /^\/spaces\/([^/]+)\/(scan-mode|base-metadata|base-metadata\/backfill)$/.exec(path);
		if (owned !== null) {
			const space = this.spaces.find((s) => s['space_id'] === owned[1]);
			if (space === undefined || (owned[2] !== 'scan-mode' && !this.baseMetadataLive)) {
				return json(404, { error: 'not_found', message: 'Not found' });
			}
			if (this.notOwner) {
				return json(403, { error: 'forbidden', message: 'Owner only' });
			}
			const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
			if (owned[2] === 'scan-mode') {
				space['scan_mode'] = body['scan_mode'];
			} else if (owned[2] === 'base-metadata') {
				space['base_metadata'] = body['base_metadata'];
				if (body['base_metadata'] === false) {
					space['base_backfill_requested'] = false;
				}
			} else {
				if (space['base_metadata'] !== true) {
					return json(409, { error: 'base_metadata_off', message: 'Base metadata is off' });
				}
				space['base_backfill_requested'] = true;
			}
			return json(200, space);
		}
		if (method === 'DELETE' && path === `/devices/${keyId}`) {
			this.revoked.push(keyId);
			for (const [token, id] of this.keys) {
				if (id === keyId) {
					this.keys.delete(token);
				}
			}
			return { status: 204, headers: {}, text: '' };
		}
		return json(404, { error: 'not_found', message: 'Not found' });
	};
}

function json(status: number, body: unknown): RequestUrlResponse {
	return { status, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) };
}
