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
	private nextKey = 1;

	constructor(readonly server: string) {}

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
		if (method === 'GET' && path === '/spaces') {
			return json(200, { spaces: this.spaces });
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
				});
			}
			return json(201, this.spaces[0] ?? {});
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
