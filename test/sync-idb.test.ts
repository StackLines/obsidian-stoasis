import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { indexedDbStores } from '../src/sync/idb';

describe('device storage', () => {
	it('keeps a document and side values across sessions', async () => {
		const stores = indexedDbStores('vault-a');
		const doc = new Y.Doc();
		const store = stores('note:1', doc);
		await store.loaded;
		doc.getText('content').insert(0, 'kept offline');
		await store.set('base', new Uint8Array([1, 2, 3]));
		await store.set('label', 'text');
		await store.destroy();

		const again = new Y.Doc();
		const reopened = stores('note:1', again);
		await reopened.loaded;
		expect(again.getText('content').toJSON()).toBe('kept offline');
		expect(Array.from((await reopened.get('base')) as Uint8Array)).toEqual([1, 2, 3]);
		expect(await reopened.get('label')).toBe('text');
		await reopened.destroy();
	});

	it('keeps vaults apart and forgets a document when cleared', async () => {
		const doc = new Y.Doc();
		const store = indexedDbStores('vault-b')('note:2', doc);
		await store.loaded;
		doc.getText('content').insert(0, 'only in b');
		await new Promise((resolve) => setTimeout(resolve, 50));

		const other = new Y.Doc();
		const elsewhere = indexedDbStores('vault-c')('note:2', other);
		await elsewhere.loaded;
		expect(other.getText('content').toJSON()).toBe('');
		await elsewhere.destroy();

		await store.clear();
		const fresh = new Y.Doc();
		const cleared = indexedDbStores('vault-b')('note:2', fresh);
		await cleared.loaded;
		expect(fresh.getText('content').toJSON()).toBe('');
		await cleared.destroy();
	});
});
