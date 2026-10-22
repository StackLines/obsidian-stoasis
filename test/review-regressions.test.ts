// Regression tests for defects found in review of the first release candidate.
// Each test reproduces a failure that used to happen and requires the fixed
// outcome: work preserved, failures reported, and stopping never stuck.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { SyncEngine, emptyEngineState, type EngineOptions, type EngineState } from '../src/sync/engine';
import { noteDocName, spaceDocName } from '../src/sync/docs';
import { HocuspocusDocSource, type HocuspocusOptions } from '../src/sync/hocuspocus';
import { EditorSync, type EditorPort } from '../src/sync/binding';
import type { TextEdit } from '../src/sync/text';
import { describeStatus } from '../src/status';
import type { StoasisSettingTab } from '../src/settings';
import StoasisPlugin from '../src/main';
import { FakeVault, MemoryDocSource, MemoryHub } from './helpers/memory-source';
import { memoryDisk, memoryStores, type MemoryDisk } from './helpers/memory-store';
import { TestSyncServer, eventually } from './helpers/sync-server';
import { App, notices, setRequestHandler, type ContainerEl, type RenderedItem } from './stubs/obsidian';
import { FakeControlPlane, SPACE_ID } from './helpers/control-plane';

const SPACE = spaceDocName(SPACE_ID);
const NOTE = noteDocName('00000000-0000-4000-8000-000000000001');
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
	setRequestHandler(null);
});

interface Device {
	source: MemoryDocSource;
	engine: SyncEngine;
	vault: FakeVault;
	disk: MemoryDisk;
	state: EngineState;
	problems: string[];
}

async function device(
	hub: MemoryHub,
	disk = memoryDisk(),
	state = emptyEngineState(),
	vault = new FakeVault(),
	online = true,
	more: Partial<EngineOptions> = {},
): Promise<Device> {
	const source = new MemoryDocSource(hub, memoryStores(disk), online);
	const problems: string[] = [];
	const engine = new SyncEngine({
		deleteBatchMs: 1,
		vault,
		source,
		spaceId: SPACE_ID,
		mapping: { kind: 'folder', path: 'Notes' },
		state,
		saveState: () => {},
		writeDelayMs: 1,
		onProblem: (problem) => problems.push(problem),
		...more,
	});
	vault.listener = engine;
	const started = engine.start();
	cleanups.push(async () => {
		vault.listener = null;
		await engine.stop();
		await source.destroy();
	});
	if (online) {
		await started;
	}
	return { source, engine, vault, disk, state, problems };
}

async function shutDown(d: Device): Promise<void> {
	d.vault.listener = null;
	await d.engine.stop();
	await d.source.destroy();
}

async function settle(...devices: Device[]): Promise<void> {
	for (let round = 0; round < 20; round++) {
		await delay(3);
		for (const d of devices) {
			await d.engine.idle();
		}
	}
}

function index(hub: MemoryHub): Record<string, { id: string }> {
	return hub.doc(SPACE).getMap('index').toJSON();
}

function sorted(vault: FakeVault): Array<[string, string]> {
	return [...vault.files].sort(([a], [b]) => a.localeCompare(b));
}

/** An open editor showing `text`, as the binding sees it. */
function editor(text: string): EditorPort & { shown: string } {
	const port = {
		shown: text,
		text: () => port.shown,
		applyRemote(edits: readonly TextEdit[]) {
			for (const edit of [...edits].reverse()) {
				port.shown = port.shown.slice(0, edit.pos) + edit.ins + port.shown.slice(edit.pos + edit.del);
			}
		},
	};
	return port;
}

describe('engine', () => {
	it('keeps offline work that this device already ingested when the note is deleted elsewhere', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		const b = await device(hub);
		a.vault.write('Notes/N.md', 'original');
		await settle(a, b);
		a.source.setOnline(false);
		a.vault.write('Notes/N.md', 'original with irreplaceable offline work');
		b.vault.remove('Notes/N.md');
		await settle(a, b);
		a.source.setOnline(true);
		await settle(a, b);
		expect(a.vault.trashed).toEqual([]);
		expect(a.vault.files.get('Notes/N.md')).toBe('original with irreplaceable offline work');
		expect(b.vault.files.get('Notes/N.md')).toBe('original with irreplaceable offline work');
		expect(Object.keys(index(hub))).toEqual(['N.md']);
		expect(hub.text(noteDocName(index(hub)['N.md']!.id))).toBe('original with irreplaceable offline work');
	});

	it('still removes a note deleted elsewhere that had no changes here', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		const b = await device(hub);
		a.vault.write('Notes/N.md', 'original');
		await settle(a, b);
		b.vault.remove('Notes/N.md');
		await settle(a, b);
		expect(a.vault.files.size).toBe(0);
		expect(a.vault.trashed).toEqual(['Notes/N.md']);
	});

	it('never removes vault files when the local sync cache is gone and the server cannot be reached', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		a.vault.write('Notes/N.md', 'only local recoverable copy');
		await settle(a);
		cleanups.pop();
		await shutDown(a);
		const again = await device(hub, memoryDisk(), a.state, a.vault, false);
		await settle(again);
		expect(again.vault.trashed).toEqual([]);
		expect(again.vault.files.get('Notes/N.md')).toBe('only local recoverable copy');
		expect(again.engine.ready).toBe(false);
		// Once the server is back the device rebuilds its cache from it and carries on.
		again.source.setOnline(true);
		await settle(again);
		expect(again.engine.ready).toBe(true);
		expect(again.vault.files.get('Notes/N.md')).toBe('only local recoverable copy');
		expect(again.vault.trashed).toEqual([]);
	});

	it('keeps a remote edit that arrives while the file is being written', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		a.vault.write('Notes/N.md', 'start');
		await settle(a);
		const id = a.state.known['N.md']!;
		const remote = hub.doc(noteDocName(id)).getText('content');
		const process = a.vault.process.bind(a.vault);
		let once = true;
		a.vault.process = async (path, update) => {
			await process(path, update);
			if (once) {
				once = false;
				remote.insert(remote.length, ' SECOND');
			}
		};
		remote.insert(remote.length, ' FIRST');
		await settle(a);
		expect(a.vault.files.get('Notes/N.md')).toBe('start FIRST SECOND');
		expect(remote.toJSON()).toBe('start FIRST SECOND');
	});

	it('does not turn a failed local create into a deletion of the remote note', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		a.vault.write('Notes/N.md', 'remote work');
		await settle(a);
		const vault = new FakeVault();
		// The first start creates files in an early pass and again in its full
		// pass, which reports what still fails: fail both.
		vault.failNext('create');
		vault.failNext('create');
		const b = await device(hub, memoryDisk(), emptyEngineState(), vault);
		await settle(a, b);
		expect(b.problems).toEqual(['Sync step failed: disk write failed']);
		expect(b.state.known['N.md']).toBeUndefined();
		b.engine.rescan();
		await settle(a, b);
		expect(Object.keys(index(hub))).toEqual(['N.md']);
		expect(a.vault.files.get('Notes/N.md')).toBe('remote work');
		expect(b.vault.files.get('Notes/N.md')).toBe('remote work');
	});

	it('gives a note one path after two devices rename it differently offline', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		const b = await device(hub);
		a.vault.write('Notes/N.md', 'original');
		await settle(a, b);
		a.source.setOnline(false);
		b.source.setOnline(false);
		a.vault.move('Notes/N.md', 'Notes/A.md');
		b.vault.move('Notes/N.md', 'Notes/B.md');
		await settle(a, b);
		a.source.setOnline(true);
		b.source.setOnline(true);
		await settle(a, b);
		expect(Object.keys(index(hub))).toEqual(['A.md']);
		expect(index(hub)['A.md']?.id).toBe(a.state.known['A.md']);
		expect(sorted(a.vault)).toEqual([['Notes/A.md', 'original']]);
		expect(sorted(b.vault)).toEqual([['Notes/A.md', 'original']]);
		a.vault.write('Notes/A.md', 'edit A');
		await settle(a, b);
		b.vault.write('Notes/A.md', 'edit A, then B');
		await settle(a, b);
		expect(sorted(a.vault)).toEqual([['Notes/A.md', 'edit A, then B']]);
		expect(sorted(b.vault)).toEqual(sorted(a.vault));
		expect(a.vault.trashed).toEqual([]);
		expect(b.vault.trashed).toEqual([]);
	});

	it('keeps an edit made on one device while another renames the note', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		const b = await device(hub);
		a.vault.write('Notes/N.md', 'original');
		await settle(a, b);
		a.source.setOnline(false);
		b.source.setOnline(false);
		a.vault.move('Notes/N.md', 'Notes/Renamed.md');
		b.vault.write('Notes/N.md', 'original, edited');
		await settle(a, b);
		a.source.setOnline(true);
		b.source.setOnline(true);
		await settle(a, b);
		expect(sorted(a.vault)).toEqual([['Notes/Renamed.md', 'original, edited']]);
		expect(sorted(b.vault)).toEqual(sorted(a.vault));
		expect(Object.keys(index(hub))).toEqual(['Renamed.md']);
	});

	it('applies a swap of two note names made on another device', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		const b = await device(hub);
		a.vault.write('Notes/X.md', 'x');
		a.vault.write('Notes/Y.md', 'y');
		await settle(a, b);
		a.vault.move('Notes/X.md', 'Notes/T.md');
		a.vault.move('Notes/Y.md', 'Notes/X.md');
		a.vault.move('Notes/T.md', 'Notes/Y.md');
		await settle(a, b);
		expect(sorted(a.vault)).toEqual([
			['Notes/X.md', 'y'],
			['Notes/Y.md', 'x'],
		]);
		expect(sorted(b.vault)).toEqual(sorted(a.vault));
		expect(b.vault.trashed).toEqual([]);
		expect(Object.keys(index(hub)).sort()).toEqual(['X.md', 'Y.md']);
		// Edits after the swap reach the right file.
		b.vault.write('Notes/X.md', 'y, edited');
		await settle(a, b);
		expect(a.vault.files.get('Notes/X.md')).toBe('y, edited');
		expect(a.vault.files.get('Notes/Y.md')).toBe('x');
	});

	it('applies a rotation of three note names made on another device', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		const b = await device(hub);
		for (const name of ['P', 'Q', 'R']) {
			a.vault.write(`Notes/${name}.md`, name.toLowerCase());
		}
		await settle(a, b);
		a.source.setOnline(false);
		a.vault.move('Notes/P.md', 'Notes/T.md');
		a.vault.move('Notes/R.md', 'Notes/P.md');
		a.vault.move('Notes/Q.md', 'Notes/R.md');
		a.vault.move('Notes/T.md', 'Notes/Q.md');
		await settle(a, b);
		a.source.setOnline(true);
		await settle(a, b);
		const expected = [
			['Notes/P.md', 'r'],
			['Notes/Q.md', 'p'],
			['Notes/R.md', 'q'],
		];
		expect(sorted(a.vault)).toEqual(expected);
		expect(sorted(b.vault)).toEqual(expected);
		expect(b.vault.trashed).toEqual([]);
	});
});

describe('second review', () => {
	it('fills a new note before other devices can open it, so their edits are kept', async () => {
		const hub = new MemoryHub();
		const b = await device(hub);
		const memory = memoryStores(memoryDisk());
		// This device is slow to load what it stored of a note.
		const source = new MemoryDocSource(hub, (name, doc) => {
			const store = memory(name, doc);
			return { ...store, loaded: name.startsWith('note:') ? delay(300) : store.loaded };
		});
		const vault = new FakeVault();
		const state = emptyEngineState();
		const engine = new SyncEngine({ deleteBatchMs: 1, vault, source, spaceId: SPACE_ID, mapping: { kind: 'folder', path: 'Notes' }, state, saveState: () => {}, writeDelayMs: 1 });
		vault.listener = engine;
		cleanups.push(async () => {
			vault.listener = null;
			await engine.stop();
			await source.destroy();
		});
		await engine.start();
		vault.write('Notes/New.md', 'created here');
		// The other device edits the note as soon as it appears.
		await eventually(() => expect(b.vault.files.has('Notes/New.md')).toBe(true));
		const seen = b.vault.files.get('Notes/New.md');
		b.vault.write('Notes/New.md', 'created here, and peer work');
		await b.engine.idle();
		await delay(400);
		await engine.idle();
		await settle(b);
		const name = noteDocName(state.known['New.md']!);
		expect(hub.text(name)).toBe('created here, and peer work');
		await eventually(() => expect(vault.files.get('Notes/New.md')).toBe('created here, and peer work'));
		expect(b.vault.files.get('Notes/New.md')).toBe('created here, and peer work');
		expect(seen).toBe('created here');
	});

	it('links an open editor to the note kept after another device deleted it', async () => {
		const hub = new MemoryHub();
		const editors = new EditorSync();
		const a = await device(hub, memoryDisk(), emptyEngineState(), new FakeVault(), true, {
			onRelink: (path) => editors.relink(path),
		});
		const b = await device(hub);
		a.vault.write('Notes/N.md', 'original');
		await settle(a, b);
		editors.setLinker(a.engine);
		const port = editor('original');
		const handle = editors.attach(port, 'Notes/N.md');
		await settle(a, b);
		const originalId = a.state.known['N.md'];
		a.source.setOnline(false);
		port.shown = 'original UNSAVED';
		handle.typed([{ pos: 8, del: 0, ins: ' UNSAVED' }]);
		b.vault.remove('Notes/N.md');
		await settle(a, b);
		a.source.setOnline(true);
		await settle(a, b);
		const keptId = a.state.known['N.md']!;
		expect(keptId).not.toBe(originalId);
		expect(index(hub)['N.md']?.id).toBe(keptId);
		// What the editor showed, saved or not, is the kept note.
		expect(hub.text(noteDocName(keptId))).toBe('original UNSAVED');
		await eventually(() => expect(b.vault.files.get('Notes/N.md')).toBe('original UNSAVED'));
		expect(handle.bound).toBe(true);
		// The editor follows the kept note both ways.
		b.vault.write('Notes/N.md', 'remote replacement');
		await settle(a, b);
		expect(port.shown).toBe('remote replacement');
		port.shown = 'remote replacement, typed';
		handle.typed([{ pos: 18, del: 0, ins: ', typed' }]);
		await settle(a, b);
		expect(hub.text(noteDocName(keptId))).toBe('remote replacement, typed');
		expect(b.vault.files.get('Notes/N.md')).toBe('remote replacement, typed');
		handle.detach();
		await settle(a, b);
		expect(a.vault.files.get('Notes/N.md')).toBe('remote replacement, typed');
		expect(a.vault.trashed).toEqual([]);
	});

	it('merges an outside edit once when the write fails after reading the file', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		a.vault.write('Notes/N.md', 'start');
		await settle(a);
		const remote = hub.doc(noteDocName(a.state.known['N.md']!)).getText('content');
		// Edited on disk, unseen yet; the write that finds it then fails.
		a.vault.files.set('Notes/N.md', 'start LOCAL');
		a.vault.failAfterRead('Notes/N.md');
		remote.insert(remote.length, ' REMOTE');
		await settle(a);
		expect(a.problems).toEqual(['Sync step failed: disk write failed']);
		expect(a.vault.files.get('Notes/N.md')).toBe('start LOCAL');
		a.engine.rescan();
		await settle(a);
		expect(remote.toJSON().match(/LOCAL/g)).toHaveLength(1);
		expect(remote.toJSON().match(/REMOTE/g)).toHaveLength(1);
		expect(a.vault.files.get('Notes/N.md')).toBe(remote.toJSON());
	});

	it('merges an outside edit once when the write fails after reading the file, across a restart', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		a.vault.write('Notes/N.md', 'start');
		await settle(a);
		const remote = hub.doc(noteDocName(a.state.known['N.md']!)).getText('content');
		a.vault.files.set('Notes/N.md', 'start LOCAL');
		a.vault.failAfterRead('Notes/N.md');
		remote.insert(remote.length, ' REMOTE');
		await settle(a);
		cleanups.pop();
		await shutDown(a);
		const again = await device(hub, a.disk, a.state, a.vault);
		await settle(again);
		expect(remote.toJSON().match(/LOCAL/g)).toHaveLength(1);
		expect(remote.toJSON().match(/REMOTE/g)).toHaveLength(1);
		expect(again.vault.files.get('Notes/N.md')).toBe(remote.toJSON());
	});
});

describe('engine with disk faults', () => {
	it('retries a failed rename of a remote move on rescan', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		const b = await device(hub);
		a.vault.write('Notes/N.md', 'text');
		await settle(a, b);
		b.vault.failNext('rename');
		a.vault.move('Notes/N.md', 'Notes/M.md');
		await settle(a, b);
		expect(b.problems).toEqual(['Sync step failed: disk write failed']);
		expect(b.state.known['N.md']).toBeDefined();
		b.engine.rescan();
		await settle(a, b);
		expect(sorted(b.vault)).toEqual([['Notes/M.md', 'text']]);
		expect(Object.keys(index(hub))).toEqual(['M.md']);
		expect(sorted(a.vault)).toEqual([['Notes/M.md', 'text']]);
	});

	it('writes a remote edit after a failed write, without undoing it', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		const b = await device(hub);
		a.vault.write('Notes/N.md', 'one');
		await settle(a, b);
		b.vault.failNext('process');
		a.vault.write('Notes/N.md', 'one two');
		await settle(a, b);
		expect(b.problems).toEqual(['Sync step failed: disk write failed']);
		expect(b.vault.files.get('Notes/N.md')).toBe('one');
		b.engine.rescan();
		await settle(a, b);
		expect(b.vault.files.get('Notes/N.md')).toBe('one two');
		expect(a.vault.files.get('Notes/N.md')).toBe('one two');
	});

	it('keeps the note listed when moving it to the trash fails, and finishes later', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		const b = await device(hub);
		a.vault.write('Notes/N.md', 'text');
		await settle(a, b);
		b.vault.failNext('trash');
		a.vault.remove('Notes/N.md');
		await settle(a, b);
		expect(b.problems).toEqual(['Sync step failed: disk write failed']);
		expect(b.vault.files.get('Notes/N.md')).toBe('text');
		b.engine.rescan();
		await settle(a, b);
		expect(b.vault.files.size).toBe(0);
		expect(a.vault.files.size).toBe(0);
		expect(index(hub)).toEqual({});
	});

	it('creates a remote note after a failed create, on the next start', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		a.vault.write('Notes/N.md', 'remote work');
		await settle(a);
		const vault = new FakeVault();
		vault.failNext('create');
		const disk = memoryDisk();
		const b = await device(hub, disk, emptyEngineState(), vault);
		await settle(a, b);
		cleanups.pop();
		await shutDown(b);
		const again = await device(hub, disk, b.state, vault);
		await settle(a, again);
		expect(vault.files.get('Notes/N.md')).toBe('remote work');
		expect(a.vault.files.get('Notes/N.md')).toBe('remote work');
	});

	it('syncs correctly with slow disk operations', async () => {
		const hub = new MemoryHub();
		const a = await device(hub);
		const slow = new FakeVault();
		slow.ioDelayMs = 5;
		const b = await device(hub, memoryDisk(), emptyEngineState(), slow);
		a.vault.write('Notes/N.md', 'one');
		a.vault.write('Notes/O.md', 'other');
		await settle(a, b);
		a.vault.write('Notes/N.md', 'one two');
		a.vault.move('Notes/O.md', 'Notes/P.md');
		await settle(a, b);
		await settle(a, b);
		expect(sorted(slow)).toEqual(sorted(a.vault));
		expect(sorted(slow)).toEqual([
			['Notes/N.md', 'one two'],
			['Notes/P.md', 'other'],
		]);
	});
});

class Socket extends WebSocket {
	constructor(url: string) {
		super(url);
		this.on('error', () => {});
	}
}

async function serverSource(options: Partial<HocuspocusOptions> = {}) {
	const server = new TestSyncServer();
	await server.start();
	cleanups.push(() => server.stop());
	let calls = 0;
	const source = new HocuspocusDocSource({
		url: server.url,
		access: () => {
			calls++;
			return Promise.resolve('good');
		},
		stores: memoryStores(memoryDisk()),
		primary: SPACE,
		socketImpl: Socket,
		minRetryMs: 10,
		maxRetryMs: 20,
		...options,
	});
	cleanups.push(() => source.destroy());
	return { source, server, calls: () => calls };
}

describe('server refusals and limits', () => {
	it('retries a refused note once with a fresh token, then reports it refused', async () => {
		const { source, server, calls } = await serverSource();
		server.forbidden.add(NOTE);
		source.start();
		await source.open(SPACE).whenSynced();
		const note = source.open(NOTE);
		note.doc.getText('content').insert(0, 'unsent work');
		await note.whenSynced();
		await delay(100);
		expect(note.refused).toBe(true);
		expect(note.synced).toBe(false);
		expect(server.refusals).toBe(2);
		expect(calls()).toBeGreaterThanOrEqual(2);
		expect(source.refused).toBe(1);
		const status = describeStatus({
			paired: true,
			configured: true,
			connection: source.state,
			pending: source.pending,
			refused: source.refused,
			ready: true,
		});
		expect(status).not.toBe('Stoasis: synced');
		expect(status).toContain('1 refused');
		expect(server.text(NOTE)).toBe('');
		// The space itself stays in sync.
		expect(source.open(SPACE).synced).toBe(true);
	});

	it('syncs a note the server refused once', async () => {
		const { source, server } = await serverSource();
		server.refuseOnce.add(NOTE);
		source.start();
		source.open(SPACE);
		const note = source.open(NOTE);
		note.doc.getText('content').insert(0, 'work');
		await eventually(() => expect(note.synced).toBe(true));
		await eventually(() => expect(server.text(NOTE)).toBe('work'));
		expect(note.refused).toBe(false);
		expect(source.refused).toBe(0);
		expect(server.refusals).toBe(1);
	});

	it('never creates an empty file for a note the server refused', async () => {
		const memory = memoryStores(memoryDisk());
		const { source, server } = await serverSource({
			stores: (name, doc) => {
				const store = memory(name, doc);
				return { ...store, loaded: name.startsWith('note:') ? delay(100) : store.loaded };
			},
		});
		server.forbidden.add(NOTE);
		const stored = new Y.Doc();
		stored.getMap('index').set('N.md', { id: NOTE.slice('note:'.length), kind: 'markdown' });
		server.stored.set(SPACE, Y.encodeStateAsUpdate(stored));
		stored.destroy();
		const vault = new FakeVault();
		const engine = new SyncEngine({
			deleteBatchMs: 1,
			vault,
			source,
			spaceId: SPACE_ID,
			mapping: { kind: 'folder', path: 'Notes' },
			state: emptyEngineState(),
			saveState: () => {},
		});
		cleanups.push(() => engine.stop());
		source.start();
		await engine.start();
		await eventually(() => expect(source.open(NOTE).refused).toBe(true));
		await engine.idle();
		expect(vault.files.has('Notes/N.md')).toBe(false);
	});

	it('publishes the index entry of a new note before the note authenticates', async () => {
		const { source, server } = await serverSource();
		server.requireListing = true;
		const vault = new FakeVault();
		const state = emptyEngineState();
		const engine = new SyncEngine({ deleteBatchMs: 1, vault, source, spaceId: SPACE_ID, mapping: { kind: 'folder', path: 'Notes' }, state, saveState: () => {} });
		vault.listener = engine;
		cleanups.push(async () => {
			vault.listener = null;
			await engine.stop();
		});
		source.start();
		await engine.start();
		vault.write('Notes/New.md', 'fresh');
		await eventually(() => expect(state.known['New.md']).toBeDefined());
		const name = noteDocName(state.known['New.md']!);
		await eventually(() => expect(server.text(name)).toBe('fresh'));
		expect(server.refusals).toBe(0);
		expect(source.refused).toBe(0);
	});

	it('never has more notes waiting for authentication than the server allows', async () => {
		// Authentication outlasts any batch timeout, as on a slow server; a
		// `batchTimeoutMs` option once let more notes in after it.
		const { source, server } = await serverSource({ batchTimeoutMs: 10 } as Partial<HocuspocusOptions>);
		source.start();
		await source.open(SPACE).whenSynced();
		server.authDelayMs = 250;
		const docs = Array.from({ length: 121 }, (_, n) =>
			source.open(noteDocName(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`)),
		);
		await delay(100);
		expect(server.maxPendingAuth).toBeGreaterThan(0);
		expect(server.maxPendingAuth).toBeLessThanOrEqual(50);
		await eventually(() => expect(docs.every((d) => d.synced)).toBe(true), 10_000);
		expect(server.maxPendingAuth).toBeLessThanOrEqual(50);
		expect(server.refusals).toBe(0);
	});

	it('asks again for a refused note when sync starts again', async () => {
		const disk = memoryDisk();
		const { source, server } = await serverSource({ stores: memoryStores(disk) });
		server.forbidden.add(NOTE);
		source.start();
		await source.open(SPACE).whenSynced();
		const note = source.open(NOTE);
		note.doc.getText('content').insert(0, 'kept on the device');
		await eventually(() => expect(note.refused).toBe(true));
		server.forbidden.delete(NOTE);
		// A new connection in the same session does not ask again.
		await server.drop();
		await server.start();
		await eventually(() => expect(source.open(SPACE).synced).toBe(true));
		await delay(50);
		expect(note.refused).toBe(true);
		expect(server.text(NOTE)).toBe('');
		await source.destroy();
		const again = new HocuspocusDocSource({
			url: server.url,
			access: () => Promise.resolve('good'),
			stores: memoryStores(disk),
			primary: SPACE,
			socketImpl: Socket,
		});
		cleanups.push(() => again.destroy());
		again.start();
		await again.open(SPACE).whenSynced();
		await again.open(NOTE).whenSynced();
		await eventually(() => expect(server.text(NOTE)).toBe('kept on the device'));
		expect(again.refused).toBe(0);
	});

	it('attaches notes that were waiting for authentication when the connection dropped', async () => {
		const { source, server } = await serverSource({ maxAuthenticating: 1 });
		source.start();
		await source.open(SPACE).whenSynced();
		server.authDelayMs = 150;
		const note = source.open(NOTE);
		note.doc.getText('content').insert(0, 'pending');
		await eventually(() => expect(server.pendingAuth).toBeGreaterThan(0));
		await server.drop();
		server.authDelayMs = 0;
		await server.start();
		await eventually(() => expect(source.open(SPACE).synced).toBe(true));
		await eventually(() => expect(note.synced).toBe(true));
		await eventually(() => expect(server.text(NOTE)).toBe('pending'));
		expect(source.pending).toBe(0);
	});
});

const SERVER = 'https://notes.example.test';

async function plugin(app = new App()) {
	const loaded = new StoasisPlugin(app as never, { id: 'stoasis', version: '0.1.0' } as never);
	await loaded.onload();
	cleanups.push(async () => {
		loaded.onunload();
		await delay(30);
	});
	return loaded;
}

async function finishes(work: Promise<unknown>, ms = 1000): Promise<boolean> {
	return Promise.race([work.then(() => true), delay(ms).then(() => false)]);
}

describe('plugin lifecycle', () => {
	let control: FakeControlPlane;
	beforeEach(() => {
		notices.length = 0;
		control = new FakeControlPlane(SERVER);
		setRequestHandler(control.handle);
	});

	async function pairedWithFolder() {
		const app = new App();
		app.vault.folders.add('Notes');
		app.vault.folders.add('Other');
		const p = await plugin(app);
		app.workspace.ready();
		await p.pair(control.server, 'ABCD2345', 'Review');
		await p.setFolder('Notes', false);
		return p;
	}

	it('disconnects while the server asks for a newer plugin on the first sync', async () => {
		const p = await pairedWithFolder();
		control.minPlugin = '0.2.0';
		await p.setSyncEnabled(true);
		await eventually(() => expect(p.status().connection).toBe('outdated'));
		expect(await finishes(p.unpair())).toBe(true);
		expect(control.revoked).toEqual(['key-1']);
		expect(p.settings.deviceKey).toBe('');
	});

	it('disconnects while the first sync cannot reach the sync server', async () => {
		const p = await pairedWithFolder();
		// The token works, but no sync server listens there.
		await p.setSyncEnabled(true);
		await eventually(() => expect(p.status().connection).not.toBeNull());
		expect(await finishes(p.unpair())).toBe(true);
		expect(control.revoked).toEqual(['key-1']);
	});

	it('turns sync off and changes folder while the first sync is waiting', async () => {
		const p = await pairedWithFolder();
		await p.setSyncEnabled(true);
		await eventually(() => expect(p.status().connection).not.toBeNull());
		expect(await finishes(p.setFolder('Other', false))).toBe(true);
		expect(p.settings.mapping).toEqual({ kind: 'folder', path: 'Other' });
		expect(await finishes(p.setSyncEnabled(false))).toBe(true);
		expect(p.status().connection).toBeNull();
	});

	it('says when the server could not revoke the key, and retries later', async () => {
		const p = await plugin();
		await p.pair(control.server, 'ABCD2345', 'Review');
		const key = p.settings.deviceKey;
		notices.length = 0;
		setRequestHandler(null);
		await p.unpair();
		expect(p.settings.deviceKey).toBe('');
		expect(control.keys.has(key)).toBe(true);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain('could not be reached to revoke');
		expect(p.settings.pendingRevocations).toEqual([{ serverUrl: SERVER, deviceKey: key, keyId: 'key-1' }]);
		// Still pending after a failed retry.
		expect(await p.retryRevocation()).toBe(false);
		expect(p.settings.pendingRevocations).toHaveLength(1);
		setRequestHandler(control.handle);
		expect(await p.retryRevocation()).toBe(true);
		expect(control.revoked).toEqual(['key-1']);
		expect(p.settings.pendingRevocations).toEqual([]);
	});

	it('keeps the pending revocation across a restart and a new pairing', async () => {
		const p = await plugin();
		await p.pair(control.server, 'ABCD2345', 'Review');
		setRequestHandler(null);
		await p.unpair();
		const stored = (p as unknown as { storedData: unknown }).storedData;
		control.codes.add('EFGH6789');
		setRequestHandler(control.handle);
		const app = new App();
		const again = new StoasisPlugin(app as never, { id: 'stoasis', version: '0.1.0' } as never);
		(again as unknown as { storedData: unknown }).storedData = stored;
		await again.onload();
		cleanups.push(async () => {
			again.onunload();
			await delay(30);
		});
		await again.pair(control.server, 'EFGH6789', 'Review again');
		expect(again.settings.pendingRevocations.map((k) => k.keyId)).toEqual(['key-1']);
		app.workspace.ready();
		await eventually(() => expect(again.settings.pendingRevocations).toEqual([]));
		expect(control.revoked).toEqual(['key-1']);
		expect(again.settings.keyId).toBe('key-2');
	});

	it('keeps every key left to revoke across repeated disconnects and a restart', async () => {
		const p = await plugin();
		await p.pair(control.server, 'ABCD2345', 'one');
		const key1 = p.settings.deviceKey;
		setRequestHandler(null);
		await p.unpair();
		control.codes.add('EFGH6789');
		setRequestHandler(control.handle);
		await p.pair(control.server, 'EFGH6789', 'two');
		const key2 = p.settings.deviceKey;
		setRequestHandler(null);
		await p.unpair();
		expect(p.settings.pendingRevocations.map((k) => k.keyId)).toEqual(['key-1', 'key-2']);
		expect(await p.retryRevocation()).toBe(false);
		// Restarted with both still pending.
		const stored = (p as unknown as { storedData: unknown }).storedData;
		const again = new StoasisPlugin(new App() as never, { id: 'stoasis', version: '0.1.0' } as never);
		(again as unknown as { storedData: unknown }).storedData = stored;
		await again.onload();
		cleanups.push(async () => {
			again.onunload();
			await delay(30);
		});
		expect(again.settings.pendingRevocations.map((k) => k.keyId)).toEqual(['key-1', 'key-2']);
		setRequestHandler(control.handle);
		// Retries running at once share one attempt.
		const results = await Promise.all([again.retryRevocation(), again.retryRevocation()]);
		expect(results).toEqual([true, true]);
		expect(control.keys.has(key1)).toBe(false);
		expect(control.keys.has(key2)).toBe(false);
		expect(control.revoked).toEqual(['key-1', 'key-2']);
		expect(again.settings.pendingRevocations).toEqual([]);
	});

	it('keeps a key whose revocation still fails while others are revoked', async () => {
		const p = await plugin();
		await p.pair(control.server, 'ABCD2345', 'one');
		setRequestHandler(null);
		await p.unpair();
		const other = { serverUrl: 'https://other.example.test', deviceKey: 'elsewhere', keyId: 'key-1' };
		p.settings.pendingRevocations.push(other);
		// Only the first server answers.
		setRequestHandler((request) => {
			if (!request.url.startsWith(SERVER)) {
				throw new Error('offline');
			}
			return control.handle(request);
		});
		expect(await p.retryRevocation()).toBe(false);
		expect(control.revoked).toEqual(['key-1']);
		expect(p.settings.pendingRevocations).toEqual([other]);
	});

	it('treats a key the server already removed as revoked', async () => {
		const p = await plugin();
		await p.pair(control.server, 'ABCD2345', 'Review');
		control.keys.clear();
		notices.length = 0;
		await p.unpair();
		expect(p.settings.pendingRevocations).toEqual([]);
		expect(notices).toEqual(['This device is no longer paired.']);
	});
});

describe('settings status', () => {
	it('follows connection changes while the settings are open', async () => {
		const p = await plugin();
		const internals = p as unknown as {
			settingTabs: StoasisSettingTab[];
			statusItems: ContainerEl[];
			updateStatus(): void;
		};
		const tab = internals.settingTabs[0]!;
		const statusRow = () => (tab.containerEl as unknown as ContainerEl).items[0] as RenderedItem;
		p.status = () => ({ paired: true, configured: true, ready: true, connection: 'online', pending: 0, refused: 0 });
		tab.display();
		expect(statusRow().desc).toBe('All changes are synced.');
		p.status = () => ({ paired: true, configured: true, ready: true, connection: 'offline', pending: 1, refused: 0 });
		internals.updateStatus();
		expect(internals.statusItems[0]?.text).toBe('Stoasis: offline, 1 waiting');
		expect(statusRow().desc).toBe(
			'The server cannot be reached. Changes are kept on this device and sent when it is back.',
		);
	});

	it('tells the user once when the server refuses a note', async () => {
		const p = await plugin();
		const internals = p as unknown as { updateStatus(): void };
		notices.length = 0;
		p.status = () => ({ paired: true, configured: true, ready: true, connection: 'online', pending: 0, refused: 1 });
		internals.updateStatus();
		internals.updateStatus();
		expect(notices).toHaveLength(1);
	});
});

describe('two devices through a sync server', () => {
	/** A device; with `slowLoadMs`, it takes that long to load what it stored of a note. */
	async function serverDevice(server: TestSyncServer, slowLoadMs = 0) {
		const memory = memoryStores(memoryDisk());
		const source = new HocuspocusDocSource({
			url: server.url,
			access: () => Promise.resolve('good'),
			stores: (name, doc) => {
				const store = memory(name, doc);
				return { ...store, loaded: slowLoadMs > 0 && name.startsWith('note:') ? delay(slowLoadMs) : store.loaded };
			},
			primary: SPACE,
			socketImpl: Socket,
			minRetryMs: 10,
			maxRetryMs: 20,
		});
		const vault = new FakeVault();
		const state = emptyEngineState();
		const engine = new SyncEngine({
			deleteBatchMs: 1,
			vault,
			source,
			spaceId: SPACE_ID,
			mapping: { kind: 'folder', path: 'Notes' },
			state,
			saveState: () => {},
			writeDelayMs: 1,
		});
		vault.listener = engine;
		cleanups.push(async () => {
			vault.listener = null;
			await engine.stop();
			await source.destroy();
		});
		source.start();
		await engine.start();
		return { source, engine, vault, state };
	}

	it('keeps edits another device makes to a new note while this device loads it', async () => {
		const server = new TestSyncServer();
		server.requireListing = true;
		await server.start();
		cleanups.push(() => server.stop());
		const a = await serverDevice(server, 400);
		const b = await serverDevice(server);
		a.vault.write('Notes/New.md', 'created here');
		// The other device edits the note as soon as it appears.
		await eventually(() => expect(b.vault.files.has('Notes/New.md')).toBe(true));
		const seen = b.vault.files.get('Notes/New.md');
		b.vault.write('Notes/New.md', 'created here, and peer work');
		const name = noteDocName(b.state.known['New.md']!);
		await eventually(() => expect(server.text(name)).toBe('created here, and peer work'));
		await delay(500);
		await a.engine.idle();
		await b.engine.idle();
		expect(server.text(name)).toBe('created here, and peer work');
		await eventually(() => expect(a.vault.files.get('Notes/New.md')).toBe('created here, and peer work'));
		expect(b.vault.files.get('Notes/New.md')).toBe('created here, and peer work');
		expect(seen).toBe('created here');
		expect(server.refusals).toBe(0);
	});

	it('merges edits both devices made while the server was down', async () => {
		const server = new TestSyncServer();
		server.requireListing = true;
		await server.start();
		cleanups.push(() => server.stop());
		const a = await serverDevice(server);
		const b = await serverDevice(server);
		a.vault.write('Notes/N.md', 'top\n\nbottom');
		await eventually(() => expect(b.vault.files.get('Notes/N.md')).toBe('top\n\nbottom'));
		await server.drop();
		await eventually(() => expect(a.source.state).toBe('offline'));
		a.vault.write('Notes/N.md', 'top, from a\n\nbottom');
		b.vault.write('Notes/N.md', 'top\n\nbottom, from b');
		b.vault.write('Notes/New.md', 'made offline on b');
		await delay(50);
		await server.start();
		const both = 'top, from a\n\nbottom, from b';
		await eventually(() => expect(a.vault.files.get('Notes/N.md')).toBe(both));
		await eventually(() => expect(b.vault.files.get('Notes/N.md')).toBe(both));
		await eventually(() => expect(a.vault.files.get('Notes/New.md')).toBe('made offline on b'));
		await eventually(() => expect(a.source.pending + b.source.pending).toBe(0));
		expect(a.source.refused + b.source.refused).toBe(0);
		expect(a.vault.trashed).toEqual([]);
		expect(b.vault.trashed).toEqual([]);
	});
});
