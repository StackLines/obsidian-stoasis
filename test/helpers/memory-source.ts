import * as Y from 'yjs';
import type { ConnectionState, DocSource, LocalStoreFactory, OpenDoc } from '../../src/sync/docs';
import type { VaultAdapter } from '../../src/sync/engine';

/** The server side for in-memory devices: one document per name. */
export class MemoryHub {
	readonly docs = new Map<string, Y.Doc>();

	doc(name: string): Y.Doc {
		let doc = this.docs.get(name);
		if (doc === undefined) {
			doc = new Y.Doc();
			this.docs.set(name, doc);
		}
		return doc;
	}

	text(name: string, field = 'content'): string {
		return this.doc(name).getText(field).toJSON();
	}
}

class MemoryOpenDoc implements OpenDoc {
	readonly doc = new Y.Doc();
	synced = false;
	refused = false;
	private waiters: Array<() => void> = [];
	private unlink: (() => void) | null = null;

	readonly store: ReturnType<LocalStoreFactory>;

	constructor(
		readonly name: string,
		stores: LocalStoreFactory,
		private readonly hub: MemoryHub,
	) {
		this.store = stores(name, this.doc);
	}

	whenSynced(): Promise<void> {
		return this.synced ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
	}

	connect(): void {
		if (this.unlink !== null) {
			return;
		}
		const remote = this.hub.doc(this.name);
		const fromHub = Symbol('hub');
		const toHub = Symbol('device');
		Y.applyUpdate(remote, Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(remote)), toHub);
		Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(this.doc)), fromHub);
		const up = (update: Uint8Array, origin: unknown) => {
			if (origin !== fromHub) {
				Y.applyUpdate(remote, update, toHub);
			}
		};
		const down = (update: Uint8Array, origin: unknown) => {
			if (origin !== toHub) {
				Y.applyUpdate(this.doc, update, fromHub);
			}
		};
		this.doc.on('update', up);
		remote.on('update', down);
		this.unlink = () => {
			this.doc.off('update', up);
			remote.off('update', down);
		};
		this.synced = true;
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) {
			resolve();
		}
	}

	disconnect(): void {
		this.unlink?.();
		this.unlink = null;
		this.synced = false;
	}
}

/** A DocSource whose "server" is a MemoryHub, with a switch for going offline. */
export class MemoryDocSource implements DocSource {
	state: ConnectionState = 'online';
	private readonly docs = new Map<string, MemoryOpenDoc>();
	private readonly listeners = new Set<() => void>();

	constructor(
		private readonly hub: MemoryHub,
		private readonly stores: LocalStoreFactory,
		online = true,
	) {
		this.state = online ? 'online' : 'offline';
	}

	get pending(): number {
		return [...this.docs.values()].filter((d) => !d.synced).length;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	open(name: string): OpenDoc {
		let entry = this.docs.get(name);
		if (entry === undefined) {
			entry = new MemoryOpenDoc(name, this.stores, this.hub);
			this.docs.set(name, entry);
			if (this.state === 'online') {
				entry.connect();
			}
		}
		return entry;
	}

	async close(name: string): Promise<void> {
		const entry = this.docs.get(name);
		if (entry !== undefined) {
			entry.disconnect();
			this.docs.delete(name);
			await entry.store.destroy();
		}
	}

	setOnline(online: boolean): void {
		this.state = online ? 'online' : 'offline';
		for (const entry of this.docs.values()) {
			if (online) {
				entry.connect();
			} else {
				entry.disconnect();
			}
		}
		for (const listener of this.listeners) {
			listener();
		}
	}

	async destroy(): Promise<void> {
		for (const name of [...this.docs.keys()]) {
			await this.close(name);
		}
	}
}

export interface VaultListener {
	fileCreated(path: string): void;
	fileModified(path: string): void;
	fileDeleted(path: string): void;
	fileRenamed(path: string, oldPath: string): void;
}

/**
 * Files in memory. Like Obsidian, every change fires an event afterwards,
 * whether the user or the plugin made it.
 */
export class FakeVault implements VaultAdapter {
	readonly files = new Map<string, string>();
	readonly trashed: string[] = [];
	listener: VaultListener | null = null;

	listMarkdown(folder: string): string[] {
		return [...this.files.keys()].filter((p) => p.startsWith(`${folder}/`) && p.endsWith('.md'));
	}

	exists(path: string): boolean {
		return this.files.has(path);
	}

	read(path: string): Promise<string> {
		const text = this.files.get(path);
		return text === undefined ? Promise.reject(new Error(`No file ${path}`)) : Promise.resolve(text);
	}

	create(path: string, text: string): Promise<void> {
		if (this.files.has(path)) {
			return Promise.reject(new Error(`File exists: ${path}`));
		}
		this.files.set(path, text);
		this.emit((l) => l.fileCreated(path));
		return Promise.resolve();
	}

	process(path: string, update: (current: string) => string): Promise<void> {
		const current = this.files.get(path);
		if (current === undefined) {
			return Promise.reject(new Error(`No file ${path}`));
		}
		const next = update(current);
		this.files.set(path, next);
		if (next !== current) {
			this.emit((l) => l.fileModified(path));
		}
		return Promise.resolve();
	}

	rename(from: string, to: string): Promise<void> {
		const text = this.files.get(from);
		if (text === undefined || this.files.has(to)) {
			return Promise.reject(new Error(`Cannot rename ${from} to ${to}`));
		}
		this.files.delete(from);
		this.files.set(to, text);
		this.emit((l) => l.fileRenamed(to, from));
		return Promise.resolve();
	}

	trash(path: string): Promise<void> {
		if (!this.files.delete(path)) {
			return Promise.reject(new Error(`No file ${path}`));
		}
		this.trashed.push(path);
		this.emit((l) => l.fileDeleted(path));
		return Promise.resolve();
	}

	// What the user does.

	write(path: string, text: string): void {
		const existed = this.files.has(path);
		this.files.set(path, text);
		this.emit((l) => (existed ? l.fileModified(path) : l.fileCreated(path)));
	}

	remove(path: string): void {
		this.files.delete(path);
		this.emit((l) => l.fileDeleted(path));
	}

	move(from: string, to: string): void {
		void this.rename(from, to);
	}

	private emit(event: (listener: VaultListener) => void): void {
		const listener = this.listener;
		if (listener !== null) {
			queueMicrotask(() => event(listener));
		}
	}
}
