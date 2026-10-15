import {
	HocuspocusProvider,
	HocuspocusProviderWebsocket,
	WebSocketStatus,
} from '@hocuspocus/provider';
import * as Y from 'yjs';
import type {
	ConnectionState,
	DocSource,
	LocalStore,
	LocalStoreFactory,
	OpenDoc,
} from './docs';

/** Why the server could not be used. */
export class SyncAccessError extends Error {
	constructor(readonly kind: 'refused' | 'outdated' | 'network') {
		super(`Sync unavailable: ${kind}`);
		this.name = 'SyncAccessError';
	}
}

/**
 * Grants access to the sync socket. Each call checks that the server still
 * accepts this plugin version and returns a fresh short-lived sync token, or
 * throws a SyncAccessError.
 */
export type SyncAccess = () => Promise<string>;

export interface HocuspocusOptions {
	/** wss:// address of the sync socket. */
	url: string;
	access: SyncAccess;
	stores: LocalStoreFactory;
	/** Name of the document that stays attached and keeps the socket alive. */
	primary: string;
	/** Socket implementation for environments without a global one (tests). */
	socketImpl?: unknown;
	/** Documents authenticated at once; the server limits pending ones per socket. */
	batchSize?: number;
	/** How long to wait for one batch before moving on. */
	batchTimeoutMs?: number;
	/** Reuse a sync token for this long; tokens are valid for ten minutes. */
	tokenReuseMs?: number;
	minRetryMs?: number;
	maxRetryMs?: number;
}

/** After this many refused documents on one socket, stop asking: the server closes it at five. */
const MAX_REFUSALS_PER_CONNECTION = 3;

/**
 * Socket that drops messages while it is not open, instead of queueing them
 * for the next connection. Every attach starts with a full sync handshake, so
 * nothing is lost; and a queued close message for a document must never reach
 * the server after that document is attached again.
 */
class FreshSocket extends HocuspocusProviderWebsocket {
	send(message: unknown): void {
		const socket = this.webSocket;
		if (socket !== null && socket.readyState === 1) {
			socket.send(message as Uint8Array);
		}
	}
}

class Entry implements OpenDoc {
	readonly doc = new Y.Doc();
	readonly store: LocalStore;
	readonly provider: HocuspocusProvider;
	synced = false;
	refused = false;
	private waiters: Array<() => void> = [];

	constructor(
		readonly name: string,
		stores: LocalStoreFactory,
		socket: HocuspocusProviderWebsocket,
		token: () => Promise<string>,
		keepAlive: boolean,
	) {
		this.store = stores(name, this.doc);
		this.provider = new HocuspocusProvider({
			name,
			document: this.doc,
			websocketProvider: socket,
			token,
			// Only the primary document carries presence; its periodic renewal is
			// what keeps an idle socket open on both ends.
			...(keepAlive ? {} : { awareness: null }),
		});
	}

	whenSynced(): Promise<void> {
		if (this.synced) {
			return Promise.resolve();
		}
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	markSynced(): void {
		this.synced = true;
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) {
			resolve();
		}
	}
}

/**
 * Documents synced over one shared Hocuspocus socket. The primary document
 * (the space index) is attached first; other documents follow in batches once
 * it is synced, and again in batches after every reconnect.
 */
export class HocuspocusDocSource implements DocSource {
	state: ConnectionState = 'connecting';
	private readonly socket: FreshSocket;
	private readonly entries = new Map<string, Entry>();
	private readonly queue: string[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly batchSize: number;
	private readonly batchTimeoutMs: number;
	private readonly tokenReuseMs: number;
	private readonly minRetryMs: number;
	private readonly maxRetryMs: number;
	private token: { value: string; at: number } | null = null;
	private tokenRequest: Promise<string> | null = null;
	/** Bumped on every disconnect so stale batch loops stop. */
	private generation = 0;
	private refusalsThisConnection = 0;
	private primaryRefusals = 0;
	private retryMs: number;
	private retryTimer: number | null = null;
	private attaching = false;
	private stopped = false;

	constructor(private readonly options: HocuspocusOptions) {
		this.batchSize = options.batchSize ?? 40;
		this.batchTimeoutMs = options.batchTimeoutMs ?? 15_000;
		this.tokenReuseMs = options.tokenReuseMs ?? 8 * 60_000;
		this.minRetryMs = options.minRetryMs ?? 1_000;
		this.maxRetryMs = options.maxRetryMs ?? 60_000;
		this.retryMs = this.minRetryMs;

		this.socket = new FreshSocket({
			url: options.url,
			autoConnect: false,
			WebSocketPolyfill: options.socketImpl,
			delay: this.minRetryMs,
			minDelay: this.minRetryMs,
			maxDelay: this.maxRetryMs,
		});
		this.socket.on('status', ({ status }: { status: WebSocketStatus }) => {
			if (status === WebSocketStatus.Connected) {
				this.setState('online');
			}
		});
		this.socket.on('disconnect', () => this.onDisconnect());
		this.socket.on('maxAttemptsFailed', () => this.onDisconnect());
	}

	get pending(): number {
		let count = 0;
		for (const entry of this.entries.values()) {
			if (entry.refused) {
				continue;
			}
			// Offline, only documents with local edits are waiting for anything.
			if (entry.provider.hasUnsyncedChanges || (this.state !== 'offline' && !entry.synced)) {
				count++;
			}
		}
		return count;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Starts connecting; documents can be opened before or after. */
	start(): void {
		this.stopped = false;
		void this.connect();
	}

	open(name: string): OpenDoc {
		const existing = this.entries.get(name);
		if (existing !== undefined) {
			return existing;
		}
		const primary = name === this.options.primary;
		const entry = new Entry(name, this.options.stores, this.socket, () => this.syncToken(), primary);
		entry.provider.on('synced', () => {
			entry.markSynced();
			if (primary) {
				this.primaryRefusals = 0;
				this.retryMs = this.minRetryMs;
				void this.attachQueued();
			}
			this.notify();
		});
		entry.provider.on('unsyncedChanges', () => this.notify());
		entry.provider.on('authenticationFailed', () => this.onRefused(entry));
		entry.provider.on('close', () => {
			// The server closed this document while the socket stays open, as it
			// does when shutting down. Start over on a new socket.
			if (this.socket.status === WebSocketStatus.Connected) {
				this.socket.disconnect();
			}
		});
		this.entries.set(name, entry);

		if (primary) {
			entry.provider.attach();
		} else {
			this.queue.push(name);
			void this.attachQueued();
		}
		this.notify();
		return entry;
	}

	async close(name: string): Promise<void> {
		const entry = this.entries.get(name);
		if (entry === undefined) {
			return;
		}
		this.entries.delete(name);
		this.removeFromQueue(name);
		entry.provider.destroy();
		await entry.store.destroy();
		entry.doc.destroy();
		this.notify();
	}

	async destroy(): Promise<void> {
		this.stopped = true;
		this.clearRetry();
		this.generation++;
		const names = [...this.entries.keys()];
		for (const name of names) {
			await this.close(name);
		}
		this.socket.disconnect();
		this.socket.destroy();
		this.listeners.clear();
	}

	private async connect(): Promise<void> {
		this.clearRetry();
		if (this.stopped) {
			return;
		}
		try {
			await this.syncToken(true);
		} catch (error) {
			const kind = error instanceof SyncAccessError ? error.kind : 'network';
			if (kind === 'refused' || kind === 'outdated') {
				this.halt(kind);
				return;
			}
			this.setState('offline');
			this.scheduleRetry();
			return;
		}
		if (this.stopped) {
			return;
		}
		void this.socket.connect();
	}

	private syncToken(force = false): Promise<string> {
		const token = this.token;
		if (!force && token !== null && Date.now() - token.at < this.tokenReuseMs) {
			return Promise.resolve(token.value);
		}
		if (this.tokenRequest === null) {
			this.tokenRequest = this.options
				.access()
				.then((value) => {
					this.token = { value, at: Date.now() };
					return value;
				})
				.finally(() => {
					this.tokenRequest = null;
				});
		}
		// Inside the provider a failure must not escape: an empty token is
		// refused by the server, which is handled like any other refusal.
		return force ? this.tokenRequest : this.tokenRequest.catch(() => '');
	}

	private onDisconnect(): void {
		this.generation++;
		this.refusalsThisConnection = 0;
		// Reconnect on our own schedule, after checking access again.
		this.socket.disconnect();
		for (const entry of this.entries.values()) {
			if (entry.refused) {
				// Detached now that the socket is closed, so no close message goes out.
				if (entry.provider.isAttached) {
					entry.provider.detach();
				}
				continue;
			}
			entry.synced = false;
			entry.provider.synced = false;
			if (entry.name !== this.options.primary && entry.provider.isAttached) {
				entry.provider.detach();
				this.queue.push(entry.name);
			}
		}
		if (!this.stopped && this.state !== 'refused' && this.state !== 'outdated') {
			this.setState('offline');
			this.scheduleRetry();
		}
		this.notify();
	}

	private onRefused(entry: Entry): void {
		entry.refused = true;
		this.refusalsThisConnection++;
		if (entry.name === this.options.primary) {
			this.primaryRefusals++;
			entry.refused = false;
			if (this.primaryRefusals >= 2) {
				// Refused again with a fresh token: this device has lost access.
				this.halt('refused');
				return;
			}
			// Try once more with a fresh token before giving up.
			this.token = null;
			this.socket.disconnect();
			return;
		}
		// Left attached until the socket closes: a close message for a document
		// the server never opened would count against this socket's limits.
		entry.markSynced();
		this.notify();
	}

	/** Attaches queued documents in batches, waiting for each batch to sync. */
	private async attachQueued(): Promise<void> {
		const primary = this.entries.get(this.options.primary);
		if (this.attaching || primary === undefined || !primary.synced) {
			return;
		}
		this.attaching = true;
		const generation = this.generation;
		try {
			while (this.queue.length > 0 && generation === this.generation && !this.stopped) {
				if (this.refusalsThisConnection >= MAX_REFUSALS_PER_CONNECTION) {
					break;
				}
				const batch = this.queue.splice(0, this.batchSize);
				const waits: Promise<void>[] = [];
				for (const name of batch) {
					const entry = this.entries.get(name);
					if (entry === undefined || entry.refused) {
						continue;
					}
					entry.provider.attach();
					waits.push(entry.whenSynced());
				}
				await Promise.race([
					Promise.all(waits),
					new Promise((resolve) => window.setTimeout(resolve, this.batchTimeoutMs)),
				]);
			}
		} finally {
			this.attaching = false;
		}
		this.notify();
	}

	private halt(state: 'refused' | 'outdated'): void {
		this.stopped = true;
		this.clearRetry();
		this.generation++;
		this.socket.disconnect();
		this.setState(state);
	}

	private scheduleRetry(): void {
		this.clearRetry();
		const delay = this.retryMs;
		this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			void this.connect();
		}, delay);
	}

	private clearRetry(): void {
		if (this.retryTimer !== null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	private removeFromQueue(name: string): void {
		const index = this.queue.indexOf(name);
		if (index !== -1) {
			this.queue.splice(index, 1);
		}
	}

	private setState(state: ConnectionState): void {
		if (this.state !== state) {
			this.state = state;
			this.notify();
		}
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}
