import { describe, expect, it } from 'vitest';
import { ApiError, NotesApi, type HttpResponse } from '../src/api';
import { describeVersion, reasonLabel, sizeLabel } from '../src/history';

const SERVER = 'https://notes.example.test';
const ID = '3b9a0c2e-6f43-4d6e-9a53-0d5f0a1b2c3d';

const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, text: JSON.stringify(body) });

const entry = (version: number, extra: Record<string, unknown> = {}) => ({
	version,
	created_at: '2026-10-16T09:41:07.213456+00:00',
	actor_kind: 'person',
	actor_label: 'you',
	reason: 'idle',
	size: 2048,
	...extra,
});

describe('history wording', () => {
	it('names why a version was cut, and reads an unknown reason as an edit', () => {
		expect(reasonLabel('idle')).toBe('Edit');
		expect(reasonLabel('agent')).toBe('Agent edit');
		expect(reasonLabel('scan')).toBe('Scanner edit');
		expect(reasonLabel('restore')).toBe('Restored');
		expect(reasonLabel('something-new')).toBe('Edit');
	});

	it('sizes in bytes, then KB and MB', () => {
		expect(sizeLabel(12)).toBe('12 B');
		expect(sizeLabel(2048)).toBe('2.0 KB');
		expect(sizeLabel(20 * 1024)).toBe('20 KB');
		expect(sizeLabel(3 * 1024 * 1024)).toBe('3.0 MB');
	});

	it('describes a version in one line, leaving out what the server did not send', () => {
		const line = describeVersion({
			version: 3,
			createdAt: '2026-10-16T09:41:07+00:00',
			actorKind: 'person',
			actorLabel: 'you',
			reason: 'manual',
			size: 2048,
		});
		expect(line).toContain(': Edit by you, 2.0 KB');
		const bare = describeVersion({ version: 3, createdAt: 'x', actorKind: '', actorLabel: '', reason: '', size: 0 });
		expect(bare).toBe('x: Edit');
	});
});

describe('NotesApi history', () => {
	it('lists a page, newest first, and continues with before', async () => {
		const urls: string[] = [];
		const api = new NotesApi(
			async (request) => {
				urls.push(`${request.method} ${request.url}`);
				return json(200, { versions: [entry(12), entry(9, { reason: 'scan', actor_kind: 'scanner' })], next_before: 9 });
			},
			SERVER,
			'key',
		);
		const page = await api.noteVersions(ID);
		expect(page.nextBefore).toBe(9);
		expect(page.versions.map((v) => [v.version, v.reason, v.actorKind, v.size])).toEqual([
			[12, 'idle', 'person', 2048],
			[9, 'scan', 'scanner', 2048],
		]);
		await api.noteVersions(ID, 9, 20);
		expect(urls).toEqual([
			`GET ${SERVER}/notes/api/notes/${ID}/versions?limit=50`,
			`GET ${SERVER}/notes/api/notes/${ID}/versions?limit=20&before=9`,
		]);
	});

	it('ends at a null next_before and tolerates a missing size', async () => {
		const api = new NotesApi(
			async () => json(200, { versions: [{ ...entry(1), size: undefined }], next_before: null }),
			SERVER,
			'key',
		);
		const page = await api.noteVersions(ID);
		expect(page.nextBefore).toBeNull();
		expect(page.versions[0]?.size).toBe(0);
	});

	it('reads one version with its text, and reports a 404 and a malformed answer', async () => {
		const ok = new NotesApi(async () => json(200, { ...entry(12), size: undefined, text: '---\nx: 1\n---\nbody' }), SERVER, 'key');
		const version = await ok.noteVersion(ID, 12);
		expect(version.text).toBe('---\nx: 1\n---\nbody');
		expect(version.version).toBe(12);

		const missing = new NotesApi(async () => json(404, { error: 'not_found' }), SERVER, 'key');
		await expect(missing.noteVersion(ID, 99)).rejects.toMatchObject({ kind: 'not-found' });

		const bad = new NotesApi(async () => json(200, { versions: 'no' }), SERVER, 'key');
		await expect(bad.noteVersions(ID)).rejects.toBeInstanceOf(ApiError);
		const noText = new NotesApi(async () => json(200, entry(1)), SERVER, 'key');
		await expect(noText.noteVersion(ID, 1)).rejects.toBeInstanceOf(ApiError);
	});
});
