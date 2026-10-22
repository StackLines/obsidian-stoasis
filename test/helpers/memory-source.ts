import * as Y from 'yjs';
import type { ConnectionState, DocSource, LocalStoreFactory, OpenDoc } from '../../src/sync/docs';
import type { VaultAdapter } from '../../src/sync/engine';
import type { Mapping } from '../../src/sync/paths';

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
		private readonly changed: () => void,
	) {
		this.store = stores(name, this.doc);
	}

	/** Every change reaches the hub at once while connected. */
	get confirmed(): boolean {
		return this.synced;
	}

	whenSynced(): Promise<void> {
		return this.synced ? Promise.resolve() : new Promise((resolve) => this.waiters.push(resolve));
	}

	/** Lets everyone waiting go on without syncing, as when the source shuts down. */
	settle(): void {
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) {
			resolve();
		}
	}

	connect(): void {
		if (this.unlink !== null) {
			return;
		}
		const remote = this.hub.doc(this.name);
		const fromHub = Symbol('hub');
		const toHub = Symbol('device');
		const up = (update: Uint8Array, origin: unknown) => {
			if (origin !== fromHub) {
				Y.applyUpdate(remote, update, toHub);
				// The server confirming the change, as a real source reports it.
				queueMicrotask(this.changed);
			}
		};
		const down = (update: Uint8Array, origin: unknown) => {
			if (origin !== toHub) {
				Y.applyUpdate(this.doc, update, fromHub);
			}
		};
		// Listening before the first exchange, as a provider does: a change
		// made while it is applied is sent too.
		this.doc.on('update', up);
		remote.on('update', down);
		Y.applyUpdate(remote, Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(remote)), toHub);
		Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(this.doc)), fromHub);
		this.unlink = () => {
			this.doc.off('update', up);
			remote.off('update', down);
		};
		this.synced = true;
		this.settle();
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

	get refused(): number {
		return 0;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	open(name: string): OpenDoc {
		let entry = this.docs.get(name);
		if (entry === undefined) {
			entry = new MemoryOpenDoc(name, this.stores, this.hub, () => this.notify());
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
			entry.settle();
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
		this.notify();
	}

	async destroy(): Promise<void> {
		for (const name of [...this.docs.keys()]) {
			await this.close(name);
		}
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

export interface VaultListener {
	fileCreated(path: string): void;
	fileModified(path: string): void;
	fileDeleted(path: string): void;
	fileRenamed(path: string, oldPath: string): void;
}

export type VaultOperation = 'read' | 'create' | 'process' | 'rename' | 'trash';

/**
 * Files in memory. Like Obsidian, every change fires an event afterwards,
 * whether the user or the plugin made it. File operations take `ioDelayMs`
 * (zero by default), and `failNext` makes one of them fail, as a full disk or
 * a locked file would; `failAfterRead` makes the next `process` fail after
 * its callback ran, without changing the file.
 */
export class FakeVault implements VaultAdapter {
	readonly files = new Map<string, string>();
	readonly trashed: string[] = [];
	listener: VaultListener | null = null;
	ioDelayMs = 0;
	/**
	 * Like a file system that ignores case, as on macOS and iOS: "Note.md" is
	 * the file "note.md", so the engine may not create or move a file there.
	 * The user's own moves still work, as the app's file explorer does them.
	 */
	ignoresCase = false;
	/** Called as a file is renamed, as the app's open views follow it. */
	onRename: ((from: string, to: string) => void) | null = null;
	private readonly faults: Array<{ op: VaultOperation; path: string | null; message: string }> = [];
	private readonly lateFaults: Array<{ path: string | null; message: string }> = [];

	/** Makes the next `op` (on `path`, when given) fail with `message`. */
	failNext(op: VaultOperation, path: string | null = null, message = 'disk write failed'): void {
		this.faults.push({ op, path, message });
	}

	/** Makes the next `process` (on `path`, when given) fail once its callback ran. */
	failAfterRead(path: string | null = null, message = 'disk write failed'): void {
		this.lateFaults.push({ path, message });
	}

	listMarkdown(mapping: Mapping): string[] {
		// Everything, hidden folders included: the engine must drop those itself.
		return [...this.files.keys()].filter(
			(p) => p.endsWith('.md') && (mapping.kind === 'vault' || p.startsWith(`${mapping.path}/`)),
		);
	}

	exists(path: string): boolean {
		return this.files.has(path);
	}

	async read(path: string): Promise<string> {
		await this.io('read', path);
		const text = this.files.get(path);
		if (text === undefined) {
			throw new Error(`No file ${path}`);
		}
		return text;
	}

	async create(path: string, text: string): Promise<void> {
		await this.io('create', path);
		if (this.files.has(path) || this.inOtherCase(path)) {
			throw new Error(`File exists: ${path}`);
		}
		this.files.set(path, text);
		this.emit((l) => l.fileCreated(path));
	}

	async process(path: string, update: (current: string) => string): Promise<void> {
		await this.io('process', path);
		const current = this.files.get(path);
		if (current === undefined) {
			throw new Error(`No file ${path}`);
		}
		const next = update(current);
		const late = this.lateFaults.findIndex((f) => f.path === null || f.path === path);
		if (late !== -1) {
			const [fault] = this.lateFaults.splice(late, 1);
			throw new Error(fault?.message ?? 'failed');
		}
		this.files.set(path, next);
		if (next !== current) {
			this.emit((l) => l.fileModified(path));
		}
	}

	async rename(from: string, to: string): Promise<void> {
		await this.io('rename', from);
		const text = this.files.get(from);
		if (text === undefined || this.files.has(to) || this.inOtherCase(to)) {
			throw new Error(`Cannot rename ${from} to ${to}`);
		}
		this.files.delete(from);
		this.files.set(to, text);
		this.onRename?.(from, to);
		this.emit((l) => l.fileRenamed(to, from));
	}

	async trash(path: string): Promise<void> {
		await this.io('trash', path);
		if (!this.files.delete(path)) {
			throw new Error(`No file ${path}`);
		}
		this.trashed.push(path);
		this.emit((l) => l.fileDeleted(path));
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
		const text = this.files.get(from);
		if (text === undefined || this.files.has(to)) {
			throw new Error(`Cannot move ${from} to ${to}`);
		}
		this.files.delete(from);
		this.files.set(to, text);
		this.onRename?.(from, to);
		this.emit((l) => l.fileRenamed(to, from));
	}

	/**
	 * Whether, ignoring case, another name for `path`, or for one of its
	 * folders, is taken: a file system that ignores case finds it there.
	 */
	private inOtherCase(path: string): boolean {
		if (!this.ignoresCase) {
			return false;
		}
		const parts = path.split('/');
		return [...this.files.keys()].some((other) => {
			const otherParts = other.split('/');
			for (let i = 0; i < Math.min(parts.length, otherParts.length); i++) {
				const a = parts[i] as string;
				const b = otherParts[i] as string;
				if (a !== b) {
					const sameKind = (i === parts.length - 1) === (i === otherParts.length - 1);
					return sameKind && a.toLowerCase() === b.toLowerCase();
				}
			}
			return false;
		});
	}

	private async io(op: VaultOperation, path: string): Promise<void> {
		if (this.ioDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, this.ioDelayMs));
		}
		const index = this.faults.findIndex((f) => f.op === op && (f.path === null || f.path === path));
		if (index !== -1) {
			const [fault] = this.faults.splice(index, 1);
			throw new Error(fault?.message ?? 'failed');
		}
	}

	private emit(event: (listener: VaultListener) => void): void {
		const listener = this.listener;
		if (listener !== null) {
			queueMicrotask(() => event(listener));
		}
	}
}
