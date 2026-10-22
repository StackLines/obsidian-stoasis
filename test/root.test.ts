import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { INDEX_FIELD } from '../src/sync/docs';
import { markVaultRooted, planReroot, readRootMeta, rerootIndex, translateKnown } from '../src/sync/root';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function space(): Y.Doc {
	const doc = new Y.Doc();
	const index = doc.getMap<unknown>(INDEX_FIELD);
	index.set('One.md', { id: A, kind: 'markdown' });
	index.set('Deep/Two.md', { id: B, kind: 'markdown' });
	return doc;
}

describe('moving a space to the vault root', () => {
	it('puts every path under the folder and keeps the ids', () => {
		const doc = space();
		expect(rerootIndex(doc, 'notes')).toBe(2);
		const index = doc.getMap<unknown>(INDEX_FIELD);
		expect([...index.keys()].sort()).toEqual(['notes/Deep/Two.md', 'notes/One.md']);
		expect(index.get('notes/One.md')).toEqual({ id: A, kind: 'markdown' });
		expect(readRootMeta(doc)).toEqual({ root: 'vault', epoch: 1, prefix: 'notes' });
	});

	it('does it in one change, so no state with some paths moved is ever stored', () => {
		const doc = space();
		let updates = 0;
		doc.on('update', () => updates++);
		rerootIndex(doc, 'a/b');
		expect(updates).toBe(1);
	});

	it('keeps entries this plugin does not sync, as they are', () => {
		const doc = space();
		doc.getMap<unknown>(INDEX_FIELD).set('file.png', { id: A, kind: 'attachment', extra: 1 });
		rerootIndex(doc, 'notes');
		expect(doc.getMap<unknown>(INDEX_FIELD).get('notes/file.png')).toEqual({ id: A, kind: 'attachment', extra: 1 });
	});

	it('moves a space only once', () => {
		const doc = space();
		expect(rerootIndex(doc, 'notes')).toBe(2);
		expect(rerootIndex(doc, 'other')).toBeNull();
		expect(doc.getMap<unknown>(INDEX_FIELD).has('notes/One.md')).toBe(true);
	});

	it('refuses a folder that is not a safe path, and paths that would merge', () => {
		expect(planReroot(['a.md'], '')).toEqual({ ok: false, reason: 'prefix' });
		expect(planReroot(['a.md'], '../up')).toEqual({ ok: false, reason: 'prefix' });
		expect(planReroot(['a.md'], '.hidden')).toEqual({ ok: false, reason: 'prefix' });
		expect(planReroot(['a.md', 'A.md'], 'n')).toEqual({ ok: false, reason: 'collision' });
		expect(planReroot(['x'.repeat(1020) + '.md'], 'notes')).toEqual({ ok: false, reason: 'long' });
		const doc = space();
		expect(rerootIndex(doc, '/abs')).toBeNull();
		expect(readRootMeta(doc)).toBeNull();
	});

	it('marks a space that starts at the vault root from the beginning, once', () => {
		const doc = new Y.Doc();
		markVaultRooted(doc, 'origin');
		markVaultRooted(doc, 'origin');
		expect(readRootMeta(doc)).toEqual({ root: 'vault', epoch: 1, prefix: '' });
	});

	it('reads a space without a marker, or with a damaged one, as synced from a folder', () => {
		const doc = new Y.Doc();
		expect(readRootMeta(doc)).toBeNull();
		doc.getMap<unknown>('meta').set('root', 'vault');
		expect(readRootMeta(doc)).toBeNull();
	});

	it('translates what a device knew to the new root', () => {
		expect(translateKnown({ 'One.md': A, 'Deep/Two.md': B }, 'notes')).toEqual({
			'notes/One.md': A,
			'notes/Deep/Two.md': B,
		});
	});
});
