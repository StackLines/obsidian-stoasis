// Client for the control plane of a compatible server: JSON over HTTPS under
// <server>/notes/api. The transport is injected so the client can be tested
// without the app; see src/http.ts for the one used in Obsidian.

import { readPatch, type PropertyPatch } from './frontmatter-patch';

export interface HttpRequest {
	url: string;
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	headers: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	/** Raw response body; empty when there is none. */
	text: string;
}

/** Sends one request. Rejects only when no response arrived at all. */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/** Why a call failed, in terms the plugin acts on. */
export type ApiErrorKind =
	| 'network'
	| 'unauthenticated'
	| 'invalid-code'
	| 'locked'
	| 'forbidden'
	| 'not-found'
	| 'invalid-request'
	| 'unavailable'
	| 'base-metadata-off'
	| 'unexpected';

export class ApiError extends Error {
	constructor(
		readonly kind: ApiErrorKind,
		readonly status: number,
		/** Seconds to wait before retrying, from Retry-After, when given. */
		readonly retryAfter: number | null = null,
	) {
		super(`Request failed: ${kind}${status ? ` (${status})` : ''}`);
		this.name = 'ApiError';
	}
}

export interface VersionInfo {
	api: number;
	minPlugin: string;
}

export interface Person {
	id: string;
	displayName: string;
}

export interface PairResult {
	token: string;
	keyId: string;
	label: string;
	person: Person;
}

export interface SyncToken {
	token: string;
	expiresAt: string;
}

export type SpaceRole = 'owner' | 'editor' | 'viewer';
export type ScanMode = 'off' | 'suggest' | 'auto';

export interface Space {
	id: string;
	name: string;
	kind: 'personal' | 'shared';
	role: SpaceRole;
	scanMode: ScanMode;
	archived: boolean;
	/**
	 * Whether the server's scanner stamps base metadata into new notes; null
	 * when the server does not offer base metadata yet.
	 */
	baseMetadata: boolean | null;
	/** Whether adding base metadata to the space's older notes was asked for. */
	baseBackfillRequested: boolean;
}

export interface ScanSettings {
	scanEnabled: boolean;
	operatorEnabled: boolean;
}

/** Where a suggested value came from, as the server's matcher explains it. */
export interface PropertyMatch {
	/** `person` or `topic`; other kinds may come later. */
	kind: string;
	id: string;
	name: string;
	/** For example `wikilink`. */
	reason: string;
	/** The text in the note that matched. */
	matched: string;
}

/** A tagging contract error: the key it is about (null for the patch as a whole) and its code. */
export interface ContractError {
	key: string | null;
	code: string;
}

export interface Suggestion {
	/** Null when there is nothing to add. */
	patch: PropertyPatch | null;
	matches: PropertyMatch[];
	errors: ContractError[];
}

/** Calls under <server>/notes/api. The key is sent in a header, never a URL. */
export class NotesApi {
	constructor(
		private readonly http: HttpClient,
		private readonly server: string,
		private readonly key: string | null = null,
	) {}

	/** The same client, authenticated with a device key. */
	withKey(key: string): NotesApi {
		return new NotesApi(this.http, this.server, key);
	}

	async version(): Promise<VersionInfo> {
		const body = await this.call('GET', '/version', undefined, false);
		return {
			api: requireNumber(body, 'api'),
			minPlugin: requireString(body, 'min_plugin'),
		};
	}

	async pair(code: string, deviceLabel: string): Promise<PairResult> {
		const payload: Record<string, string> = { code };
		if (deviceLabel.trim() !== '') {
			payload['device_label'] = deviceLabel.trim();
		}
		const body = await this.call('POST', '/pair', payload, false);
		return {
			token: requireString(body, 'token'),
			keyId: requireString(body, 'key_id'),
			label: optionalString(body, 'label'),
			person: readPerson(body['person']),
		};
	}

	async me(): Promise<Person> {
		const body = await this.call('GET', '/me');
		return readPerson(body['person']);
	}

	async syncToken(): Promise<SyncToken> {
		const body = await this.call('POST', '/sync-token', {});
		return {
			token: requireString(body, 'token'),
			expiresAt: optionalString(body, 'expires_at'),
		};
	}

	/** Revokes a device key. With a device key, only its own id is allowed. */
	async revokeDevice(keyId: string): Promise<void> {
		await this.call('DELETE', `/devices/${encodeURIComponent(keyId)}`);
	}

	async listSpaces(): Promise<Space[]> {
		const body = await this.call('GET', '/spaces');
		const spaces = body['spaces'];
		if (!Array.isArray(spaces)) {
			throw new ApiError('unexpected', 200);
		}
		return spaces.map(readSpace);
	}

	/** Creates the personal space, or returns the existing one. */
	async ensurePersonalSpace(name: string): Promise<Space> {
		return readSpace(await this.call('POST', '/spaces', { name, kind: 'personal' }));
	}

	async scanSettings(): Promise<ScanSettings> {
		return readScanSettings(await this.call('GET', '/scan-settings'));
	}

	async setScanEnabled(enabled: boolean): Promise<ScanSettings> {
		return readScanSettings(
			await this.call('PUT', '/scan-settings', { scan_enabled: enabled }),
		);
	}

	async setScanMode(spaceId: string, mode: ScanMode): Promise<Space> {
		return readSpace(
			await this.call('PUT', `/spaces/${encodeURIComponent(spaceId)}/scan-mode`, {
				scan_mode: mode,
			}),
		);
	}

	/** Asks for properties for a note's text. The server keeps nothing. */
	async suggestProperties(markdown: string): Promise<Suggestion> {
		return readSuggestion(await this.call('POST', '/suggest-properties', { markdown }));
	}

	/** Turns the scanner's base metadata on or off for a space. Owner only. */
	async setBaseMetadata(spaceId: string, enabled: boolean): Promise<Space> {
		return readSpace(
			await this.call('PUT', `/spaces/${encodeURIComponent(spaceId)}/base-metadata`, {
				base_metadata: enabled,
			}),
		);
	}

	/**
	 * Asks for base metadata in the space's older notes too. Owner only. Returns
	 * the updated space when the server sends it back.
	 */
	async requestBaseBackfill(spaceId: string): Promise<Space | null> {
		const body = await this.call('POST', `/spaces/${encodeURIComponent(spaceId)}/base-metadata/backfill`);
		return typeof body['space_id'] === 'string' ? readSpace(body) : null;
	}

	private async call(
		method: HttpRequest['method'],
		path: string,
		payload?: unknown,
		authenticated = true,
	): Promise<Record<string, unknown>> {
		const headers: Record<string, string> = { Accept: 'application/json' };
		if (authenticated) {
			if (this.key === null) {
				throw new ApiError('unauthenticated', 0);
			}
			headers['Authorization'] = `Bearer ${this.key}`;
		}
		const request: HttpRequest = {
			url: `${this.server}/notes/api${path}`,
			method,
			headers,
		};
		if (payload !== undefined) {
			headers['Content-Type'] = 'application/json';
			request.body = JSON.stringify(payload);
		}

		let response: HttpResponse;
		try {
			response = await this.http(request);
		} catch {
			throw new ApiError('network', 0);
		}
		if (response.status >= 200 && response.status < 300) {
			if (response.text.trim() === '') {
				return {};
			}
			const body = parseJson(response.text);
			if (body === null) {
				throw new ApiError('unexpected', response.status);
			}
			return body;
		}
		throw errorFor(response);
	}
}

function errorFor(response: HttpResponse): ApiError {
	const code = parseJson(response.text)?.['error'];
	const retryAfter = parseRetryAfter(headerValue(response.headers, 'retry-after'));
	switch (code) {
		case 'unauthenticated':
			return new ApiError('unauthenticated', response.status);
		case 'invalid_code':
			return new ApiError('invalid-code', response.status);
		case 'locked':
			return new ApiError('locked', response.status, retryAfter);
		case 'insufficient_scope':
		case 'forbidden':
			return new ApiError('forbidden', response.status);
		case 'not_found':
			return new ApiError('not-found', response.status);
		case 'invalid_request':
			return new ApiError('invalid-request', response.status);
		case 'database_unavailable':
			return new ApiError('unavailable', response.status, retryAfter);
		case 'base_metadata_off':
			return new ApiError('base-metadata-off', response.status);
	}
	if (response.status === 401) {
		return new ApiError('unauthenticated', response.status);
	}
	if (response.status === 429) {
		return new ApiError('locked', response.status, retryAfter);
	}
	if (response.status >= 500) {
		return new ApiError('unavailable', response.status, retryAfter);
	}
	return new ApiError('unexpected', response.status);
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) {
			return value;
		}
	}
	return undefined;
}

function parseRetryAfter(value: string | undefined): number | null {
	if (value === undefined || !/^\d+$/.test(value.trim())) {
		return null;
	}
	return Number(value.trim());
}

function parseJson(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function requireString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	if (typeof value !== 'string' || value === '') {
		throw new ApiError('unexpected', 200);
	}
	return value;
}

function optionalString(body: Record<string, unknown>, key: string): string {
	const value = body[key];
	return typeof value === 'string' ? value : '';
}

function requireNumber(body: Record<string, unknown>, key: string): number {
	const value = body[key];
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new ApiError('unexpected', 200);
	}
	return value;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ApiError('unexpected', 200);
	}
	return value as Record<string, unknown>;
}

function readPerson(value: unknown): Person {
	const person = asRecord(value);
	return {
		id: requireString(person, 'id'),
		displayName: optionalString(person, 'display_name'),
	};
}

const ROLES: readonly SpaceRole[] = ['owner', 'editor', 'viewer'];
const SCAN_MODES: readonly ScanMode[] = ['off', 'suggest', 'auto'];

function readSpace(value: unknown): Space {
	const space = asRecord(value);
	const role = space['role'];
	const scanMode = space['scan_mode'];
	return {
		id: requireString(space, 'space_id'),
		name: optionalString(space, 'name'),
		kind: space['kind'] === 'shared' ? 'shared' : 'personal',
		role: ROLES.includes(role as SpaceRole) ? (role as SpaceRole) : 'viewer',
		scanMode: SCAN_MODES.includes(scanMode as ScanMode) ? (scanMode as ScanMode) : 'off',
		archived: space['archived'] === true,
		baseMetadata: typeof space['base_metadata'] === 'boolean' ? space['base_metadata'] : null,
		baseBackfillRequested: space['base_backfill_requested'] === true,
	};
}

function readSuggestion(body: Record<string, unknown>): Suggestion {
	const raw = body['patch'];
	let patch: PropertyPatch | null = null;
	if (raw !== null && raw !== undefined) {
		// A patch in any other shape is refused whole, never applied in part.
		patch = readPatch(raw);
		if (patch === null) {
			throw new ApiError('unexpected', 200);
		}
	}
	const matches = Array.isArray(body['matches']) ? body['matches'] : [];
	const errors = Array.isArray(body['errors']) ? body['errors'] : [];
	return {
		patch,
		matches: matches.flatMap((value: unknown) => {
			if (typeof value !== 'object' || value === null) {
				return [];
			}
			const match = value as Record<string, unknown>;
			return [
				{
					kind: optionalString(match, 'kind'),
					id: optionalString(match, 'id'),
					name: optionalString(match, 'name'),
					reason: optionalString(match, 'reason'),
					matched: optionalString(match, 'matched'),
				},
			];
		}),
		errors: errors.flatMap((value: unknown) => {
			if (typeof value !== 'object' || value === null) {
				return [];
			}
			const error = value as Record<string, unknown>;
			const key = error['key'];
			return [{ key: typeof key === 'string' ? key : null, code: optionalString(error, 'code') }];
		}),
	};
}

function readScanSettings(value: unknown): ScanSettings {
	const settings = asRecord(value);
	return {
		scanEnabled: settings['scan_enabled'] === true,
		operatorEnabled: settings['operator_enabled'] === true,
	};
}
