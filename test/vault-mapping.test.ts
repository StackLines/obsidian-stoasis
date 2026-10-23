import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { noteDocName, spaceDocName } from '../src/sync/docs';
import { markVaultRooted } from '../src/sync/root';
import { emptyEngineState, MASS_DELETE_MIN, parseEngineState, SyncEngine, type EngineState } from '../src/sync/engine';
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
	/** Counts of notes the engine held back from deleting, in order. */
	held: number[] = [];

	constructor(
		private readonly hub: MemoryHub,
		private readonly mapping: Mapping = WHOLE_VAULT,
		private readonly configDir: string = CONFIG,
	) {}

	async start(): Promise<void> {
		this.source = new MemoryDocSource(this.hub, memoryStores(this.disk), true);
		this.state = parseEngineState(JSON.parse(JSON.stringify(this.state)));
		this.engine = new SyncEngine({
			vault: this.vault,
			source: this.source,
			spaceId: SPACE_ID,
			mapping: this.mapping,
			configDir: this.configDir,
			state: this.state,
			saveState: () => undefined,
			writeDelayMs: 1,
			deleteBatchMs: 1,
			onProblem: (message) => this.problems.push(message),
			onMassDelete: (count) => this.held.push(count),
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

	describe('deleting many notes at once', () => {
		const MANY = MASS_DELETE_MIN + 5;

		async function vaultOf(extra = 0): Promise<[MemoryHub, Device, Device]> {
			const [hub, a, b] = await pair();
			for (let n = 0; n < MANY + extra; n++) {
				a.vault.write(`Big/${n}.md`, `note ${n}`);
			}
			await settle(a, b);
			expect(Object.keys(b.files())).toHaveLength(MANY + extra);
			return [hub, a, b];
		}

		it('holds a folder of notes that vanishes, and deletes nothing until asked', async () => {
			const [hub, a, b] = await vaultOf(5);
			for (let n = 0; n < MANY; n++) {
				a.vault.remove(`Big/${n}.md`);
			}
			await settle(a, b);
			expect(a.held).toEqual([MANY]);
			expect(Object.keys(indexOf(hub))).toHaveLength(MANY + 5);
			expect(Object.keys(b.files())).toHaveLength(MANY + 5);

			a.engine.releaseHeld();
			await settle(a, b);
			expect(Object.keys(indexOf(hub))).toHaveLength(5);
			expect(Object.keys(b.files())).toHaveLength(5);
		});

		it('holds notes missing at startup, as after a sync tool evicts them', async () => {
			const [hub, a, b] = await vaultOf();
			await a.stop();
			a.vault.files.clear();
			await a.start();
			await settle(a, b);
			expect(a.held).toEqual([MANY]);
			expect(Object.keys(indexOf(hub))).toHaveLength(MANY);
			expect(Object.keys(b.files())).toHaveLength(MANY);
		});

		it('holds an empty listing when notes are known, even when they are few', async () => {
			const [hub, a, b] = await pair();
			for (let n = 0; n < 6; n++) {
				a.vault.write(`Few/${n}.md`, `note ${n}`);
			}
			await settle(a, b);
			await a.stop();
			a.vault.files.clear();
			await a.start();
			await settle(a, b);
			expect(a.held).toEqual([6]);
			expect(Object.keys(indexOf(hub))).toHaveLength(6);
		});

		it('holds a small vault that disappears while running', async () => {
			const [hub, a, b] = await pair();
			for (let n = 0; n < 6; n++) {
				a.vault.write(`Few/${n}.md`, `note ${n}`);
			}
			await settle(a, b);
			for (let n = 0; n < 6; n++) {
				a.vault.remove(`Few/${n}.md`);
			}
			await settle(a, b);
			expect(a.held).toEqual([6]);
			expect(Object.keys(indexOf(hub))).toHaveLength(6);
		});

		it('moves a folder of notes into a hidden folder as a hold, not a delete', async () => {
			const [hub, a, b] = await vaultOf();
			for (let n = 0; n < MANY; n++) {
				a.vault.move(`Big/${n}.md`, `.Big/${n}.md`);
			}
			await settle(a, b);
			expect(a.held).toEqual([MANY]);
			expect(Object.keys(indexOf(hub))).toHaveLength(MANY);
		});

		it('holds notes deleted slowly, a few at a time', async () => {
			const [hub, a, b] = await vaultOf(70);
			for (let batch = 0; batch < 20; batch++) {
				for (let n = 0; n < 5; n++) {
					a.vault.remove(`Big/${batch * 5 + n}.md`);
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			await settle(a, b);
			expect(a.held.length).toBeGreaterThan(0);
			// 20 batches of 5: only those before the 25th deletion were applied.
			expect(Object.keys(indexOf(hub)).length).toBeGreaterThanOrEqual(MANY + 70 - MASS_DELETE_MIN);
		});

		it('deletes only the notes it asked about when the question was open for more', async () => {
			const [hub, a, b] = await vaultOf(10);
			for (let n = 0; n < MANY; n++) {
				a.vault.remove(`Big/${n}.md`);
			}
			await settle(a, b);
			expect(a.held).toEqual([MANY]);

			for (let n = MANY; n < MANY + 3; n++) {
				a.vault.remove(`Big/${n}.md`);
			}
			await settle(a, b);
			a.engine.releaseHeld();
			await settle(a, b);
			expect(Object.keys(indexOf(hub))).toHaveLength(10);
			expect(a.held).toEqual([MANY, 3]);

			a.engine.releaseHeld();
			await settle(a, b);
			expect(Object.keys(indexOf(hub))).toHaveLength(7);
		});

		it('does not ask again about notes put back while the question was open', async () => {
			const [, a, b] = await vaultOf(10);
			for (let n = 0; n < MANY; n++) {
				a.vault.remove(`Big/${n}.md`);
			}
			await settle(a, b);
			a.vault.remove(`Big/${MANY}.md`);
			await settle(a, b);
			a.vault.write(`Big/${MANY}.md`, `note ${MANY}`);
			await settle(a, b);
			a.engine.releaseHeld();
			await settle(a, b);
			expect(a.held).toEqual([MANY]);
		});

		it('deletes a few notes at once without asking', async () => {
			const [hub, a, b] = await vaultOf(40);
			for (let n = 0; n < 10; n++) {
				a.vault.remove(`Big/${n}.md`);
			}
			await settle(a, b);
			expect(a.held).toEqual([]);
			expect(Object.keys(indexOf(hub))).toHaveLength(MANY + 30);
		});

		it('holds a small share of a large vault too, and a folder mapping', async () => {
			const hub = new MemoryHub();
			const a = new Device(hub, folderMapping('Notes'));
			const b = new Device(hub, folderMapping('Notes'));
			await a.start();
			await b.start();
			for (let n = 0; n < MANY; n++) {
				a.vault.write(`Notes/${n}.md`, `note ${n}`);
			}
			await settle(a, b);
			for (let n = 0; n < MANY; n++) {
				a.vault.remove(`Notes/${n}.md`);
			}
			await settle(a, b);
			expect(a.held).toEqual([MANY]);
			expect(Object.keys(indexOf(hub))).toHaveLength(MANY);

			a.engine.releaseHeld();
			await settle(a, b);
			expect(Object.keys(indexOf(hub))).toHaveLength(0);
		});

		it('holds notes that are far below a quarter of the vault', async () => {
			const [hub, a, b] = await vaultOf(MANY * 6);
			for (let n = 0; n < MANY; n++) {
				a.vault.remove(`Big/${n}.md`);
			}
			await settle(a, b);
			expect(a.held).toEqual([MANY]);
			expect(Object.keys(indexOf(hub))).toHaveLength(MANY * 7);
		});
	});

	it('does not write a note from another device into a configuration folder without a dot', async () => {
		const hub = new MemoryHub();
		const a = new Device(hub, WHOLE_VAULT, 'plain');
		const b = new Device(hub, WHOLE_VAULT, 'other');
		await a.start();
		await b.start();
		// The other device has no folder named like a's configuration folder.
		b.vault.write('plain/x.md', 'from the other device');
		b.vault.write('Inbox.md', 'inbox');
		await settle(a, b);
		expect(a.files()).toEqual({ 'Inbox.md': 'inbox' });
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
			deleteBatchMs: 1,
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

describe('a folder device whose space starts at the vault root meanwhile', () => {
	const NOTES = folderMapping('Notes');
	const rooted = (hub: MemoryHub) => markVaultRooted(hub.doc(spaceDocName(SPACE_ID)), 'origin');

	async function folderDevice(files: Record<string, string> = {}): Promise<[MemoryHub, Device]> {
		const hub = new MemoryHub();
		const a = new Device(hub, NOTES);
		await a.start();
		for (const [path, text] of Object.entries(files)) {
			a.vault.write(path, text);
		}
		await settle(a);
		return [hub, a];
	}

	it('writes no new note to the index when the marker comes while a new file is read', async () => {
		const [hub, a] = await folderDevice({ 'Notes/Old.md': 'old' });
		const before = indexOf(hub);
		a.vault.ioDelayMs = 40;
		a.vault.write('Notes/New.md', 'new');
		await new Promise((resolve) => setTimeout(resolve, 10));
		rooted(hub);
		await settle(a);
		expect(indexOf(hub)).toEqual(before);
	});

	it('writes nothing while the first scan reads files', async () => {
		const [hub, a] = await folderDevice({ 'Notes/Old.md': 'old' });
		await a.stop();
		const before = indexOf(hub);
		a.vault.write('Notes/Late.md', 'late');
		a.vault.ioDelayMs = 40;
		const starting = a.start();
		await new Promise((resolve) => setTimeout(resolve, 10));
		rooted(hub);
		await starting;
		await settle(a);
		expect(indexOf(hub)).toEqual(before);
	});

	it('writes nothing for a rename made after the marker', async () => {
		const [hub, a] = await folderDevice({ 'Notes/Old.md': 'old' });
		rooted(hub);
		const before = indexOf(hub);
		a.vault.move('Notes/Old.md', 'Notes/Renamed.md');
		await settle(a);
		expect(indexOf(hub)).toEqual(before);
	});

	it('writes nothing for a deletion made after the marker', async () => {
		const [hub, a] = await folderDevice({ 'Notes/Old.md': 'old' });
		rooted(hub);
		const before = indexOf(hub);
		a.vault.remove('Notes/Old.md');
		await settle(a);
		expect(indexOf(hub)).toEqual(before);
	});
});
