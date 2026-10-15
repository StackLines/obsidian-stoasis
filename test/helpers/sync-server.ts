import type { Socket } from 'node:net';
import { Server } from '@hocuspocus/server';
import * as Y from 'yjs';

/**
 * A real Hocuspocus server on a random local port, keeping documents in
 * memory, with token checks like a compatible server would make.
 */
export class TestSyncServer {
	readonly stored = new Map<string, Uint8Array>();
	/** Tokens the server accepts. */
	readonly validTokens = new Set(['good']);
	/** Documents nobody may open. */
	readonly forbidden = new Set<string>();
	/** Documents refused once each, then allowed. */
	readonly refuseOnce = new Set<string>();
	/**
	 * Like a real server: a note may only be opened once a space lists it,
	 * in the space's stored or live state.
	 */
	requireListing = false;
	/** Authentications in flight right now, and the most seen at once. */
	pendingAuth = 0;
	maxPendingAuth = 0;
	authDelayMs = 0;
	refusals = 0;
	private server: Server | null = null;
	private readonly sockets = new Set<Socket>();
	private port = 0;

	get url(): string {
		return `ws://127.0.0.1:${this.port}`;
	}

	async start(): Promise<void> {
		const server = new Server({
			port: this.port,
			address: '127.0.0.1',
			quiet: true,
			stopOnSignals: false,
			onAuthenticate: async ({ token, documentName }) => {
				this.pendingAuth++;
				this.maxPendingAuth = Math.max(this.maxPendingAuth, this.pendingAuth);
				try {
					if (this.authDelayMs > 0) {
						await new Promise((resolve) => setTimeout(resolve, this.authDelayMs));
					}
					const once = this.refuseOnce.delete(documentName);
					if (
						!this.validTokens.has(token) ||
						this.forbidden.has(documentName) ||
						once ||
						(this.requireListing && !this.listed(documentName))
					) {
						this.refusals++;
						throw new Error('refused');
					}
				} finally {
					this.pendingAuth--;
				}
			},
			onLoadDocument: async ({ documentName, document }) => {
				const state = this.stored.get(documentName);
				if (state !== undefined) {
					Y.applyUpdate(document, state);
				}
				return document;
			},
			onChange: async ({ documentName, document }) => {
				this.stored.set(documentName, Y.encodeStateAsUpdate(document));
			},
		});
		server.httpServer.on('connection', (socket: Socket) => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});
		await server.listen();
		this.port = server.address.port;
		this.server = server;
	}

	/** Shuts down the way a server process does, closing documents first. */
	async stop(): Promise<void> {
		await this.server?.destroy();
		this.server = null;
		this.dropSockets();
	}

	/** Loses the network: sockets die without a closing handshake. */
	async drop(): Promise<void> {
		this.dropSockets();
		await this.stop();
	}

	private dropSockets(): void {
		for (const socket of this.sockets) {
			socket.destroy();
		}
		this.sockets.clear();
	}

	/** Whether a space lists the note `name`; documents other than notes always are. */
	private listed(name: string): boolean {
		if (!name.startsWith('note:')) {
			return true;
		}
		const id = name.slice('note:'.length);
		const lists = (doc: Y.Doc) =>
			[...doc.getMap('index').values()].some(
				(entry) => typeof entry === 'object' && entry !== null && (entry as { id?: unknown }).id === id,
			);
		for (const [docName, state] of this.stored) {
			if (docName.startsWith('space:')) {
				const doc = new Y.Doc();
				Y.applyUpdate(doc, state);
				if (lists(doc)) {
					return true;
				}
			}
		}
		for (const [docName, document] of this.server?.hocuspocus.documents ?? []) {
			if (docName.startsWith('space:') && lists(document)) {
				return true;
			}
		}
		return false;
	}

	/** The server's current text of a note, from what it stored. */
	text(name: string, field = 'content'): string {
		const doc = new Y.Doc();
		const state = this.stored.get(name);
		if (state !== undefined) {
			Y.applyUpdate(doc, state);
		}
		return doc.getText(field).toJSON();
	}
}

/** Polls until `check` passes or the time runs out. */
export async function eventually(check: () => void | Promise<void>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			await check();
			return;
		} catch (error) {
			if (Date.now() > deadline) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}
