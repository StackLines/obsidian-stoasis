import { describe, expect, it } from 'vitest';
import { ApiError, NotesApi, type HttpRequest, type HttpResponse } from '../src/api';
import { checkCompatibility, compareVersions, describeIncompatibility } from '../src/version';

const SERVER = 'https://notes.example.test';

function client(respond: (request: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
	const sent: HttpRequest[] = [];
	const api = new NotesApi(async (request) => {
		sent.push(request);
		return respond(request);
	}, SERVER);
	return { api, sent };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
	return { status, headers, text: JSON.stringify(body) };
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ApiError) {
			return error;
		}
		throw error;
	}
	throw new Error('Expected the call to fail');
}

describe('NotesApi', () => {
	it('reads the version without a credential', async () => {
		const { api, sent } = client(() => json(200, { api: 1, min_plugin: '0.1.0' }));
		expect(await api.version()).toEqual({ api: 1, minPlugin: '0.1.0' });
		expect(sent[0]).toEqual({
			url: `${SERVER}/notes/api/version`,
			method: 'GET',
			headers: { Accept: 'application/json' },
		});
	});

	it('pairs with a code and a device label', async () => {
		const { api, sent } = client(() =>
			json(201, {
				token: 'k',
				key_id: 'id',
				label: 'Phone',
				person: { id: 'p', display_name: 'Ada' },
				server: SERVER,
			}),
		);
		expect(await api.pair('ABCD2345', ' Phone ')).toEqual({
			token: 'k',
			keyId: 'id',
			label: 'Phone',
			person: { id: 'p', displayName: 'Ada' },
		});
		expect(sent[0]?.method).toBe('POST');
		expect(sent[0]?.headers['Authorization']).toBeUndefined();
		expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ code: 'ABCD2345', device_label: 'Phone' });
	});

	it('sends the device key as a bearer header', async () => {
		const { api, sent } = client(() => json(200, { token: 't', expires_at: 'later' }));
		expect(await api.withKey('secret').syncToken()).toEqual({ token: 't', expiresAt: 'later' });
		expect(sent[0]?.headers['Authorization']).toBe('Bearer secret');
		expect(sent[0]?.url).toBe(`${SERVER}/notes/api/sync-token`);
	});

	it('refuses authenticated calls without a key, before sending anything', async () => {
		const { api, sent } = client(() => json(200, {}));
		expect((await failure(api.me())).kind).toBe('unauthenticated');
		expect(sent).toEqual([]);
	});

	it('lists spaces and fills in safe defaults', async () => {
		const { api } = client(() =>
			json(200, {
				spaces: [
					{
						space_id: 's1',
						name: 'Mine',
						kind: 'personal',
						role: 'owner',
						scan_mode: 'suggest',
						archived: false,
						base_metadata: false,
						base_backfill_requested: true,
					},
					{ space_id: 's2', kind: 'team', role: 'admin', scan_mode: 'later' },
				],
			}),
		);
		expect(await api.withKey('k').listSpaces()).toEqual([
			{
				id: 's1',
				name: 'Mine',
				kind: 'personal',
				role: 'owner',
				scanMode: 'suggest',
				archived: false,
				baseMetadata: false,
				baseBackfillRequested: true,
				usage: null,
			},
			// A server without base metadata yet says nothing about it.
			{
				id: 's2',
				name: '',
				kind: 'personal',
				role: 'viewer',
				scanMode: 'off',
				archived: false,
				baseMetadata: null,
				baseBackfillRequested: false,
				usage: null,
			},
		]);
	});

	it('creates the personal space idempotently', async () => {
		const { api, sent } = client(() =>
			json(201, { space_id: 's1', name: 'Personal', kind: 'personal', role: 'owner', scan_mode: 'off', archived: false }),
		);
		expect((await api.withKey('k').ensurePersonalSpace('Personal')).id).toBe('s1');
		expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ name: 'Personal', kind: 'personal' });
	});

	it('reads and sets the scan switch and a space scan mode', async () => {
		const { api, sent } = client((request) =>
			request.url.endsWith('/scan-mode')
				? json(200, { space_id: 's1', role: 'owner', scan_mode: 'auto' })
				: json(200, { scan_enabled: true, operator_enabled: false }),
		);
		const keyed = api.withKey('k');
		expect(await keyed.scanSettings()).toEqual({ scanEnabled: true, operatorEnabled: false });
		await keyed.setScanEnabled(false);
		expect((await keyed.setScanMode('s/1', 'auto')).scanMode).toBe('auto');
		expect(sent.map((r) => `${r.method} ${r.url.slice(SERVER.length)} ${r.body ?? ''}`)).toEqual([
			'GET /notes/api/scan-settings ',
			'PUT /notes/api/scan-settings {"scan_enabled":false}',
			'PUT /notes/api/spaces/s%2F1/scan-mode {"scan_mode":"auto"}',
		]);
	});

	it('switches base metadata and asks for it in older notes', async () => {
		const space = { space_id: 's1', role: 'owner', scan_mode: 'auto', base_metadata: true, base_backfill_requested: true };
		let answer: HttpResponse = json(200, space);
		const { api, sent } = client(() => answer);
		const keyed = api.withKey('k');
		expect((await keyed.setBaseMetadata('s1', true)).baseMetadata).toBe(true);
		expect((await keyed.requestBaseBackfill('s1'))?.baseBackfillRequested).toBe(true);
		// The answer to a backfill request is not specified beyond success.
		answer = { status: 202, headers: {}, text: '' };
		expect(await keyed.requestBaseBackfill('s1')).toBeNull();
		answer = json(409, { error: 'base_metadata_off', message: 'x' });
		expect((await failure(keyed.requestBaseBackfill('s1'))).kind).toBe('base-metadata-off');
		expect(sent.map((r) => `${r.method} ${r.url.slice(SERVER.length)} ${r.body ?? ''}`)).toEqual([
			'PUT /notes/api/spaces/s1/base-metadata {"base_metadata":true}',
			'POST /notes/api/spaces/s1/base-metadata/backfill ',
			'POST /notes/api/spaces/s1/base-metadata/backfill ',
			'POST /notes/api/spaces/s1/base-metadata/backfill ',
		]);
	});

	it('asks for properties for a note, and reads the patch strictly', async () => {
		let answer: unknown = {
			patch: { tags_add: ['garden'], set: { 'brain-people': ['[[Alice Stone]]'] }, actor: 'agent' },
			matches: [{ kind: 'person', id: 'p1', name: 'Alice Stone', reason: 'wikilink', matched: 'Alice Stone' }, 'junk'],
			errors: [{ key: null, code: 'frontmatter_unparseable' }],
		};
		const { api, sent } = client(() => json(200, answer));
		const keyed = api.withKey('k');
		expect(await keyed.suggestProperties('# Note\n')).toEqual({
			patch: { tagsAdd: ['garden'], set: { 'brain-people': ['[[Alice Stone]]'] }, actor: 'agent' },
			matches: [{ kind: 'person', id: 'p1', name: 'Alice Stone', reason: 'wikilink', matched: 'Alice Stone' }],
			errors: [{ key: null, code: 'frontmatter_unparseable' }],
		});
		expect(sent[0]).toMatchObject({ method: 'POST', url: `${SERVER}/notes/api/suggest-properties` });
		expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ markdown: '# Note\n' });

		answer = { patch: null, matches: [], errors: [] };
		expect((await keyed.suggestProperties('x')).patch).toBeNull();
		answer = { patch: { tags_add: [], set: { title: 'x' }, actor: 'agent' }, matches: [], errors: [] };
		expect((await failure(keyed.suggestProperties('x'))).kind).toBe('unexpected');
	});

	it('revokes a device by id and accepts an empty answer', async () => {
		const { api, sent } = client(() => ({ status: 204, headers: {}, text: '' }));
		await api.withKey('k').revokeDevice('key 1');
		expect(sent[0]).toMatchObject({ method: 'DELETE', url: `${SERVER}/notes/api/devices/key%201` });
	});

	it.each([
		[401, 'unauthenticated', 'unauthenticated'],
		[403, 'insufficient_scope', 'forbidden'],
		[403, 'forbidden', 'forbidden'],
		[400, 'invalid_code', 'invalid-code'],
		[400, 'invalid_request', 'invalid-request'],
		[404, 'not_found', 'not-found'],
		[503, 'database_unavailable', 'unavailable'],
		[409, 'base_metadata_off', 'base-metadata-off'],
		[401, 'something_new', 'unauthenticated'],
		[502, 'something_new', 'unavailable'],
		[418, 'something_new', 'unexpected'],
	])('maps status %i with error %s to %s', async (status, code, kind) => {
		const { api } = client(() => json(status, { error: code, message: 'x' }));
		expect((await failure(api.version())).kind).toBe(kind);
	});

	it('reads how long to wait from a lockout', async () => {
		const { api } = client(() => json(429, { error: 'locked', message: 'x' }, { 'Retry-After': '120' }));
		const error = await failure(api.pair('ABCD2345', ''));
		expect(error.kind).toBe('locked');
		expect(error.retryAfter).toBe(120);
	});

	it('reports a network failure and an unreadable answer', async () => {
		const offline = new NotesApi(() => Promise.reject(new Error('down')), SERVER);
		expect((await failure(offline.version())).kind).toBe('network');
		const { api } = client(() => ({ status: 200, headers: {}, text: '<html>' }));
		expect((await failure(api.version())).kind).toBe('unexpected');
		const { api: missing } = client(() => json(200, { api: '1' }));
		expect((await failure(missing.version())).kind).toBe('unexpected');
	});
});

describe('version gate', () => {
	it('compares plain versions', () => {
		expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
		expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
		expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
		expect(compareVersions('1.0', '1.0.0')).toBe(0);
		expect(compareVersions('0.1.0-beta', '0.1.0')).toBe(0);
	});

	it('accepts a server that this plugin is new enough for', () => {
		expect(checkCompatibility({ api: 1, minPlugin: '0.1.0' }, '0.1.0')).toEqual({ ok: true });
		expect(checkCompatibility({ api: 1, minPlugin: '0.0.9' }, '0.1.0')).toEqual({ ok: true });
	});

	it('asks for an update when the server needs a newer plugin or protocol', () => {
		const old = checkCompatibility({ api: 1, minPlugin: '0.2.0' }, '0.1.0');
		expect(old).toEqual({ ok: false, reason: 'plugin-too-old', minPlugin: '0.2.0' });
		const api = checkCompatibility({ api: 2, minPlugin: '0.1.0' }, '0.1.0');
		expect(api).toEqual({ ok: false, reason: 'api-unsupported', minPlugin: '0.1.0' });
		if (!old.ok && !api.ok) {
			expect(describeIncompatibility(old)).toContain('0.2.0 or later');
			expect(describeIncompatibility(api)).toContain('newer protocol');
		}
	});
});
