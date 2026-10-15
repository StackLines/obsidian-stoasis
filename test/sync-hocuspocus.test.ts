import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HocuspocusDocSource, SyncAccessError, type SyncAccess } from '../src/sync/hocuspocus';
import { INDEX_FIELD, NOTE_FIELD, noteDocName, spaceDocName } from '../src/sync/docs';
import { memoryDisk, memoryStores, type MemoryDisk } from './helpers/memory-store';
import { eventually, TestSyncServer } from './helpers/sync-server';

const SPACE = spaceDocName('6f1c1d9e-8f0a-4a57-9a51-2f4f3e0f9a10');

function note(n: number): string {
	return noteDocName(`00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`);
}

/** The ws client throws on an unhandled error event; browsers only report it. */
class TestSocket extends WebSocket {
	constructor(address: string) {
		super(address);
		this.on('error', () => undefined);
	}
}

let server: TestSyncServer;
const sources: HocuspocusDocSource[] = [];

function device(options: { access?: SyncAccess; disk?: MemoryDisk; batchSize?: number } = {}) {
	const source = new HocuspocusDocSource({
		url: server.url,
		access: options.access ?? (() => Promise.resolve('good')),
		stores: memoryStores(options.disk ?? memoryDisk()),
		primary: SPACE,
		socketImpl: TestSocket,
		batchSize: options.batchSize,
		minRetryMs: 50,
		maxRetryMs: 200,
	});
	sources.push(source);
	return source;
}

beforeEach(async () => {
	server = new TestSyncServer();
	await server.start();
});

afterEach(async () => {
	for (const source of sources.splice(0)) {
		await source.destroy();
	}
	await server.stop();
});

describe('HocuspocusDocSource', () => {
	it('syncs a note between two devices over one socket each', async () => {
		const a = device();
		a.start();
		a.open(SPACE).doc.getMap(INDEX_FIELD).set('Hello.md', { id: 'x', kind: 'markdown' });
		const noteA = a.open(note(1));
		noteA.doc.getText(NOTE_FIELD).insert(0, 'Hello from A');

		const b = device();
		b.start();
		const indexB = b.open(SPACE);
		const noteB = b.open(note(1));
		await noteB.whenSynced();
		await eventually(() => expect(noteB.doc.getText(NOTE_FIELD).toJSON()).toBe('Hello from A'));
		expect(indexB.doc.getMap(INDEX_FIELD).get('Hello.md')).toEqual({ id: 'x', kind: 'markdown' });

		noteB.doc.getText(NOTE_FIELD).insert(0, '# ');
		await eventually(() => expect(noteA.doc.getText(NOTE_FIELD).toJSON()).toBe('# Hello from A'));
		await eventually(() => expect(a.state).toBe('online'));
		await eventually(() => expect(a.pending).toBe(0));
	});

	it('authenticates notes in batches, never more at once than the batch size', async () => {
		server.authDelayMs = 20;
		const a = device({ batchSize: 10 });
		a.start();
		a.open(SPACE);
		const notes = Array.from({ length: 60 }, (_, i) => a.open(note(i + 1)));
		await Promise.all(notes.map((n) => n.whenSynced()));
		// The space document may be authenticating alongside the first batch.
		expect(server.maxPendingAuth).toBeLessThanOrEqual(11);
		expect(notes.every((n) => n.synced)).toBe(true);
	});

	it.each([
		['the network drops', () => server.drop()],
		['the server shuts down', () => server.stop()],
	])('keeps offline edits and sends them after reconnecting when %s', async (_, stopServer) => {
		const a = device();
		a.start();
		a.open(SPACE);
		const noteA = a.open(note(1));
		noteA.doc.getText(NOTE_FIELD).insert(0, 'online');
		await eventually(() => expect(server.text(note(1))).toBe('online'));

		await stopServer();
		await eventually(() => expect(a.state).toBe('offline'));
		noteA.doc.getText(NOTE_FIELD).insert(6, ', then offline');
		expect(a.pending).toBeGreaterThan(0);

		await server.start();
		await eventually(() => expect(server.text(note(1))).toBe('online, then offline'), 8000);
		await eventually(() => expect(a.state).toBe('online'));
		await eventually(() => expect(a.pending).toBe(0));
	}, 15_000);

	it('loads what a device stored before going offline, without the server', async () => {
		const disk = memoryDisk();
		const a = device({ disk });
		a.start();
		a.open(SPACE);
		a.open(note(1)).doc.getText(NOTE_FIELD).insert(0, 'kept on the device');
		await eventually(() => expect(server.text(note(1))).toBe('kept on the device'));
		await a.destroy();
		await server.stop();

		const again = device({ disk });
		again.start();
		const reopened = again.open(note(1));
		await reopened.store.loaded;
		expect(reopened.doc.getText(NOTE_FIELD).toJSON()).toBe('kept on the device');
	});

	it('reports a device that lost access after one retry with a fresh token', async () => {
		let calls = 0;
		const a = device({
			access: () => {
				calls++;
				return Promise.resolve('revoked');
			},
		});
		a.start();
		a.open(SPACE);
		await eventually(() => expect(a.state).toBe('refused'));
		expect(calls).toBe(2);
		const refusals = server.refusals;
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(server.refusals).toBe(refusals);
	});

	it('stops when the server needs a newer plugin', async () => {
		const a = device({ access: () => Promise.reject(new SyncAccessError('outdated')) });
		a.start();
		a.open(SPACE);
		await eventually(() => expect(a.state).toBe('outdated'));
	});

	it('stops when the key was revoked', async () => {
		const a = device({ access: () => Promise.reject(new SyncAccessError('refused')) });
		a.start();
		a.open(SPACE);
		await eventually(() => expect(a.state).toBe('refused'));
	});

	it('retries while the server cannot be reached', async () => {
		let fail = true;
		const a = device({
			access: () => (fail ? Promise.reject(new SyncAccessError('network')) : Promise.resolve('good')),
		});
		a.start();
		a.open(SPACE);
		await eventually(() => expect(a.state).toBe('offline'));
		fail = false;
		await eventually(() => expect(a.state).toBe('online'));
	});

	it('keeps syncing other notes when one is refused', async () => {
		server.forbidden.add(note(2));
		const a = device();
		a.start();
		a.open(SPACE);
		const ok = a.open(note(1));
		const refused = a.open(note(2));
		ok.doc.getText(NOTE_FIELD).insert(0, 'fine');
		await eventually(() => expect(refused.refused).toBe(true));
		await eventually(() => expect(server.text(note(1))).toBe('fine'));
		expect(a.state).toBe('online');
	});
});
