import { IndexeddbPersistence } from 'y-indexeddb';
import type { LocalStoreFactory } from './docs';

/**
 * Keeps documents in the app's IndexedDB, which works the same on desktop and
 * mobile. Database names carry a per-vault prefix so two vaults on one device
 * never share a document.
 */
export function indexedDbStores(prefix: string): LocalStoreFactory {
	return (name, doc) => {
		const persistence = new IndexeddbPersistence(`${prefix}-${name}`, doc);
		return {
			loaded: persistence.whenSynced.then(() => undefined),
			get: (key) => persistence.get(key) as Promise<unknown>,
			set: async (key, value) => {
				// IndexedDB stores typed arrays as they are; the typings only list ArrayBuffer.
				await persistence.set(key, value as string | ArrayBuffer);
			},
			destroy: () => persistence.destroy(),
			clear: () => persistence.clearData(),
		};
	};
}
