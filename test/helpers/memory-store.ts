import * as Y from 'yjs';
import type { LocalStore, LocalStoreFactory } from '../../src/sync/docs';

/** What one device keeps locally, surviving a simulated restart. */
export interface MemoryDisk {
	updates: Map<string, Uint8Array[]>;
	values: Map<string, Map<string, Uint8Array | string>>;
}

export function memoryDisk(): MemoryDisk {
	return { updates: new Map(), values: new Map() };
}

/** A LocalStoreFactory that keeps documents in memory, like IndexedDB would on a device. */
export function memoryStores(disk: MemoryDisk): LocalStoreFactory {
	return (name: string, doc: Y.Doc): LocalStore => {
		const updates = disk.updates.get(name) ?? [];
		disk.updates.set(name, updates);
		const values = disk.values.get(name) ?? new Map<string, Uint8Array | string>();
		disk.values.set(name, values);

		const STORE_ORIGIN = Symbol('memory-store');
		if (updates.length > 0) {
			Y.applyUpdate(doc, Y.mergeUpdates(updates), STORE_ORIGIN);
		}
		const onUpdate = (update: Uint8Array, origin: unknown) => {
			if (origin !== STORE_ORIGIN) {
				updates.push(update);
			}
		};
		doc.on('update', onUpdate);
		let destroyed = false;
		return {
			loaded: Promise.resolve(),
			get: (key) => Promise.resolve(values.get(key)),
			set: (key, value) => {
				if (!destroyed) {
					values.set(key, value);
				}
				return Promise.resolve();
			},
			destroy: () => {
				destroyed = true;
				doc.off('update', onUpdate);
				return Promise.resolve();
			},
			clear: () => {
				destroyed = true;
				doc.off('update', onUpdate);
				disk.updates.delete(name);
				disk.values.delete(name);
				return Promise.resolve();
			},
		};
	};
}
