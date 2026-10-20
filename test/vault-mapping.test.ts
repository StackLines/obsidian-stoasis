import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { noteDocName, spaceDocName } from '../src/sync/docs';
import { emptyEngineState, parseEngineState, SyncEngine, type EngineState } from '../src/sync/engine';
import { HocuspocusDocSource } from '../src/sync/hocuspocus';
import {
	folderMapping,
	isSyncablePath,
	sameMapping,
	toRelative,
	toVaultPath,
	WHOLE_VAULT,
	type Mapping,
} from '../src/sync/paths';
import { parseSettings } from '../src/settings';
import { FakeVault, MemoryDocSource, MemoryHub } from './helpers/memory-source';
import { memoryDisk, memoryStores } from './helpers/memory-store';
import { eventually, TestSyncServer } from './helpers/sync-server';

// Mapping a space to the whole vault: paths, the engine, and a large first sync.

const SPACE_ID = '6f1c1d9e-8f0a-4a57-9a51-2f4f3e0f9a10';
const CONFIG = '.obsidian';

describe('mapping paths', () => {
	it('takes a note at the vault root as its own relative path', () => {
		expect(toRelative(WHOLE_VAULT, 'Inbox.md', CONFIG)).toBe('Inbox.md');
		expect(toRelative(WHOLE_VAULT, 'Work/Plans/Q4.md', CONFIG)).toBe('Work/Plans/Q4.md');
		expect(toVaultPath(WHOLE_VAULT, 'Work/Q4.md')).toBe('Work/Q4.md');
	});

	it('never syncs the configuration folder, hidden folders or other files from the root', () => {
		for (const path of [
			'.obsidian/plugins/stoasis/data.md',
			'.obsidian/x.md',
			'.trash/x.md',
			'Work/.hidden/x.md',
			'.hidden.md',
			'pic.png',
			'Work/data.json',
		]) {
			expect(toRelative(WHOLE_VAULT, path, CONFIG), path).toBeNull();
		}
	});

	it('leaves out a configuration folder that does not start with a dot', () => {
		expect(toRelative(WHOLE_VAULT, 'config/x.md', 'config')).toBeNull();
		expect(toRelative(WHOLE_VAULT, 'config/sub/x.md', 'config')).toBeNull();
		expect(toRelative(WHOLE_VAULT, 'configuration/x.md', 'config')).toBe('configuration/x.md');
		expect(toRelative(WHOLE_VAULT, 'config.md', 'config')).toBe('config.md');
	});

	it('keeps mapping a folder as it was', () => {
		const notes = folderMapping('Notes');
		expect(toRelative(notes, 'Notes/A/b.md', CONFIG)).toBe('A/b.md');
		expect(toRelative(notes, 'Inbox.md', CONFIG)).toBeNull();
		expect(toRelative(notes, 'NotesOther/b.md', CONFIG)).toBeNull();
		expect(toVaultPath(notes, 'A/b.md')).toBe('Notes/A/b.md');
		expect(isSyncablePath('.trash/x.md')).toBe(false);
	});

	it('tells mappings apart', () => {
		expect(sameMapping(WHOLE_VAULT, { kind: 'vault' })).toBe(true);
		expect(sameMapping(folderMapping('A'), folderMapping('A'))).toBe(true);
		expect(sameMapping(folderMapping('A'), folderMapping('B'))).toBe(false);
		expect(sameMapping(folderMapping('A'), WHOLE_VAULT)).toBe(false);
		expect(sameMapping(null, null)).toBe(true);
		expect(sameMapping(null, WHOLE_VAULT)).toBe(false);
	});
});

describe('stored mapping', () => {
	it('turns a folder stored by 0.2 into a folder mapping', () => {
		expect(parseSettings({ folder: 'Notes' }).mapping).toEqual({ kind: 'folder', path: 'Notes' });
	});

	it('keeps an empty folder as not mapped', () => {
		expect(parseSettings({ folder: '' }).mapping).toBeNull();
		expect(parseSettings({}).mapping).toBeNull();
	});

	it('reads the whole vault, and prefers a stored mapping to an old folder', () => {
		expect(parseSettings({ mapping: { kind: 'vault' } }).mapping).toEqual(WHOLE_VAULT);
		expect(parseSettings({ mapping: { kind: 'vault' }, folder: 'Notes' }).mapping).toEqual(WHOLE_VAULT);
		expect(parseSettings({ mapping: { kind: 'folder', path: 'A' }, folder: 'B' }).mapping).toEqual(
			folderMapping('A'),
		);
	});

	it('maps nothing for an unusable mapping object, and never a folder with an empty path', () => {
		for (const mapping of [{ kind: 'folder', path: '' }, { kind: 'folder' }, { kind: 'other' }, {}, []]) {
			expect(parseSettings({ mapping, folder: 'Notes' }).mapping, JSON.stringify(mapping)).toBeNull();
		}
	});
});

describe('stored mapping values that are no objects', () => {
	it('fall back to the folder stored by 0.2, if any', () => {
		expect(parseSettings({ mapping: 'vault' }).mapping).toBeNull();
		expect(parseSettings({ mapping: 'vault', folder: 'Notes' }).mapping).toEqual(folderMapping('Notes'));
	});
});

class Device {
	readonly vault = new FakeVault();
	readonly disk = memoryDisk();
	state: EngineState = emptyEngineState();
	source!: MemoryDocSource;
	engine!: SyncEngine;
	problems: string[] = [];

	constructor(
		private readonly hub: MemoryHub,
		private readonly mapping: Mapping = WHOLE_VAULT,
	) {}

	async start(): Promise<void> {
		this.source = new MemoryDocSource(this.hub, memoryStores(this.disk), true);
		this.state = parseEngineState(JSON.parse(JSON.stringify(this.state)));
		this.engine = new SyncEngine({
			vault: this.vault,
			source: this.source,
			spaceId: SPACE_ID,
			mapping: this.mapping,
			configDir: CONFIG,
			state: this.state,
			saveState: () => undefined,
			writeDelayMs: 1,
			onProblem: (message) => this.problems.push(message),
		});
		this.vault.listener = this.engine;
		await this.engine.start();
	}

	async stop(): Promise<void> {
		this.vault.listener = null;
		await this.engine.stop();
		await this.source.destroy();
	}

	files(): Record<string, string> {
		return Object.fromEntries([...this.vault.files.entries()].sort(([a], [b]) => a.localeCompare(b)));
	}
}

async function settle(...devices: Device[]): Promise<void> {
	for (let round = 0; round < 20; round++) {
		await new Promise((resolve) => setTimeout(resolve, 3));
		for (const device of devices) {
			await device.engine.idle();
		}
	}
}

async function pair(): Promise<[MemoryHub, Device, Device]> {
	const hub = new MemoryHub();
	const a = new Device(hub);
	const b = new Device(hub);
	await a.start();
	await b.start();
	return [hub, a, b];
}

const indexOf = (hub: MemoryHub) => hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON();

describe('SyncEngine mapped to the whole vault', () => {
	it('round-trips a note at the vault root: create, rename, move into a folder, delete', async () => {
		const [hub, a, b] = await pair();
		a.vault.write('Inbox.md', '# Inbox\n');
		await settle(a, b);
		expect(b.files()).toEqual({ 'Inbox.md': '# Inbox\n' });
		expect(Object.keys(indexOf(hub))).toEqual(['Inbox.md']);

		b.vault.move('Inbox.md', 'Todo.md');
		await settle(a, b);
		expect(a.files()).toEqual({ 'Todo.md': '# Inbox\n' });
		expect(Object.keys(indexOf(hub))).toEqual(['Todo.md']);

		a.vault.move('Todo.md', 'Work/Todo.md');
		await settle(a, b);
		expect(b.files()).toEqual({ 'Work/Todo.md': '# Inbox\n' });
		expect(Object.keys(indexOf(hub))).toEqual(['Work/Todo.md']);

		b.vault.move('Work/Todo.md', 'Todo.md');
		await settle(a, b);
		expect(a.files()).toEqual({ 'Todo.md': '# Inbox\n' });

		a.vault.write('Todo.md', '# Inbox\nmore');
		await settle(a, b);
		expect(b.files()).toEqual({ 'Todo.md': '# Inbox\nmore' });

		b.vault.remove('Todo.md');
		await settle(a, b);
		expect(a.files()).toEqual({});
		expect(a.vault.trashed).toEqual(['Todo.md']);
		expect(indexOf(hub)).toEqual({});
	});

	it('never lets the configuration folder, hidden folders or other files into the index', async () => {
		const [hub, a, b] = await pair();
		a.vault.write('.obsidian/plugins/stoasis/x.md', 'key');
		a.vault.write('.obsidian/notes.md', 'config');
		a.vault.write('.trash/x.md', 'trashed');
		a.vault.write('Work/.hidden/x.md', 'hidden');
		a.vault.write('pic.png', 'binary');
		a.vault.write('Work/Plan.md', 'plan');
		await settle(a, b);
		expect(Object.keys(indexOf(hub))).toEqual(['Work/Plan.md']);
		expect(b.files()).toEqual({ 'Work/Plan.md': 'plan' });
	});

	it('keeps them out when it finds files at startup too', async () => {
		const hub = new MemoryHub();
		const a = new Device(hub);
		a.vault.files.set('.obsidian/plugins/stoasis/x.md', 'key');
		a.vault.files.set('.trash/x.md', 'trashed');
		a.vault.files.set('Inbox.md', 'one');
		a.vault.files.set('Work/Plan.md', 'two');
		await a.start();
		await settle(a);
		expect(Object.keys(indexOf(hub)).sort()).toEqual(['Inbox.md', 'Work/Plan.md']);
		expect(a.state.known['.trash/x.md']).toBeUndefined();
		expect(Object.keys(a.state.known).sort()).toEqual(['Inbox.md', 'Work/Plan.md']);
	});

	it('treats deleting a folder of notes as deleting each note, and keeps the others', async () => {
		const [hub, a, b] = await pair();
		for (let n = 0; n < 12; n++) {
			a.vault.write(`Archive/Old/${n}.md`, `old ${n}`);
		}
		a.vault.write('Keep.md', 'keep');
		await settle(a, b);
		expect(Object.keys(b.files())).toHaveLength(13);

		for (let n = 0; n < 12; n++) {
			b.vault.remove(`Archive/Old/${n}.md`);
		}
		await settle(a, b);
		expect(a.files()).toEqual({ 'Keep.md': 'keep' });
		expect(Object.keys(indexOf(hub))).toEqual(['Keep.md']);
	});

	it('does not delete notes when it starts and the vault lists the same notes again', async () => {
		const hub = new MemoryHub();
		const a = new Device(hub);
		a.vault.files.set('Inbox.md', 'one');
		await a.start();
		await settle(a);
		await a.stop();
		await a.start();
		await settle(a);
		expect(a.files()).toEqual({ 'Inbox.md': 'one' });
		expect(Object.keys(indexOf(hub))).toEqual(['Inbox.md']);
	});

	it('brings the notes of a space to a vault, subfolders included', async () => {
		const hub = new MemoryHub();
		const a = new Device(hub);
		a.vault.files.set('Inbox.md', 'one');
		a.vault.files.set('Work/Plan.md', 'two');
		await a.start();
		await settle(a);
		const b = new Device(hub);
		await b.start();
		await settle(a, b);
		expect(b.files()).toEqual({ 'Inbox.md': 'one', 'Work/Plan.md': 'two' });
		expect(hub.docs.has(noteDocName(a.state.known['Inbox.md'] ?? ''))).toBe(true);
	});

	it('follows a folder rename the same way a folder mapping does: each note moves', async () => {
		const [hub, a, b] = await pair();
		a.vault.write('Work/Plan.md', 'plan');
		a.vault.write('Work/Deep/Notes.md', 'deep');
		await settle(a, b);
		a.vault.move('Work/Plan.md', 'Projects/Plan.md');
		a.vault.move('Work/Deep/Notes.md', 'Projects/Deep/Notes.md');
		await settle(a, b);
		expect(b.files()).toEqual({ 'Projects/Deep/Notes.md': 'deep', 'Projects/Plan.md': 'plan' });
		expect(Object.keys(indexOf(hub)).sort()).toEqual(['Projects/Deep/Notes.md', 'Projects/Plan.md']);
	});
});

// A few thousand notes through a real socket and the server's limits.

const cleanups: Array<() => Promise<void> | void> = [];

class TestSocket extends WebSocket {
	constructor(address: string) {
		super(address);
		this.on('error', () => undefined);
	}
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

describe('first sync of a large vault', () => {
	it('uploads thousands of notes without more than 50 waiting for authentication', async () => {
		const server = new TestSyncServer();
		server.requireListing = true;
		server.authDelayMs = 1;
		await server.start();
		cleanups.push(() => server.stop());
		const source = new HocuspocusDocSource({
			url: server.url,
			access: () => Promise.resolve('good'),
			stores: memoryStores(memoryDisk()),
			primary: spaceDocName(SPACE_ID),
			socketImpl: TestSocket,
			minRetryMs: 10,
			maxRetryMs: 20,
		});
		cleanups.push(() => source.destroy());

		const total = 2500;
		const vault = new FakeVault();
		for (let n = 0; n < total; n++) {
			vault.files.set(`Folder ${n % 25}/Note ${n}.md`, `note ${n}`);
		}
		vault.files.set('.obsidian/plugins/stoasis/data.md', 'key');
		vault.files.set('.trash/Old.md', 'trashed');
		vault.files.set('Inbox.md', 'root');
		const state = emptyEngineState();
		const engine = new SyncEngine({
			vault,
			source,
			spaceId: SPACE_ID,
			mapping: WHOLE_VAULT,
			configDir: CONFIG,
			state,
			saveState: () => undefined,
		});
		cleanups.push(() => engine.stop());
		source.start();
		await engine.start();

		expect(Object.keys(state.known)).toHaveLength(total + 1);
		await eventually(() => expect(source.pending).toBe(0), 120_000);
		expect(server.maxPendingAuth).toBeGreaterThan(0);
		expect(server.maxPendingAuth).toBeLessThanOrEqual(50);
		expect(server.refusals).toBe(0);
		const stored = new Y.Doc();
		Y.applyUpdate(stored, server.stored.get(spaceDocName(SPACE_ID)) ?? new Uint8Array());
		expect(stored.getMap('index').size).toBe(total + 1);
		expect(server.text(noteDocName(state.known['Inbox.md'] ?? ''))).toBe('root');
	}, 150_000);
});
