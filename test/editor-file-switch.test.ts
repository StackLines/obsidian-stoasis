// Switching the file shown in one editor must never copy one note into
// another. The app reuses an editor when it opens another file: it points the
// view at the new file first, without a transaction, then replaces the text
// once it has read the file. Any update in between sees the new file with the
// old file's text.
import 'fake-indexeddb/auto';
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncedEditor, isLoad, type EditorViewLike, type ShownFile } from '../src/editor';
import { EditorSync } from '../src/sync/binding';
import { noteDocName, spaceDocName } from '../src/sync/docs';
import { SyncEngine, emptyEngineState, type EngineState } from '../src/sync/engine';
import { replacesMost, setText } from '../src/sync/text';
import { readPatch } from '../src/frontmatter-patch';
import { applyToFrontmatter, reviewedFrontmatter, stillReviewed } from '../src/tagging';
import { splitFrontmatter } from './stubs/obsidian';
import { keepSyncedNote, useConflictCopy, type Compared, type ConflictFiles } from '../src/conflict';
import * as Y from 'yjs';
import { FakeVault, MemoryDocSource, MemoryHub } from './helpers/memory-source';
import { memoryDisk, memoryStores } from './helpers/memory-store';
import { SPACE_ID } from './helpers/control-plane';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

interface Device {
	engine: SyncEngine;
	source: MemoryDocSource;
	vault: FakeVault;
	state: EngineState;
	editors: EditorSync;
	problems: string[];
}

async function device(hub: MemoryHub): Promise<Device> {
	const source = new MemoryDocSource(hub, memoryStores(memoryDisk()), true);
	const vault = new FakeVault();
	const state = emptyEngineState();
	const editors = new EditorSync();
	const problems: string[] = [];
	const engine = new SyncEngine({
		vault,
		source,
		spaceId: SPACE_ID,
		folder: 'Notes',
		state,
		saveState: () => {},
		writeDelayMs: 1,
		onProblem: (problem) => problems.push(problem),
		onTracked: () => editors.refresh(),
		onRelink: (path) => editors.relink(path),
	});
	vault.listener = engine;
	await engine.start();
	editors.setLinker(engine);
	cleanups.push(async () => {
		editors.setLinker(null);
		vault.listener = null;
		await engine.stop();
		await source.destroy();
	});
	return { engine, source, vault, state, editors, problems };
}

async function settle(...devices: Device[]): Promise<void> {
	for (let round = 0; round < 20; round++) {
		await delay(3);
		for (const d of devices) {
			await d.engine.idle();
		}
	}
}

/** The app's file objects: one per file, whose path changes when the file is renamed. */
const fileObjects = new WeakMap<FakeVault, Map<string, ShownFile>>();

function fileObject(vault: FakeVault, path: string | null): ShownFile | null {
	if (path === null) {
		return null;
	}
	let objects = fileObjects.get(vault);
	if (objects === undefined) {
		objects = new Map();
		fileObjects.set(vault, objects);
	}
	let object = objects.get(path);
	if (object === undefined) {
		object = { path };
		objects.set(path, object);
	}
	return object;
}

/** The app renames a file: its object, which open views hold, gets the new path. */
function renameFileObject(vault: FakeVault, from: string, to: string): void {
	const object = fileObject(vault, from) as { path: string };
	fileObjects.get(vault)?.delete(from);
	object.path = to;
	fileObjects.get(vault)?.set(to, object);
}

/**
 * One editor pane as the app drives it: a CodeMirror state, the file the
 * pane shows (changed without a transaction, like the app's view), and saves
 * that write the editor's text to that file.
 */
class Pane implements EditorViewLike {
	state: EditorState;
	private shown: ShownFile | null;
	/** What the app last loaded or saved; it saves only when the text differs. */
	private data: string;
	private editor: SyncedEditor;

	constructor(
		private readonly sync: EditorSync,
		private readonly vault: FakeVault,
		file: string | null,
	) {
		this.shown = fileObject(vault, file);
		this.data = file === null ? '' : (vault.files.get(file) ?? '');
		this.state = EditorState.create({ doc: this.data });
		this.editor = new SyncedEditor(sync, this, () => this.shown);
	}

	/** The path of the file the pane shows. */
	get file(): string | null {
		return this.shown?.path ?? null;
	}

	text(): string {
		return this.state.doc.toString();
	}

	dispatch(spec: TransactionSpec): void {
		this.deliver([spec]);
	}

	/** Applies transactions as one view update, after `before` ran. */
	deliver(specs: TransactionSpec[], before: () => void = () => {}): void {
		const transactions: Transaction[] = [];
		for (const spec of specs) {
			const tr = this.state.update(spec);
			this.state = tr.state;
			transactions.push(tr);
		}
		before();
		this.editor.update(transactions);
	}

	/** The app points the pane at another file; nothing is dispatched. */
	point(file: string | null): void {
		this.shown = fileObject(this.vault, file);
	}

	/** Any update without a text change: a selection, focus or layout change. */
	nudge(): void {
		this.dispatch({ selection: { anchor: 0 } });
	}

	/** The app's load of a file's text: the whole document replaced. */
	loadSpec(text: string): TransactionSpec {
		return { changes: { from: 0, to: this.state.doc.length, insert: text } };
	}

	load(text: string): void {
		this.data = text;
		this.dispatch(this.loadSpec(text));
	}

	/** Loads `text` and points the pane at `file` before the update reaches the editor. */
	loadThenPoint(file: string, text: string): void {
		this.data = text;
		this.deliver([this.loadSpec(text)], () => this.point(file));
	}

	/** The app replaces the editor's state, which recreates the view plugins. */
	replaceState(file: string | null, text: string): void {
		this.editor.destroy();
		this.shown = fileObject(this.vault, file);
		this.data = text;
		this.state = EditorState.create({ doc: text });
		this.editor = new SyncedEditor(this.sync, this, () => this.shown);
	}

	type(pos: number, insert: string): void {
		this.dispatch({ changes: { from: pos, insert }, userEvent: 'input.type' });
	}

	/** Puts the cursor at `pos`, as a click does. */
	select(pos: number): void {
		this.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' });
	}

	get cursor(): number {
		return this.state.selection.main.head;
	}

	/** Typing at the cursor, which moves on past what was typed. */
	typeHere(insert: string): void {
		const at = this.cursor;
		this.dispatch({
			changes: { from: at, insert },
			selection: { anchor: at + insert.length },
			userEvent: 'input.type',
		});
	}

	/** The app's save: the editor's text goes to the file the pane shows. */
	save(): void {
		const file = this.file;
		const text = this.text();
		if (file !== null && text !== this.data) {
			this.data = text;
			this.vault.write(file, text);
		}
	}

	close(): void {
		this.editor.destroy();
	}
}

/** Daily notes from one template: most of their text is the same. */
const day = (n: number, tasks: string, notes: string) =>
	`# Day ${n}\n\n## Tasks\n\n- [ ] Review the inbox\n- [ ] ${tasks}\n\n## Notes\n\n${notes}\n\n## Links\n\n- Previous day\n- Next day\n`;

const ORIGINAL: Record<string, string> = {
	'Notes/A.md': day(1, 'Write the summary', 'A quiet day.'),
	'Notes/B.md': day(2, 'Call the supplier', 'The meeting moved to the afternoon.'),
	'Notes/C.md': day(3, 'Plan the week', 'Nothing else happened.'),
};
const OUTSIDE = 'Elsewhere/Other.md';
const OUTSIDE_TEXT = 'A file that is not synced, with text of its own.\n';

async function pair(): Promise<{ hub: MemoryHub; a: Device; b: Device }> {
	const hub = new MemoryHub();
	const a = await device(hub);
	const b = await device(hub);
	for (const [path, text] of Object.entries(ORIGINAL)) {
		a.vault.write(path, text);
	}
	a.vault.write(OUTSIDE, OUTSIDE_TEXT);
	await settle(a, b);
	for (const path of Object.keys(ORIGINAL)) {
		expect(b.vault.files.get(path)).toBe(ORIGINAL[path]);
	}
	return { hub, a, b };
}

/** Every note keeps its own text: in the shared text and on both devices' disks. */
function expectIntact(hub: MemoryHub, ...devices: Device[]): void {
	const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
	for (const [path, text] of Object.entries(ORIGINAL)) {
		const rel = path.slice('Notes/'.length);
		const id = index[rel]?.id;
		expect(id, rel).toBeDefined();
		expect(hub.text(noteDocName(id as string)), `shared text of ${rel}`).toBe(text);
		devices.forEach((d, i) => {
			expect(d.vault.files.get(path), `${rel} on device ${i}`).toBe(text);
		});
	}
	expect(devices[0]?.vault.files.get(OUTSIDE)).toBe(OUTSIDE_TEXT);
	expect(Object.keys(index).sort()).toEqual(['A.md', 'B.md', 'C.md']);
}

/**
 * Opens `file` in the pane. `meanwhile` lets sync run, the app save, and
 * checks that no note changed: it stands for the time the app takes to read
 * the new file.
 */
type Switch = (pane: Pane, file: string, text: string, meanwhile: () => Promise<void>) => Promise<void>;

/** The ways the app can deliver the new file and its text to the editor. */
const ORDERINGS: Array<[string, Switch]> = [
	[
		'the file first, an unrelated update, then the text',
		async (pane, file, text, meanwhile) => {
			pane.point(file);
			pane.nudge();
			await meanwhile();
			pane.load(text);
		},
	],
	[
		'the file first, then the text in a later update',
		async (pane, file, text, meanwhile) => {
			pane.point(file);
			await meanwhile();
			pane.load(text);
		},
	],
	[
		'the file and the text in one update',
		async (pane, file, text) => {
			pane.point(file);
			pane.load(text);
		},
	],
	[
		'the text first, then the file in a later update',
		async (pane, file, text, meanwhile) => {
			pane.load(text);
			await meanwhile();
			pane.point(file);
			pane.nudge();
		},
	],
	[
		'the text first, then the file, before the update arrives',
		async (pane, file, text) => {
			pane.loadThenPoint(file, text);
		},
	],
	[
		'the file first, an unrelated update, then a new editor state with the text',
		async (pane, file, text, meanwhile) => {
			pane.point(file);
			pane.nudge();
			await meanwhile();
			pane.replaceState(file, text);
		},
	],
];

async function open(pane: Pane, file: string, hub: MemoryHub, how: Switch, a: Device, b: Device): Promise<void> {
	const text = a.vault.files.get(file);
	expect(text, file).toBeDefined();
	await how(pane, file, text as string, async () => {
		await settle(a, b);
		pane.save();
		await settle(a, b);
		expectIntact(hub, a, b);
	});
	await settle(a, b);
	pane.save();
	await settle(a, b);
	expect(pane.text()).toBe(a.vault.files.get(file));
}

describe('switching files in one editor', () => {
	for (const [name, how] of ORDERINGS) {
		it(`keeps every note's own text: ${name}`, async () => {
			const { hub, a, b } = await pair();
			const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
			await settle(a, b);
			for (const file of ['Notes/B.md', 'Notes/C.md', OUTSIDE, 'Notes/A.md', 'Notes/C.md']) {
				await open(pane, file, hub, how, a, b);
				expectIntact(hub, a, b);
			}
			pane.close();
			await settle(a, b);
			expectIntact(hub, a, b);
			expect(a.problems).toEqual([]);
		});
	}

	it('keeps typing after a switch on the new note only, on both devices', async () => {
		const { hub, a, b } = await pair();
		const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
		await settle(a, b);
		const [, how] = ORDERINGS[0] as [string, Switch];
		await open(pane, 'Notes/B.md', hub, how, a, b);
		pane.type(0, 'typed in B. ');
		await settle(a, b);
		pane.save();
		await settle(a, b);
		const typed = `typed in B. ${ORIGINAL['Notes/B.md']}`;
		expect(b.vault.files.get('Notes/B.md')).toBe(typed);
		expect(b.vault.files.get('Notes/A.md')).toBe(ORIGINAL['Notes/A.md']);
		const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
		expect(hub.text(noteDocName(index['A.md']!.id))).toBe(ORIGINAL['Notes/A.md']);
		expect(hub.text(noteDocName(index['B.md']!.id))).toBe(typed);
		pane.close();
	});

	it('shows edits another device made to a note while it was closed here', async () => {
		const { a, b } = await pair();
		const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
		await settle(a, b);
		const edited = `${ORIGINAL['Notes/B.md']}Added on the other device.\n`;
		b.vault.write('Notes/B.md', edited);
		await settle(a, b);
		expect(a.vault.files.get('Notes/B.md')).toBe(edited);
		pane.point('Notes/B.md');
		pane.nudge();
		await settle(a, b);
		pane.load(edited);
		await settle(a, b);
		pane.save();
		await settle(a, b);
		expect(pane.text()).toBe(edited);
		expect(a.vault.files.get('Notes/B.md')).toBe(edited);
		expect(b.vault.files.get('Notes/A.md')).toBe(ORIGINAL['Notes/A.md']);
		pane.close();
	});

	it('does not take a quick switch away and back for a rename, while the other file is still being read', async () => {
		const { hub, a, b } = await pair();
		const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
		await settle(a, b);
		const read = a.vault.read.bind(a.vault);
		let releaseB!: () => void;
		const pendingB = new Promise<void>((resolve) => {
			releaseB = resolve;
		});
		a.vault.read = async (path) => {
			if (path === 'Notes/B.md') {
				await pendingB;
			}
			return read(path);
		};
		// B loads, and the pane points at it before the update arrives; linking
		// B waits for its file.
		pane.loadThenPoint('Notes/B.md', ORIGINAL['Notes/B.md']!);
		await delay(10);
		expectIntact(hub, a, b);
		// Back to A while the pane still shows B's text.
		pane.point('Notes/A.md');
		pane.nudge();
		await delay(10);
		expectIntact(hub, a, b);
		releaseB();
		await settle(a, b);
		expectIntact(hub, a, b);
		pane.save();
		await settle(a, b);
		expectIntact(hub, a, b);
		pane.load(ORIGINAL['Notes/A.md']!);
		await settle(a, b);
		pane.save();
		await settle(a, b);
		expectIntact(hub, a, b);
		expect(pane.text()).toBe(ORIGINAL['Notes/A.md']);
		expect(a.problems).toEqual([]);
		pane.close();
	});

	it('forgets a rename once the pane shows another file, before the renamed note links again', async () => {
		const { hub, a, b } = await pair();
		a.vault.onRename = (from, to) => renameFileObject(a.vault, from, to);
		const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
		await settle(a, b);
		a.vault.move('Notes/A.md', 'Notes/Renamed.md');
		expect(pane.file).toBe('Notes/Renamed.md');
		await settle(a, b);
		const read = a.vault.read.bind(a.vault);
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		a.vault.read = async (path) => {
			if (path === 'Notes/Renamed.md' || path === 'Notes/B.md') {
				await pending;
			}
			return read(path);
		};
		// The pane's next update sees the new name; linking it waits for the file.
		pane.nudge();
		await delay(10);
		// To B and back while the renamed note is still linking.
		pane.loadThenPoint('Notes/B.md', ORIGINAL['Notes/B.md']!);
		await delay(10);
		pane.point('Notes/Renamed.md');
		pane.nudge();
		await delay(10);
		release();
		await settle(a, b);
		pane.save();
		await settle(a, b);
		const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
		expect(Object.keys(index).sort()).toEqual(['B.md', 'C.md', 'Renamed.md']);
		expect(hub.text(noteDocName(index['Renamed.md']!.id))).toBe(ORIGINAL['Notes/A.md']);
		expect(hub.text(noteDocName(index['B.md']!.id))).toBe(ORIGINAL['Notes/B.md']);
		for (const d of [a, b]) {
			expect(d.vault.files.get('Notes/Renamed.md')).toBe(ORIGINAL['Notes/A.md']);
			expect(d.vault.files.get('Notes/B.md')).toBe(ORIGINAL['Notes/B.md']);
		}
		expect(a.problems).toEqual([]);
		pane.close();
	});

	it('does not take a rename for one when the same update loaded other text', async () => {
		const { hub, a, b } = await pair();
		a.vault.onRename = (from, to) => renameFileObject(a.vault, from, to);
		const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
		await settle(a, b);
		a.vault.move('Notes/A.md', 'Notes/Renamed.md');
		await settle(a, b);
		// The pane's first update after the rename also loads other text.
		pane.load(ORIGINAL['Notes/B.md']!);
		await settle(a, b);
		pane.save();
		await settle(a, b);
		const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
		expect(hub.text(noteDocName(index['Renamed.md']!.id))).toBe(ORIGINAL['Notes/A.md']);
		expect(b.vault.files.get('Notes/Renamed.md')).toBe(ORIGINAL['Notes/A.md']);
		expect(pane.text()).toBe(ORIGINAL['Notes/A.md']);
		pane.close();
	});

	it('refuses to let an editor replace most of a note without typing, and says so', async () => {
		const { hub, a, b } = await pair();
		const link = await a.engine.link('Notes/B.md');
		expect(link).not.toBeNull();
		link?.adopt('Text from somewhere else entirely.\n');
		link?.release();
		await settle(a, b);
		expectIntact(hub, a, b);
		expect(a.problems).toHaveLength(1);
		expect(a.problems[0]).toContain('B.md');
	});

	it('still merges an editor\'s own small changes when it links', async () => {
		const { hub, a, b } = await pair();
		const link = await a.engine.link('Notes/B.md');
		const edited = `${ORIGINAL['Notes/B.md']}One more line.\n`;
		expect(link?.owns(ORIGINAL['Notes/B.md'] as string)).toBe(true);
		expect(link?.owns(ORIGINAL['Notes/A.md'] as string)).toBe(false);
		link?.adopt(edited);
		link?.release();
		await settle(a, b);
		const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
		expect(hub.text(noteDocName(index['B.md']!.id))).toBe(edited);
		expect(b.vault.files.get('Notes/B.md')).toBe(edited);
		expect(a.problems).toEqual([]);
	});
});

describe('isLoad', () => {
	const state = EditorState.create({ doc: 'some text' });

	it('is a whole replacement nobody typed', () => {
		expect(isLoad(state.update({ changes: { from: 0, to: 9, insert: 'other' } }))).toBe(true);
		expect(isLoad(state.update({ changes: { from: 0, to: 9, insert: '' } }))).toBe(true);
	});

	it('is not typing, pasting or undoing, a partial change, or filling an empty editor', () => {
		const whole = { from: 0, to: 9, insert: 'other' };
		expect(isLoad(state.update({ changes: whole, userEvent: 'input.paste' }))).toBe(false);
		expect(isLoad(state.update({ changes: whole, userEvent: 'undo' }))).toBe(false);
		expect(isLoad(state.update({ changes: { from: 0, to: 4, insert: 'any' } }))).toBe(false);
		const empty = EditorState.create({ doc: '' });
		expect(isLoad(empty.update({ changes: { from: 0, insert: 'template' } }))).toBe(false);
	});
});

describe('replacesMost', () => {
	it('counts what is removed from the note', () => {
		expect(replacesMost('', 'anything')).toBe(false);
		expect(replacesMost('abcdefghij', 'abcdefghij and more')).toBe(false);
		expect(replacesMost('abcdefghij', 'a')).toBe(true);
		expect(replacesMost('abcdefghij', 'zzzzzzzzzz')).toBe(true);
		expect(replacesMost('abcdefghij', 'abcdezzzzz')).toBe(false);
		expect(replacesMost('one\ntwo\nthree\n', 'one\ntwo\nfour\n')).toBe(false);
		expect(replacesMost('the first line\nthe second line\n', 'Something different.\n')).toBe(true);
	});
});

/**
 * The server stamping base metadata into a note: it computes the new text
 * from the shared text it holds, which may not have this device's latest
 * typing yet, and the change then arrives through sync like any edit.
 */
function serverEdit(hub: MemoryHub, rel: string, edit: (text: string) => string, clientID?: number): () => void {
	const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
	const shared = hub.doc(noteDocName(index[rel]!.id));
	const server = new Y.Doc();
	if (clientID !== undefined) {
		server.clientID = clientID;
	}
	Y.applyUpdate(server, Y.encodeStateAsUpdate(shared));
	const before = Y.encodeStateVector(server);
	const text = server.getText('content');
	setText(text, edit(text.toJSON()));
	const update = Y.encodeStateAsUpdate(server, before);
	server.destroy();
	return () => Y.applyUpdate(shared, update);
}

const BASE_KEYS = 'brain-id: 5f0c2a9e-3b1d-4c7e-8a6f-0d2b4e6c8a1f\nbrain-created: 2026-10-16\nbrain-schema: stoasis/2\n';
const stamp = (text: string) =>
	text.startsWith('---\n') ? text.replace(/\n---\n/, `\n${BASE_KEYS}---\n`) : `---\n${BASE_KEYS}---\n${text}`;

describe('a base metadata stamp arriving while the note is open', () => {
	async function opened(text?: string) {
		const { hub, a, b } = await pair();
		if (text !== undefined) {
			a.vault.write('Notes/A.md', text);
			await settle(a, b);
		}
		const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
		await settle(a, b);
		expect(a.editors.size).toBe(1);
		return { hub, a, b, pane };
	}

	async function expectEverywhere(pane: Pane, hub: MemoryHub, a: Device, b: Device, expected: string) {
		await settle(a, b);
		pane.save();
		await settle(a, b);
		expect(pane.text()).toBe(expected);
		const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
		expect(hub.text(noteDocName(index['A.md']!.id))).toBe(expected);
		expect(a.vault.files.get('Notes/A.md')).toBe(expected);
		expect(b.vault.files.get('Notes/A.md')).toBe(expected);
		expect(a.problems).toEqual([]);
	}

	it('keeps the cursor and the typing in the body when the note had no frontmatter', async () => {
		const { hub, a, b, pane } = await opened();
		const original = ORIGINAL['Notes/A.md'] as string;
		const at = original.indexOf('A quiet day.') + 'A quiet'.length;
		pane.select(at);
		pane.typeHere(', calm');
		// Computed before this device's typing reached the server.
		const arrive = serverEdit(hub, 'A.md', stamp);
		pane.typeHere(' and');
		arrive();
		const added = `---\n${BASE_KEYS}---\n`.length;
		expect(pane.cursor).toBe(at + ', calm and'.length + added);
		pane.typeHere(' sunny');
		const typed = original.replace('A quiet day.', 'A quiet, calm and sunny day.');
		await expectEverywhere(pane, hub, a, b, stamp(typed));
		pane.close();
	});

	it('adds keys inside existing frontmatter without moving the cursor', async () => {
		const withFrontmatter = `---\ntitle: Day 1\ntags:\n  - daily\n---\n${ORIGINAL['Notes/A.md']}`;
		const { hub, a, b, pane } = await opened(withFrontmatter);
		const at = withFrontmatter.indexOf('Review the inbox') + 'Review'.length;
		pane.select(at);
		const arrive = serverEdit(hub, 'A.md', stamp);
		pane.typeHere(' all of');
		arrive();
		expect(pane.cursor).toBe(at + ' all of'.length + BASE_KEYS.length);
		pane.typeHere(' it,');
		const typed = withFrontmatter.replace('Review the inbox', 'Review all of it, the inbox');
		await expectEverywhere(pane, hub, a, b, stamp(typed));
		pane.close();
	});

	it('leaves a cursor at the very start of the note after the new frontmatter', async () => {
		const { hub, a, b, pane } = await opened();
		pane.select(0);
		serverEdit(hub, 'A.md', stamp)();
		pane.typeHere('Top. ');
		await expectEverywhere(pane, hub, a, b, stamp(`Top. ${ORIGINAL['Notes/A.md']}`));
		pane.close();
	});

	/** The client id of a device's copy of note A, which orders its inserts against the server's. */
	function clientOf(d: Device, hub: MemoryHub): number {
		const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
		return d.source.open(noteDocName(index['A.md']!.id)).doc.clientID;
	}

	const BLOCK = `---\n${BASE_KEYS}---\n`;

	// A known limit: Yjs orders two inserts at the same place made at the same
	// time by client id, so text typed at the start as the server adds the
	// first frontmatter can go before it. The plugin leaves it there rather
	// than move anyone's text; every character is kept, the same on every
	// device, and the cursor stays in what was typed.
	for (const order of ['before', 'after'] as const) {
		it(`keeps text typed at the start as the stamp arrives, with the server's client id ${order}`, async () => {
			const { hub, a, b, pane } = await opened();
			const mine = clientOf(a, hub);
			const server = order === 'before' ? mine - 1 : mine + 1;
			pane.select(0);
			// Computed before this device's typing reached the server.
			const arrive = serverEdit(hub, 'A.md', stamp, server);
			pane.typeHere('Typed. ');
			arrive();
			const original = ORIGINAL['Notes/A.md'] as string;
			const typedFirst = order === 'after';
			expect(pane.text()).toBe(typedFirst ? `Typed. ${BLOCK}${original}` : `${BLOCK}Typed. ${original}`);
			expect(pane.cursor).toBe(typedFirst ? 'Typed. '.length : `${BLOCK}Typed. `.length);
			pane.typeHere('More. ');
			await expectEverywhere(
				pane,
				hub,
				a,
				b,
				typedFirst ? `Typed. More. ${BLOCK}${original}` : `${BLOCK}Typed. More. ${original}`,
			);
			pane.close();
		});
	}

	it('keeps text typed at the start offline where Yjs puts it when the stamp arrives', async () => {
		const { hub, a, b, pane } = await opened();
		const server = clientOf(a, hub) + 1;
		a.source.setOnline(false);
		pane.select(0);
		pane.typeHere('Offline. ');
		serverEdit(hub, 'A.md', stamp, server)();
		await settle(a, b);
		expect(b.vault.files.get('Notes/A.md')).toBe(stamp(ORIGINAL['Notes/A.md'] as string));
		a.source.setOnline(true);
		await settle(a, b);
		expect(pane.cursor).toBe('Offline. '.length);
		await expectEverywhere(pane, hub, a, b, `Offline. ${BLOCK}${ORIGINAL['Notes/A.md']}`);
		pane.close();
	});

	it('keeps words another device added inside text typed at the start with them', async () => {
		const { hub, a, b, pane } = await opened();
		const other = new Pane(b.editors, b.vault, 'Notes/A.md');
		await settle(a, b);
		const arrive = serverEdit(hub, 'A.md', stamp, Math.max(clientOf(a, hub), clientOf(b, hub)) + 1);
		pane.select(0);
		pane.typeHere('Hello world. ');
		await settle(a, b);
		other.type('Hello'.length, ' brave');
		await settle(a, b);
		arrive();
		await settle(a, b);
		other.save();
		const original = ORIGINAL['Notes/A.md'] as string;
		await expectEverywhere(pane, hub, a, b, `Hello brave world. ${BLOCK}${original}`);
		expect(other.text()).toBe(pane.text());
		pane.close();
		other.close();
	});

	it('keeps a deletion another device made in text typed at the start', async () => {
		const { hub, a, b, pane } = await opened();
		const other = new Pane(b.editors, b.vault, 'Notes/A.md');
		await settle(a, b);
		const arrive = serverEdit(hub, 'A.md', stamp, Math.max(clientOf(a, hub), clientOf(b, hub)) + 1);
		pane.select(0);
		pane.typeHere('Hello world. ');
		await settle(a, b);
		other.dispatch({ changes: { from: 'Hello '.length, to: 'Hello world'.length }, userEvent: 'delete' });
		arrive();
		await settle(a, b);
		other.save();
		await expectEverywhere(pane, hub, a, b, `Hello . ${BLOCK}${ORIGINAL['Notes/A.md']}`);
		expect(other.text()).toBe(pane.text());
		pane.close();
		other.close();
	});

	it('leaves text typed at the start before a section between rules that arrives at the same time', async () => {
		const { hub, a, b, pane } = await opened();
		const section = '---\nA paragraph between rules, not metadata.\n---\n';
		pane.select(0);
		const arrive = serverEdit(hub, 'A.md', (text) => section + text, clientOf(a, hub) + 1);
		pane.typeHere('Typed. ');
		arrive();
		await expectEverywhere(pane, hub, a, b, `Typed. ${section}${ORIGINAL['Notes/A.md']}`);
		pane.close();
	});

	it('keeps a selection over body text selected', async () => {
		const { hub, a, b, pane } = await opened();
		const from = (ORIGINAL['Notes/A.md'] as string).indexOf('quiet');
		pane.dispatch({ selection: { anchor: from, head: from + 'quiet'.length } });
		serverEdit(hub, 'A.md', stamp)();
		const range = pane.state.selection.main;
		expect(pane.text().slice(range.from, range.to)).toBe('quiet');
		await expectEverywhere(pane, hub, a, b, stamp(ORIGINAL['Notes/A.md'] as string));
		pane.close();
	});
});

/**
 * Tag now on this device: the app's processFrontMatter rewrites the file on
 * disk, then shows the new text in the open editor, either by replacing it
 * whole or by changing only what differs.
 */
const TAG_PATCH = readPatch({ tags_add: ['daily'], set: { 'brain-type': 'journal' }, actor: 'agent' })!;
const TAGGED = 'tags:\n  - daily\nbrain-type: journal\nbrain-tagged: 2026-10-16 by agent\n';

/**
 * Tags the note on disk, as the plugin does inside processFrontMatter. With
 * `reviewed`, the frontmatter the proposal was made for, nothing is written
 * unless the note, and the open `pane`, still have it: then the result is null.
 */
async function tagOnDisk(device: Device, path: string, reviewed?: string, pane?: Pane): Promise<string | null> {
	// The plugin checks the open editor's properties first: they may not be saved yet.
	if (reviewed !== undefined && pane !== undefined && !stillReviewed(splitFrontmatter(pane.text()).frontmatter, reviewed)) {
		return null;
	}
	let written: string | null = null;
	await device.vault.process(path, (text) => {
		const { frontmatter, body } = splitFrontmatter(text);
		if (reviewed !== undefined && !stillReviewed(frontmatter, reviewed)) {
			return text;
		}
		applyToFrontmatter(frontmatter, TAG_PATCH, '2026-10-16');
		const yaml = Object.entries(frontmatter)
			.map(([key, value]) =>
				Array.isArray(value) ? `${key}:\n${value.map((v) => `  - ${String(v)}`).join('\n')}\n` : `${key}: ${String(value)}\n`,
			)
			.join('');
		written = `---\n${yaml}---\n${body}`;
		return written;
	});
	return written;
}

type Reload = (pane: Pane, text: string) => void;
const RELOADS: Array<[string, Reload]> = [
	[
		'the app replaces the editor text',
		(pane, text) => {
			pane.load(text);
			// That moves the cursor to the start; the user clicks back.
			pane.select(text.indexOf('calm day') + 'calm'.length);
		},
	],
	[
		'the app changes only what differs',
		(pane, text) => {
			const current = pane.text();
			let start = 0;
			while (start < current.length && start < text.length && current[start] === text[start]) {
				start++;
			}
			let end = 0;
			while (
				end < current.length - start &&
				end < text.length - start &&
				current[current.length - 1 - end] === text[text.length - 1 - end]
			) {
				end++;
			}
			pane.dispatch({ changes: { from: start, to: current.length - end, insert: text.slice(start, text.length - end) } });
		},
	],
];

/**
 * The app reloads an open note's file, and the editor links again only at
 * its next update. Edits from the other device can reach the file and the
 * note in between, any number of them.
 */
describe('an editor reloaded while edits from the other device arrive', () => {
	const remoteLines = (n: number) => Array.from({ length: n }, (_, i) => `- Remote line ${i}`).join('\n');
	const withRemote = (n: number) => (ORIGINAL['Notes/A.md'] as string).replace('- Next day', `- Next day\n${remoteLines(n)}`);

	async function reloadedThenEdited(count: number) {
		const { hub, a, b } = await pair();
		const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
		await settle(a, b);
		pane.load(pane.text());
		for (let i = 1; i <= count; i++) {
			b.vault.write('Notes/A.md', withRemote(i));
			await settle(a, b);
			expect(a.vault.files.get('Notes/A.md')).toBe(withRemote(i));
		}
		return { hub, a, b, pane };
	}

	function expectEverywhere(hub: MemoryHub, a: Device, b: Device, pane: Pane, expected: string) {
		const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
		expect(pane.text()).toBe(expected);
		expect(hub.text(noteDocName(index['A.md']!.id))).toBe(expected);
		expect(a.vault.files.get('Notes/A.md')).toBe(expected);
		expect(b.vault.files.get('Notes/A.md')).toBe(expected);
	}

	for (const count of [1, 5, 12]) {
		it(`keeps ${count} remote edits that arrived before the next update`, async () => {
			const { hub, a, b, pane } = await reloadedThenEdited(count);
			pane.select(pane.text().indexOf('A quiet') + 'A quiet'.length);
			pane.typeHere(', calm');
			await settle(a, b);
			pane.save();
			await settle(a, b);
			expectEverywhere(hub, a, b, pane, withRemote(count).replace('A quiet day.', 'A quiet, calm day.'));
			expect(a.problems).toEqual([]);
			pane.close();
		});
	}

	it('keeps them when linking again waits for the file', async () => {
		const { hub, a, b, pane } = await reloadedThenEdited(6);
		const read = a.vault.read.bind(a.vault);
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		a.vault.read = async (path) => {
			await pending;
			return read(path);
		};
		pane.nudge();
		await delay(10);
		// One more arrives while the editor links.
		b.vault.write('Notes/A.md', withRemote(7));
		await delay(10);
		release();
		await settle(a, b);
		pane.save();
		await settle(a, b);
		expectEverywhere(hub, a, b, pane, withRemote(7));
		expect(a.problems).toEqual([]);
		pane.close();
	});

	it('keeps both when nothing on this device says what the editor loaded', async () => {
		const { hub, a, b } = await pair();
		const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
		await settle(a, b);
		// Text that was never the file's, as far as this device knows.
		const unknown = `${ORIGINAL['Notes/A.md']}A line from nowhere.\n`;
		pane.load(unknown);
		for (let i = 1; i <= 2; i++) {
			b.vault.write('Notes/A.md', withRemote(i));
			await settle(a, b);
		}
		pane.nudge();
		await settle(a, b);
		pane.save();
		await settle(a, b);
		expectEverywhere(hub, a, b, pane, withRemote(2));
		const copies = [...a.vault.files.keys()].filter((p) => p.includes('(conflict'));
		expect(copies).toHaveLength(1);
		expect(a.vault.files.get(copies[0]!)).toBe(unknown);
		expect(a.problems).toHaveLength(1);
		pane.close();
	});
});

describe('tagging a note while it is open', () => {
	for (const [name, reload] of RELOADS) {
		it(`writes the properties once and keeps the typing: ${name}`, async () => {
			const { hub, a, b } = await pair();
			const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
			await settle(a, b);
			const at = (ORIGINAL['Notes/A.md'] as string).indexOf('A quiet day.') + 'A quiet'.length;
			pane.select(at);
			pane.typeHere(', calm');
			pane.save();
			await settle(a, b);

			const written = (await tagOnDisk(a, 'Notes/A.md')) as string;
			reload(pane, written);
			pane.typeHere(' and sunny');
			await settle(a, b);
			pane.save();
			await settle(a, b);

			const expected = `---\n${TAGGED}---\n${(ORIGINAL['Notes/A.md'] as string).replace('A quiet day.', 'A quiet, calm and sunny day.')}`;
			expect(pane.text()).toBe(expected);
			const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
			expect(hub.text(noteDocName(index['A.md']!.id))).toBe(expected);
			expect(a.vault.files.get('Notes/A.md')).toBe(expected);
			expect(b.vault.files.get('Notes/A.md')).toBe(expected);
			expect(a.problems).toEqual([]);
			expect(b.problems).toEqual([]);
			pane.close();
		});
	}

	const NEXT_UPDATES: Array<[string, (pane: Pane) => void, string]> = [
		['a click', (pane) => pane.select(pane.text().indexOf('A quiet')), 'A quiet day.'],
		[
			'typing',
			(pane) => {
				pane.select(pane.text().indexOf('A quiet') + 'A quiet'.length);
				pane.typeHere(', calm');
			},
			'A quiet, calm day.',
		],
	];
	for (const [name, next, body] of NEXT_UPDATES) {
		it(`keeps an edit from another device that arrives before the editor's next update: ${name}`, async () => {
			const { hub, a, b } = await pair();
			const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
			await settle(a, b);
			const fromB = (ORIGINAL['Notes/A.md'] as string).replace('- Next day', '- Next day\n- Notes from B');
			b.vault.write('Notes/A.md', fromB);
			const written = (await tagOnDisk(a, 'Notes/A.md')) as string;
			pane.load(written);
			// B's line reaches this device, and its disk, before the editor updates again.
			await settle(a, b);
			expect(a.vault.files.get('Notes/A.md')).toContain('- Notes from B');
			next(pane);
			await settle(a, b);
			pane.save();
			await settle(a, b);

			const expected = `---\n${TAGGED}---\n${fromB.replace('A quiet day.', body)}`;
			expect(pane.text()).toBe(expected);
			const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
			expect(hub.text(noteDocName(index['A.md']!.id))).toBe(expected);
			expect(a.vault.files.get('Notes/A.md')).toBe(expected);
			expect(b.vault.files.get('Notes/A.md')).toBe(expected);
			expect(a.problems).toEqual([]);
			expect(b.problems).toEqual([]);
			pane.close();
		});
	}

	it('writes nothing for a proposal made before the other device changed the properties', async () => {
		const { hub, a, b } = await pair();
		const pane = new Pane(a.editors, a.vault, 'Notes/A.md');
		await settle(a, b);
		// The proposal is made for the note as it is: no frontmatter.
		const reviewed = reviewedFrontmatter(splitFrontmatter(pane.text()).frontmatter);
		const fromB = `---\nbrain-people:\n  - [[Bob Example]]\n---\n${ORIGINAL['Notes/A.md'] as string}`;
		b.vault.write('Notes/A.md', fromB);
		await settle(a, b);
		expect(pane.text()).toBe(fromB);
		pane.select(pane.text().indexOf('A quiet') + 'A quiet'.length);
		pane.typeHere(', calm');

		// The editor has the new properties; the file may not have them yet.
		expect(await tagOnDisk(a, 'Notes/A.md', reviewed, pane)).toBeNull();
		pane.save();
		await settle(a, b);
		// Once saved, the file has them too.
		expect(await tagOnDisk(a, 'Notes/A.md', reviewed)).toBeNull();
		await settle(a, b);
		pane.save();
		await settle(a, b);

		const expected = fromB.replace('A quiet day.', 'A quiet, calm day.');
		expect(pane.text()).toBe(expected);
		const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
		expect(hub.text(noteDocName(index['A.md']!.id))).toBe(expected);
		expect(a.vault.files.get('Notes/A.md')).toBe(expected);
		expect(b.vault.files.get('Notes/A.md')).toBe(expected);
		expect(a.problems).toEqual([]);
		expect(b.problems).toEqual([]);
		pane.close();
	});
});

/**
 * A copy kept in a conflict is a note of its own, synced like any other.
 * Keeping one side writes the note on disk while it may be open, and trashes
 * the copy, on this device; sync carries both to the other device.
 */
describe('keeping one side of a conflict copy while the note is open', () => {
	const COPY = 'Notes/A (conflict 2026-10-16).md';
	const COPY_TEXT = day(1, 'Write the summary', 'A quiet day, written on this device while it was offline.');

	async function withCopy() {
		const { hub, a, b } = await pair();
		a.vault.write(COPY, COPY_TEXT);
		await settle(a, b);
		expect(b.vault.files.get(COPY)).toBe(COPY_TEXT);
		const paneA = new Pane(a.editors, a.vault, 'Notes/A.md');
		const paneB = new Pane(b.editors, b.vault, 'Notes/A.md');
		await settle(a, b);
		const index = () => hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
		return { hub, a, b, paneA, paneB, index };
	}

	/**
	 * The two files as the plugin compares them on device `d`: each as an
	 * open pane shows it, else as on disk, and the synced note at each path.
	 */
	async function compare(d: Device, ...panes: Pane[]): Promise<{ files: ConflictFiles; compared: Compared }> {
		const paths = { copy: COPY, original: 'Notes/A.md' };
		const ids = { copy: d.engine.noteAt(COPY), original: d.engine.noteAt('Notes/A.md') };
		const files: ConflictFiles = {
			same: (side) => d.vault.exists(paths[side]) && d.engine.noteAt(paths[side]) === ids[side],
			shown: (side) => panes.find((pane) => pane.file === paths[side])?.text() ?? null,
			read: (side) => d.vault.read(paths[side]),
			process: (side, update) => d.vault.process(paths[side], update),
			trash: (side) => d.vault.trash(paths[side]),
		};
		const compared: Compared = {
			copyText: files.shown('copy') ?? (await files.read('copy')),
			originalText: files.shown('original') ?? (await files.read('original')),
		};
		return { files, compared };
	}

	const SHOWS: Array<[string, Reload]> = [
		['the app replaces the editor text', (pane, text) => pane.load(text)],
		RELOADS[1]!,
	];
	for (const [name, reload] of SHOWS) {
		it(`keep this device: the note gets the copy's text everywhere, and the copy goes: ${name}`, async () => {
			const { hub, a, b, paneA, paneB, index } = await withCopy();
			const { files, compared } = await compare(a, paneA);
			expect(await useConflictCopy(files, compared)).toBe('kept');
			// The app shows the note's new text in its open editor.
			reload(paneA, COPY_TEXT);
			await settle(a, b);
			paneB.save();
			await settle(a, b);

			expect(a.vault.trashed).toEqual([COPY]);
			expect(a.vault.files.has(COPY)).toBe(false);
			expect(b.vault.files.has(COPY)).toBe(false);
			expect(Object.keys(index()).sort()).toEqual(['A.md', 'B.md', 'C.md']);
			expect(hub.text(noteDocName(index()['A.md']!.id))).toBe(COPY_TEXT);
			expect(a.vault.files.get('Notes/A.md')).toBe(COPY_TEXT);
			expect(b.vault.files.get('Notes/A.md')).toBe(COPY_TEXT);
			expect(paneA.text()).toBe(COPY_TEXT);
			expect(paneB.text()).toBe(COPY_TEXT);
			expect(a.problems).toEqual([]);
			expect(b.problems).toEqual([]);
			paneA.close();
			paneB.close();
		});
	}

	it('keep the server: the note stays as it is, and the copy goes', async () => {
		const { hub, a, b, paneA, paneB } = await withCopy();
		const { files, compared } = await compare(a, paneA);
		expect(await keepSyncedNote(files, compared)).toBe('kept');
		await settle(a, b);
		expect(a.vault.files.has(COPY)).toBe(false);
		expect(b.vault.files.has(COPY)).toBe(false);
		expectIntact(hub, a, b);
		expect(paneA.text()).toBe(ORIGINAL['Notes/A.md']);
		expect(paneB.text()).toBe(ORIGINAL['Notes/A.md']);
		expect(a.problems).toEqual([]);
		expect(b.problems).toEqual([]);
		paneA.close();
		paneB.close();
	});

	it('use conflict copy, with the copy open and typed in but not saved: the note gets the typing', async () => {
		const { hub, a, b, paneA, paneB, index } = await withCopy();
		const copyPane = new Pane(a.editors, a.vault, COPY);
		await settle(a, b);
		const at = copyPane.text().indexOf('A quiet day');
		copyPane.type(at, 'Unsaved: ');
		const typed = copyPane.text();
		expect(a.vault.files.get(COPY)).toBe(COPY_TEXT);
		const { files, compared } = await compare(a, paneA, copyPane);
		expect(compared.copyText).toBe(typed);
		expect(await useConflictCopy(files, compared)).toBe('kept');
		paneA.load(typed);
		copyPane.close();
		await settle(a, b);
		paneB.save();
		await settle(a, b);

		expect(a.vault.files.get('Notes/A.md')).toBe(typed);
		expect(b.vault.files.get('Notes/A.md')).toBe(typed);
		expect(hub.text(noteDocName(index()['A.md']!.id))).toBe(typed);
		expect(paneB.text()).toBe(typed);
		expect(a.vault.files.has(COPY)).toBe(false);
		expect(b.vault.files.has(COPY)).toBe(false);
		expect(a.problems).toEqual([]);
		expect(b.problems).toEqual([]);
		paneA.close();
		paneB.close();
	});

	for (const choice of ['use conflict copy', 'keep current synced note'] as const) {
		it(`${choice}, typed in the open copy as it is about to go: the copy and the typing stay`, async () => {
			const { hub, a, b, paneA, paneB, index } = await withCopy();
			const copyPane = new Pane(a.editors, a.vault, COPY);
			await settle(a, b);
			const { files, compared } = await compare(a, paneA, copyPane);
			// The last read of the copy before the trash: the person types meanwhile.
			const read = files.read.bind(files);
			files.read = async (side) => {
				const text = await read(side);
				if (side === 'copy' && (choice === 'keep current synced note' || a.vault.files.get('Notes/A.md') === COPY_TEXT)) {
					files.read = read;
					copyPane.type(copyPane.text().indexOf('A quiet day'), 'Late: ');
				}
				return text;
			};
			const kept = choice === 'use conflict copy' ? await useConflictCopy(files, compared) : await keepSyncedNote(files, compared);
			const typed = copyPane.text();
			expect(typed).toContain('Late: A quiet day');
			if (choice === 'use conflict copy') {
				expect(kept).toBe('copy-changed');
				paneA.load(COPY_TEXT);
			} else {
				expect(kept).toBe('changed');
			}
			copyPane.save();
			await settle(a, b);
			paneB.save();
			await settle(a, b);

			const note = choice === 'use conflict copy' ? COPY_TEXT : ORIGINAL['Notes/A.md'];
			expect(a.vault.trashed).toEqual([]);
			for (const d of [a, b]) {
				expect(d.vault.files.get(COPY)).toBe(typed);
				expect(d.vault.files.get('Notes/A.md')).toBe(note);
				expect(d.problems).toEqual([]);
			}
			expect(hub.text(noteDocName(index()['A.md']!.id))).toBe(note);
			expect(paneB.text()).toBe(note);
			copyPane.close();
			paneA.close();
			paneB.close();
		});
	}

	it('use conflict copy, while the other device edits the copy: the edit is kept in the copy', async () => {
		const { hub, a, b, paneA, paneB, index } = await withCopy();
		const { files, compared } = await compare(a, paneA);
		// The other device's edit to the copy arrives while the note gets the copy's text.
		const edited = COPY_TEXT.replace('A quiet day', 'A quiet day, edited on the other device');
		const process = a.vault.process.bind(a.vault);
		a.vault.process = async (path, update) => {
			a.vault.process = process;
			await process(path, update);
			b.vault.write(COPY, edited);
			await settle(a, b);
		};
		expect(await useConflictCopy(files, compared)).toBe('copy-changed');
		paneA.load(COPY_TEXT);
		await settle(a, b);
		paneB.save();
		await settle(a, b);

		expect(a.vault.files.get('Notes/A.md')).toBe(COPY_TEXT);
		expect(b.vault.files.get('Notes/A.md')).toBe(COPY_TEXT);
		expect(hub.text(noteDocName(index()['A.md']!.id))).toBe(COPY_TEXT);
		expect(a.vault.files.get(COPY)).toBe(edited);
		expect(b.vault.files.get(COPY)).toBe(edited);
		expect(a.vault.trashed).toEqual([]);
		expect(a.problems).toEqual([]);
		expect(b.problems).toEqual([]);
		paneA.close();
		paneB.close();
	});
});

describe('a case-only rename while the note is open', () => {
	/** Both devices ignore case, as on macOS and iOS; each has the note open. */
	async function withPanes() {
		const { hub, a, b } = await pair();
		a.vault.ignoresCase = true;
		b.vault.ignoresCase = true;
		const paneA = new Pane(a.editors, a.vault, 'Notes/A.md');
		const paneB = new Pane(b.editors, b.vault, 'Notes/A.md');
		// The app's views follow a renamed file without a transaction: they
		// hold the same file object, whose path changes.
		for (const vault of [a.vault, b.vault]) {
			vault.onRename = (from, to) => renameFileObject(vault, from, to);
		}
		await settle(a, b);
		const index = () => hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
		return { hub, a, b, paneA, paneB, index };
	}

	const NOTE = 'Notes/A.md';
	const CASE_ONLY = 'Notes/a.md';
	const TYPED = ORIGINAL[NOTE]!.replace('A quiet day.', 'A quiet day. Typed before. Typed after.');

	for (const [name, renamer, RENAMED] of [
		['on the other device', 'a', CASE_ONLY],
		['on this device', 'b', CASE_ONLY],
		// Any rename: what was typed before it is not merged in twice.
		['to another name on the other device', 'a', 'Notes/Renamed.md'],
		['to another name on this device', 'b', 'Notes/Renamed.md'],
	] as const) {
		it(`follows a rename ${name} and keeps the typing around it`, async () => {
			const RENAMED_REL = RENAMED.slice('Notes/'.length);
			const { hub, a, b, paneA, paneB, index } = await withPanes();
			const id = index()['A.md']!.id;
			const at = paneB.text().indexOf('A quiet day.') + 'A quiet day.'.length;
			paneB.select(at);
			paneB.typeHere(' Typed before.');
			(renamer === 'a' ? a : b).vault.move(NOTE, RENAMED);
			await settle(a, b);
			// Any update, such as a scroll, that leaves the cursor where it is.
			paneB.dispatch({});
			paneB.typeHere(' Typed after.');
			await settle(a, b);
			paneA.save();
			paneB.save();
			await settle(a, b);

			expect(Object.keys(index()).sort()).toEqual(['B.md', 'C.md', RENAMED_REL].sort());
			expect(index()[RENAMED_REL]!.id).toBe(id);
			expect(hub.text(noteDocName(id))).toBe(TYPED);
			for (const d of [a, b]) {
				expect([...d.vault.files.keys()].filter((p) => p.startsWith('Notes/')).sort()).toEqual(
					['Notes/B.md', 'Notes/C.md', RENAMED].sort(),
				);
				expect(d.vault.files.get(RENAMED)).toBe(TYPED);
				expect(d.state.known[RENAMED_REL]).toBe(id);
				expect(d.problems).toEqual([]);
			}
			expect(paneA.file).toBe(RENAMED);
			expect(paneB.file).toBe(RENAMED);
			expect(paneA.text()).toBe(TYPED);
			expect(paneB.text()).toBe(TYPED);
			expect(paneB.cursor).toBe(TYPED.indexOf(' Typed after.') + ' Typed after.'.length);
			paneA.close();
			paneB.close();
		});
	}

	it('renames back, and on a device that minds case', async () => {
		const { hub, a, b, paneA, paneB, index } = await withPanes();
		b.vault.ignoresCase = false;
		const id = index()['A.md']!.id;
		a.vault.move(NOTE, CASE_ONLY);
		await settle(a, b);
		b.vault.move(CASE_ONLY, NOTE);
		await settle(a, b);
		expect(Object.keys(index()).sort()).toEqual(['A.md', 'B.md', 'C.md']);
		expect(index()['A.md']!.id).toBe(id);
		expectIntact(hub, a, b);
		expect([a.vault.files.has(CASE_ONLY), b.vault.files.has(CASE_ONLY)]).toEqual([false, false]);
		expect([paneA.file, paneB.file]).toEqual([NOTE, NOTE]);
		expect(a.problems).toEqual([]);
		expect(b.problems).toEqual([]);
		paneA.close();
		paneB.close();
	});

	for (const saving of [false, true]) {
		it(`keeps what is typed while a case-only rename goes by way of a temporary name${saving ? ', saved meanwhile' : ''}`, async () => {
			const { hub, a, b, paneA, paneB, index } = await withPanes();
			const id = index()['A.md']!.id;
			const at = paneB.text().indexOf('A quiet day.') + 'A quiet day.'.length;
			paneB.select(at);
			paneB.typeHere(' Before.');
			// At each step the app's view follows the file and updates; the
			// engine's rename takes a while, and the person types meanwhile.
			b.vault.onRename = (from, to) => {
				renameFileObject(b.vault, from, to);
				paneB.dispatch({});
			};
			const rename = b.vault.rename.bind(b.vault);
			const steps: string[] = [];
			b.vault.rename = async (from, to) => {
				await rename(from, to);
				steps.push(to);
				await delay(10);
				paneB.typeHere(` During ${steps.length}.`);
				if (saving) {
					paneB.save();
				}
				await delay(10);
			};
			a.vault.move(NOTE, CASE_ONLY);
			await settle(a, b);
			paneB.typeHere(' After.');
			await settle(a, b);
			paneA.save();
			paneB.save();
			await settle(a, b);

			expect(steps).toEqual(['Notes/A (renaming).md', CASE_ONLY]);
			const typed = ORIGINAL[NOTE]!.replace('A quiet day.', 'A quiet day. Before. During 1. During 2. After.');
			expect(hub.text(noteDocName(id))).toBe(typed);
			expect(index()['a.md']!.id).toBe(id);
			for (const d of [a, b]) {
				expect(d.vault.files.get(CASE_ONLY)).toBe(typed);
				expect(d.vault.files.has('Notes/A (renaming).md')).toBe(false);
				expect(d.problems).toEqual([]);
			}
			expect(paneA.text()).toBe(typed);
			expect(paneB.text()).toBe(typed);
			expect(paneB.file).toBe(CASE_ONLY);
			paneA.close();
			paneB.close();
		});
	}

	it('drops what a rename kept when the editor switches files before the rename is done', async () => {
		const { hub, a, b, paneA, paneB, index } = await withPanes();
		const id = index()['A.md']!.id;
		b.vault.onRename = (from, to) => {
			renameFileObject(b.vault, from, to);
			paneB.dispatch({});
		};
		const rename = b.vault.rename.bind(b.vault);
		let switched = false;
		b.vault.rename = async (from, to) => {
			await rename(from, to);
			if (!switched) {
				switched = true;
				// Mid-rename, the pane opens B, then the renamed note again.
				paneB.loadThenPoint('Notes/B.md', ORIGINAL['Notes/B.md']!);
				await delay(10);
				paneB.nudge();
			}
		};
		a.vault.move(NOTE, CASE_ONLY);
		await settle(a, b);
		paneB.loadThenPoint(CASE_ONLY, b.vault.files.get(CASE_ONLY)!);
		await settle(a, b);
		paneB.nudge();
		await settle(a, b);
		paneA.save();
		paneB.save();
		await settle(a, b);

		expect(hub.text(noteDocName(id))).toBe(ORIGINAL[NOTE]);
		expect(hub.text(noteDocName(index()['B.md']!.id))).toBe(ORIGINAL['Notes/B.md']);
		for (const d of [a, b]) {
			expect(d.vault.files.get(CASE_ONLY)).toBe(ORIGINAL[NOTE]);
			expect(d.vault.files.get('Notes/B.md')).toBe(ORIGINAL['Notes/B.md']);
			expect(d.problems).toEqual([]);
		}
		expect(paneB.text()).toBe(ORIGINAL[NOTE]);
		paneA.close();
		paneB.close();
	});

	it('downloads a note skipped for a case clash once the open note here is renamed', async () => {
		const { hub, a, b, paneA, paneB, index } = await withPanes();
		a.vault.ignoresCase = false;
		a.vault.write(CASE_ONLY, 'Lower-case distinct note.\n');
		await settle(a, b);
		expect(b.vault.files.has(CASE_ONLY)).toBe(false);
		expect(b.problems).toHaveLength(1);

		b.vault.move(NOTE, 'Notes/Resolved.md');
		await settle(a, b);
		expect(b.vault.files.get(CASE_ONLY)).toBe('Lower-case distinct note.\n');
		expect(b.vault.files.get('Notes/Resolved.md')).toBe(ORIGINAL[NOTE]);
		expect(hub.text(noteDocName(index()['a.md']!.id))).toBe('Lower-case distinct note.\n');
		expect(paneB.file).toBe('Notes/Resolved.md');
		expect(paneB.text()).toBe(ORIGINAL[NOTE]);
		expect(b.problems).toHaveLength(1);
		paneA.close();
		paneB.close();
	});
});
