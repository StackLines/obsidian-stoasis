import { describe, expect, it, vi } from 'vitest';
import { noteDocName, spaceDocName } from '../src/sync/docs';
import { emptyEngineState, parseEngineState, SyncEngine, type EngineState } from '../src/sync/engine';
import { FakeVault, MemoryDocSource, MemoryHub } from './helpers/memory-source';
import { memoryDisk, memoryStores } from './helpers/memory-store';

const SPACE_ID = '6f1c1d9e-8f0a-4a57-9a51-2f4f3e0f9a10';
const FOLDER = 'Synced';
const NOW = new Date('2026-10-15T12:00:00Z');

class Device {
	readonly vault = new FakeVault();
	readonly disk = memoryDisk();
	state: EngineState = emptyEngineState();
	source!: MemoryDocSource;
	engine!: SyncEngine;
	problems: string[] = [];
	private online: boolean;

	constructor(
		private readonly hub: MemoryHub,
		options: { online?: boolean } = {},
	) {
		this.online = options.online ?? true;
	}

	async start(): Promise<void> {
		this.source = new MemoryDocSource(this.hub, memoryStores(this.disk), this.online);
		this.state = parseEngineState(JSON.parse(JSON.stringify(this.state)));
		this.engine = new SyncEngine({
			vault: this.vault,
			source: this.source,
			spaceId: SPACE_ID,
			folder: FOLDER,
			state: this.state,
			saveState: () => undefined,
			writeDelayMs: 1,
			now: () => NOW,
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

	setOnline(online: boolean): void {
		this.online = online;
		this.source.setOnline(online);
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

describe('SyncEngine', () => {
	it('sends a new note to the other device', async () => {
		const [hub, a, b] = await pair();
		a.vault.write('Synced/Ideas.md', '# Ideas\n');
		await settle(a, b);
		expect(b.files()).toEqual({ 'Synced/Ideas.md': '# Ideas\n' });

		const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON();
		expect(Object.keys(index)).toEqual(['Ideas.md']);
		const entry = index['Ideas.md'] as { id: string; kind: string };
		expect(entry.kind).toBe('markdown');
		expect(hub.text(noteDocName(entry.id))).toBe('# Ideas\n');
	});

	it('ignores files outside the folder and files that are not notes', async () => {
		const [hub, a, b] = await pair();
		a.vault.write('Elsewhere/Private.md', 'not synced');
		a.vault.write('Synced/picture.png', 'binary');
		a.vault.write('Synced/.hidden/x.md', 'hidden');
		await settle(a, b);
		expect(b.files()).toEqual({});
		expect(hub.doc(spaceDocName(SPACE_ID)).getMap('index').size).toBe(0);
	});

	it('follows edits, renames, moves and deletes', async () => {
		const [, a, b] = await pair();
		a.vault.write('Synced/Ideas.md', 'one');
		await settle(a, b);

		a.vault.write('Synced/Ideas.md', 'one two');
		await settle(a, b);
		expect(b.files()).toEqual({ 'Synced/Ideas.md': 'one two' });

		a.vault.move('Synced/Ideas.md', 'Synced/Projects/Plans.md');
		await settle(a, b);
		expect(b.files()).toEqual({ 'Synced/Projects/Plans.md': 'one two' });

		b.vault.write('Synced/Projects/Plans.md', 'one two three');
		await settle(a, b);
		expect(a.files()).toEqual({ 'Synced/Projects/Plans.md': 'one two three' });

		b.vault.remove('Synced/Projects/Plans.md');
		await settle(a, b);
		expect(a.files()).toEqual({});
		expect(a.vault.trashed).toEqual(['Synced/Projects/Plans.md']);
	});

	it('treats moving a note out of the folder as a delete, and in as a create', async () => {
		const [, a, b] = await pair();
		a.vault.write('Synced/Ideas.md', 'idea');
		await settle(a, b);
		a.vault.move('Synced/Ideas.md', 'Archive/Ideas.md');
		await settle(a, b);
		expect(b.files()).toEqual({});

		a.vault.move('Archive/Ideas.md', 'Synced/Back.md');
		await settle(a, b);
		expect(b.files()).toEqual({ 'Synced/Back.md': 'idea' });
	});

	it('merges offline edits from both devices', async () => {
		const [, a, b] = await pair();
		a.vault.write('Synced/Day.md', 'Morning\n\nEvening\n');
		await settle(a, b);

		a.setOnline(false);
		a.vault.write('Synced/Day.md', 'Morning: coffee\n\nEvening\n');
		b.vault.write('Synced/Day.md', 'Morning\n\nEvening: reading\n');
		await settle(a, b);
		expect(a.files()['Synced/Day.md']).toBe('Morning: coffee\n\nEvening\n');

		a.setOnline(true);
		await settle(a, b);
		const merged = 'Morning: coffee\n\nEvening: reading\n';
		expect(a.files()).toEqual({ 'Synced/Day.md': merged });
		expect(b.files()).toEqual({ 'Synced/Day.md': merged });
	});

	it('merges an external edit without losing a remote edit that arrived meanwhile', async () => {
		const [, a, b] = await pair();
		a.vault.write('Synced/Doc.md', 'alpha\nbeta\ngamma\n');
		await settle(a, b);

		// A remote edit reaches A, but before A writes it to disk another tool
		// rewrites the file from the old text.
		b.vault.write('Synced/Doc.md', 'alpha\nbeta\ngamma\ndelta\n');
		await b.engine.idle();
		a.vault.files.set('Synced/Doc.md', 'ALPHA\nbeta\ngamma\n');
		a.engine.fileModified('Synced/Doc.md');
		await settle(a, b);

		const merged = 'ALPHA\nbeta\ngamma\ndelta\n';
		expect(a.files()).toEqual({ 'Synced/Doc.md': merged });
		expect(b.files()).toEqual({ 'Synced/Doc.md': merged });
	});

	it('keeps both notes when two devices create the same path offline', async () => {
		const [, a, b] = await pair();
		a.setOnline(false);
		b.setOnline(false);
		a.vault.write('Synced/Inbox.md', 'from A');
		b.vault.write('Synced/Inbox.md', 'from B');
		await settle(a, b);
		a.setOnline(true);
		b.setOnline(true);
		await settle(a, b);

		const files = a.files();
		expect(Object.keys(files)).toHaveLength(2);
		expect(Object.values(files).sort()).toEqual(['from A', 'from B']);
		expect(files['Synced/Inbox (conflict 2026-10-15).md']).toBeDefined();
		expect(b.files()).toEqual(files);
	});

	it('binds a new device to files it already has', async () => {
		const hub = new MemoryHub();
		const a = new Device(hub);
		await a.start();
		a.vault.write('Synced/Same.md', 'same');
		a.vault.write('Synced/Different.md', 'server copy');
		a.vault.write('Synced/OnlyServer.md', 'only on the server');
		await settle(a);

		const b = new Device(hub);
		b.vault.files.set('Synced/Same.md', 'same');
		b.vault.files.set('Synced/Different.md', 'local copy');
		b.vault.files.set('Synced/OnlyHere.md', 'only here');
		await b.start();
		await settle(a, b);

		expect(b.files()).toEqual({
			'Synced/Different (conflict 2026-10-15).md': 'local copy',
			'Synced/Different.md': 'server copy',
			'Synced/OnlyHere.md': 'only here',
			'Synced/OnlyServer.md': 'only on the server',
			'Synced/Same.md': 'same',
		});
		expect(a.files()).toEqual(b.files());
		expect(b.problems).toHaveLength(1);
	});

	it('catches up on changes made while the plugin was not running', async () => {
		const [, a, b] = await pair();
		a.vault.write('Synced/Edit.md', 'before');
		a.vault.write('Synced/Gone.md', 'bye');
		await settle(a, b);

		await a.stop();
		a.vault.files.set('Synced/Edit.md', 'after');
		a.vault.files.delete('Synced/Gone.md');
		a.vault.files.set('Synced/New.md', 'new');
		b.vault.write('Synced/FromB.md', 'from B');
		await settle(b);

		await a.start();
		await settle(a, b);
		const expected = {
			'Synced/Edit.md': 'after',
			'Synced/FromB.md': 'from B',
			'Synced/New.md': 'new',
		};
		expect(a.files()).toEqual(expected);
		expect(b.files()).toEqual(expected);
	});

	it('starts offline from what the device stored', async () => {
		const [, a, b] = await pair();
		a.vault.write('Synced/Note.md', 'v1');
		await settle(a, b);
		await a.stop();

		a.setOnline(false);
		await a.start();
		a.vault.write('Synced/Note.md', 'v1 offline');
		await settle(a);
		expect(b.files()).toEqual({ 'Synced/Note.md': 'v1' });

		a.setOnline(true);
		await settle(a, b);
		expect(b.files()).toEqual({ 'Synced/Note.md': 'v1 offline' });
	});

	it('leaves a note open in an editor to the editor', async () => {
		const [, a, b] = await pair();
		a.vault.write('Synced/Open.md', 'start');
		await settle(a, b);

		const link = await b.engine.link('Synced/Open.md');
		expect(link).not.toBeNull();
		expect(link?.text.toJSON()).toBe('start');

		a.vault.write('Synced/Open.md', 'start, edited on A');
		await settle(a, b);
		// The editor shows the change; the engine does not touch the file.
		expect(link?.text.toJSON()).toBe('start, edited on A');
		expect(b.files()['Synced/Open.md']).toBe('start');

		link?.release();
		await settle(a, b);
		expect(b.files()['Synced/Open.md']).toBe('start, edited on A');
	});

	it('does not link files it does not sync', async () => {
		const [, a] = await pair();
		a.vault.write('Elsewhere/Note.md', 'x');
		await settle(a);
		expect(await a.engine.link('Elsewhere/Note.md')).toBeNull();
		expect(a.engine.tracks('Elsewhere/Note.md')).toBe(false);
	});

	it('deletes nothing when the folder goes away while it starts', async () => {
		const [hub, a, b] = await pair();
		a.vault.write('Synced/One.md', 'one');
		await settle(a, b);
		await a.stop();

		a.vault.listMarkdown = () => {
			// The synced folder is deleted, and sync stopped, while the engine starts.
			a.vault.files.clear();
			void a.engine.stop();
			return [];
		};
		await a.start();
		await a.engine.idle();
		expect(Object.keys(hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON())).toEqual(['One.md']);
		await settle(b);
		expect(b.files()).toEqual({ 'Synced/One.md': 'one' });
	});

	it('waits for the server on first start before touching files', async () => {
		const hub = new MemoryHub();
		const a = new Device(hub);
		await a.start();
		a.vault.write('Synced/Existing.md', 'server');
		await settle(a);

		const b = new Device(hub, { online: false });
		b.vault.files.set('Synced/Existing.md', 'server');
		let started = false;
		const startB = b.start().then(() => {
			started = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(started).toBe(false);
		b.setOnline(true);
		await startB;
		await settle(a, b);
		expect(b.files()).toEqual({ 'Synced/Existing.md': 'server' });
		expect(b.problems).toEqual([]);
	});
});

describe('first start on a device new to the space', () => {
	const COUNT = 60;

	async function spaceWithNotes(): Promise<MemoryHub> {
		const hub = new MemoryHub();
		const a = new Device(hub);
		await a.start();
		for (let i = 0; i < COUNT; i++) {
			a.vault.write(`Synced/Note ${i}.md`, `text ${i}`);
		}
		await settle(a);
		await a.stop();
		return hub;
	}

	/** Index paths removed on the server while `run` runs. */
	async function indexDeletions(hub: MemoryHub, run: () => Promise<void>): Promise<string[]> {
		const deleted: string[] = [];
		const map = hub.doc(spaceDocName(SPACE_ID)).getMap('index');
		const observer = (event: { changes: { keys: Map<string, { action: string }> } }) => {
			for (const [key, change] of event.changes.keys) {
				if (change.action === 'delete') {
					deleted.push(key);
				}
			}
		};
		map.observe(observer);
		try {
			await run();
		} finally {
			map.unobserve(observer);
		}
		return deleted;
	}

	it('downloads every note to an empty folder and removes nothing from the space', async () => {
		const hub = await spaceWithNotes();
		const b = new Device(hub);
		const deleted = await indexDeletions(hub, async () => {
			await b.start();
			await settle(b);
		});
		expect(deleted).toEqual([]);
		expect(Object.keys(b.files())).toHaveLength(COUNT);
		expect(b.files()['Synced/Note 7.md']).toBe('text 7');
		expect(hub.doc(spaceDocName(SPACE_ID)).getMap('index').size).toBe(COUNT);
		expect(b.engine.progress()).toEqual({ listed: COUNT, present: COUNT });
		expect(b.problems).toEqual([]);
	});

	it('creates files before every note has been loaded', async () => {
		const hub = await spaceWithNotes();
		const b = new Device(hub);
		const open = vi.spyOn(MemoryDocSource.prototype, 'open');
		const opened = () => open.mock.calls.filter(([name]) => name.startsWith('note:')).length;
		let openedAtFirstFile: number | null = null;
		const create = b.vault.create.bind(b.vault);
		b.vault.create = (path, text) => {
			openedAtFirstFile ??= opened();
			return create(path, text);
		};
		let openedByStart = 0;
		try {
			await b.start();
			openedByStart = opened();
		} finally {
			open.mockRestore();
		}
		await settle(b);
		expect(openedByStart).toBe(COUNT);
		expect(openedAtFirstFile).not.toBeNull();
		expect(openedAtFirstFile).toBeLessThan(COUNT);
		expect(Object.keys(b.files())).toHaveLength(COUNT);
	});

	it('counts the notes on the device while they arrive', async () => {
		const hub = await spaceWithNotes();
		const b = new Device(hub);
		const seen: Array<{ listed: number; present: number }> = [];
		const create = b.vault.create.bind(b.vault);
		b.vault.create = (path, text) => {
			// Before this file exists: every earlier one is counted, this one not yet.
			seen.push(b.engine.progress());
			return create(path, text);
		};
		await b.start();
		await settle(b);
		expect(seen).toEqual(Array.from({ length: COUNT }, (_, present) => ({ listed: COUNT, present })));
		expect(b.engine.progress()).toEqual({ listed: COUNT, present: COUNT });
	});

	it('creates a file again in its full pass when an early pass could not', async () => {
		const hub = await spaceWithNotes();
		const b = new Device(hub);
		b.vault.failNext('create', 'Synced/Note 3.md');
		const deleted = await indexDeletions(hub, async () => {
			await b.start();
			await settle(b);
		});
		expect(deleted).toEqual([]);
		expect(b.files()['Synced/Note 3.md']).toBe('text 3');
		expect(Object.keys(b.files())).toHaveLength(COUNT);
		expect(b.problems).toEqual([]);
	});
});

describe('parseEngineState', () => {
	it('keeps only valid entries', () => {
		expect(
			parseEngineState({
				known: {
					'Good.md': '00000000-0000-4000-8000-000000000001',
					'../Bad.md': '00000000-0000-4000-8000-000000000002',
					'NoId.md': 'nope',
				},
				seeded: true,
			}),
		).toEqual({ known: { 'Good.md': '00000000-0000-4000-8000-000000000001' }, seeded: true });
		expect(parseEngineState(null)).toEqual(emptyEngineState());
	});
});
