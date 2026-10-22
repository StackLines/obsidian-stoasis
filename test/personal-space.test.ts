import { describe, expect, it } from 'vitest';
import type { NotesApi, Space } from '../src/api';
import { personalSpace } from '../src/pairing';

function space(id: string, over: Partial<Space> = {}): Space {
	return {
		id,
		name: id,
		kind: 'personal',
		role: 'owner',
		scanMode: 'off',
		archived: false,
		baseMetadata: null,
		baseBackfillRequested: false,
		usage: null,
		...over,
	};
}

function fakeApi(listed: Space[]): { api: NotesApi; created: string[] } {
	const created: string[] = [];
	const api = {
		listSpaces: () => Promise.resolve(listed),
		ensurePersonalSpace: (name: string) => {
			created.push(name);
			return Promise.resolve(space('created'));
		},
	} as unknown as NotesApi;
	return { api, created };
}

describe('the personal space of a person', () => {
	it('is the one they own, even when a space shared with them is listed first', async () => {
		const { api, created } = fakeApi([space('a-shared', { role: 'editor' }), space('mine')]);
		expect((await personalSpace(api)).id).toBe('mine');
		expect(created).toEqual([]);
	});

	it('is created when they only have spaces of other people, or an archived one', async () => {
		const { api, created } = fakeApi([
			space('a-shared', { role: 'viewer' }),
			space('old', { archived: true }),
		]);
		expect((await personalSpace(api)).id).toBe('created');
		expect(created).toEqual(['Personal']);
	});
});
