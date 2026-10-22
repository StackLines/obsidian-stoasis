import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyPatch, isEmptyPatch, normaliseTag, readPatch, splitTags } from '../src/frontmatter-patch';

// The server's shared vectors for the tagging contract, version 3. Names in
// them are invented.
interface NormaliseVector {
	name: string;
	actor: string;
	input: Record<string, unknown>;
	expect?: { tags_add: string[]; set: Record<string, unknown>; actor: string };
	expect_errors?: Array<{ key: string | null; code: string }>;
	tags_remove?: unknown;
}

interface ApplyVector {
	name: string;
	date: string;
	frontmatter: Record<string, unknown>;
	patch: unknown;
	/** The note's own id, as the plugin's index has it; only the copied-id vectors carry one. */
	note_id?: string;
	expect?: Record<string, unknown>;
	expect_refused?: boolean;
}

const vectors = JSON.parse(
	readFileSync(fileURLToPath(new URL('./fixtures/tagging_vectors.json', import.meta.url)), 'utf8'),
) as { version: number; normalise: NormaliseVector[]; apply: ApplyVector[] };

describe('tagging contract vectors', () => {
	it('are version 3, with every apply and normalise vector', () => {
		expect(vectors.version).toBe(3);
		expect(vectors.apply).toHaveLength(70);
		expect(vectors.normalise).toHaveLength(88);
	});

	for (const vector of vectors.apply) {
		if (vector.expect_refused === true) {
			// The patch is refused before the frontmatter is touched.
			it(`refuses: ${vector.name}`, () => {
				const before = structuredClone(vector.frontmatter);
				expect(readPatch(vector.patch)).toBeNull();
				expect(vector.frontmatter).toEqual(before);
			});
			continue;
		}
		it(`applies: ${vector.name}`, () => {
			const patch = readPatch(vector.patch);
			expect(patch).not.toBeNull();
			const before = structuredClone(vector.frontmatter);
			const result = applyPatch(vector.frontmatter, patch!, vector.date, vector.note_id);
			// Key order counts as much as the values.
			expect(Object.entries(result)).toEqual(Object.entries(vector.expect!));
			expect(vector.frontmatter).toEqual(before);
			if (JSON.stringify(vector.expect) === JSON.stringify(before)) {
				expect(result).toBe(vector.frontmatter);
			}
		});
	}

	it('accepts every patch the server produces, removals included', () => {
		const produced = vectors.normalise.filter((v) => v.expect !== undefined);
		expect(produced.some((v) => 'tags_remove' in v.expect!)).toBe(true);
		expect(produced.length).toBeGreaterThan(30);
		for (const vector of produced) {
			expect(readPatch(vector.expect), vector.name).not.toBeNull();
		}
	});

	it('compares tags the way the server normalises them', () => {
		let checked = 0;
		for (const vector of vectors.normalise) {
			const raw = vector.input['tags'];
			// Removals are the server's to normalise (section 2.5).
			if (vector.expect === undefined || raw === undefined || vector.tags_remove !== undefined) {
				continue;
			}
			const items = typeof raw === 'string' ? splitTags(raw) : (raw as string[]);
			const normalised = [...new Set(items.map(normaliseTag).filter((t): t is string => t !== null))];
			expect(normalised, vector.name).toEqual(vector.expect.tags_add);
			checked++;
		}
		expect(checked).toBeGreaterThan(10);
	});
});

describe('readPatch', () => {
	const ok = { tags_add: ['a'], set: { 'brain-type': 'idea' }, actor: 'agent' };

	it('reads a patch shaped as the contract says', () => {
		expect(readPatch(ok)).toEqual({ tagsAdd: ['a'], set: { 'brain-type': 'idea' }, actor: 'agent' });
	});

	it('refuses any other shape rather than guessing', () => {
		const refused: unknown[] = [
			null,
			[],
			'patch',
			{ tags_add: ['a'], set: {} },
			{ ...ok, extra: 1 },
			{ ...ok, actor: 'someone' },
			{ ...ok, actor: 'scan:' },
			{ ...ok, actor: 'scan:Upper' },
			{ ...ok, tags_add: 'a' },
			{ ...ok, tags_add: [1] },
			{ ...ok, set: [] },
			{ ...ok, set: { tags: ['a'] } },
			{ ...ok, set: { 'brain-tagged': '2026-10-13 by agent' } },
			{ ...ok, set: { title: 'mine' } },
			{ ...ok, set: { 'brain-type': ['idea'] } },
			{ ...ok, set: { 'brain-people': '[[Alice]]' } },
			{ ...ok, set: { 'brain-topics': [1] } },
		];
		for (const value of refused) {
			expect(readPatch(value), JSON.stringify(value)).toBeNull();
		}
	});

	it('takes base keys only from the scanner', () => {
		const base = { tags_add: [], set: { 'brain-id': '5f0c2a9e-3b1d-4c7e-8a6f-0d2b4e6c8a1f' } };
		expect(readPatch({ ...base, actor: 'agent' })).toBeNull();
		expect(readPatch({ ...base, actor: 'scan:base' })).not.toBeNull();
	});

	it('knows an empty patch', () => {
		expect(isEmptyPatch({ tagsAdd: [], set: {}, actor: 'agent' })).toBe(true);
		expect(isEmptyPatch({ tagsAdd: ['a'], set: {}, actor: 'agent' })).toBe(false);
		expect(isEmptyPatch({ tagsAdd: [], set: { 'brain-topics': [] }, actor: 'agent' })).toBe(false);
	});
});

describe('readPatch with tags_remove', () => {
	const scan = { tags_add: [], tags_remove: ['wip'], set: {}, actor: 'scan:tags' };

	it('reads a removal from the scanner, as one to five tags', () => {
		expect(readPatch(scan)).toEqual({ tagsAdd: [], tagsRemove: ['wip'], set: {}, actor: 'scan:tags' });
		expect(readPatch({ ...scan, tags_remove: ['a', 'b', 'c', 'd', 'e'] })).not.toBeNull();
	});

	it('is not an empty patch, and a patch without removals has no such key', () => {
		expect(isEmptyPatch(readPatch(scan)!)).toBe(false);
		expect(readPatch({ tags_add: [], set: {}, actor: 'scan:tags' })).not.toHaveProperty('tagsRemove');
	});

	it('refuses the other shapes', () => {
		for (const value of [
			{ ...scan, actor: 'agent' },
			{ ...scan, tags_remove: [] },
			{ ...scan, tags_remove: ['a', 'b', 'c', 'd', 'e', 'f'] },
			{ ...scan, tags_remove: null },
			{ ...scan, tags_remove: 'wip' },
			{ ...scan, tags_remove: [1] },
			{ ...scan, tags_add: ['#WIP'] },
		]) {
			expect(readPatch(value), JSON.stringify(value)).toBeNull();
		}
	});
});

describe('applyPatch with a note id', () => {
	const OWN = '5f0c2a9e-3b1d-4c7e-8a6f-0d2b4e6c8a1f';
	const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
	const patch = readPatch({ tags_add: [], set: { 'brain-id': OWN }, actor: 'scan:base' })!;

	it('replaces a copy\'s id only when it is given the note\'s own', () => {
		const copy = { 'brain-id': OTHER };
		expect(applyPatch(copy, patch, '2026-10-20', OWN)['brain-id']).toBe(OWN);
		expect(applyPatch(copy, patch, '2026-10-20')).toBe(copy);
	});
});

describe('applyPatch', () => {
	it('never shares a list with the patch', () => {
		const patch = readPatch({ tags_add: [], set: { 'brain-topics': [] }, actor: 'agent' })!;
		const result = applyPatch({ 'brain-topics': ['x'] }, patch, '2026-10-16');
		(result['brain-topics'] as string[]).push('y');
		expect(patch.set['brain-topics']).toEqual([]);
	});

	it('keeps tags it cannot read, whatever else they hold', () => {
		const patch = readPatch({ tags_add: ['a'], set: {}, actor: 'agent' })!;
		const frontmatter = { tags: { nested: true } };
		expect(applyPatch(frontmatter, patch, '2026-10-16')).toBe(frontmatter);
		expect(applyPatch({ tags: [2024, 'a'] }, patch, '2026-10-16')).toEqual({ tags: [2024, 'a'] });
	});
});
