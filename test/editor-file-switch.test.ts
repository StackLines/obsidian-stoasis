// Switching the file shown in one editor must never copy one note into
// another. The app reuses an editor when it opens another file: it points the
// view at the new file first, without a transaction, then replaces the text
// once it has read the file. Any update in between sees the new file with the
// old file's text.
import 'fake-indexeddb/auto';
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncedEditor, isLoad, type EditorViewLike } from '../src/editor';
import { EditorSync } from '../src/sync/binding';
import { noteDocName, spaceDocName } from '../src/sync/docs';
import { SyncEngine, emptyEngineState, type EngineState } from '../src/sync/engine';
import { replacesMost, setText } from '../src/sync/text';
import { readPatch } from '../src/frontmatter-patch';
import { applyToFrontmatter } from '../src/tagging';
import { splitFrontmatter } from './stubs/obsidian';
import { keepTheServer, keepThisDevice } from '../src/conflict';
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
	return { engine, vault, state, editors, problems };
}

async function settle(...devices: Device[]): Promise<void> {
	for (let round = 0; round < 20; round++) {
		await delay(3);
		for (const d of devices) {
			await d.engine.idle();
		}
	}
}

/**
 * One editor pane as the app drives it: a CodeMirror state, the file the
 * pane shows (changed without a transaction, like the app's view), and saves
 * that write the editor's text to that file.
 */
class Pane implements EditorViewLike {
	state: EditorState;
	file: string | null;
	/** What the app last loaded or saved; it saves only when the text differs. */
	private data: string;
	private editor: SyncedEditor;

	constructor(
		private readonly sync: EditorSync,
		private readonly vault: FakeVault,
		file: string | null,
	) {
		this.file = file;
		this.data = file === null ? '' : (vault.files.get(file) ?? '');
		this.state = EditorState.create({ doc: this.data });
		this.editor = new SyncedEditor(sync, this, () => this.file);
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
		this.file = file;
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
		this.file = file;
		this.data = text;
		this.state = EditorState.create({ doc: text });
		this.editor = new SyncedEditor(this.sync, this, () => this.file);
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
function serverEdit(hub: MemoryHub, rel: string, edit: (text: string) => string): () => void {
	const index = hub.doc(spaceDocName(SPACE_ID)).getMap('index').toJSON() as Record<string, { id: string }>;
	const shared = hub.doc(noteDocName(index[rel]!.id));
	const server = new Y.Doc();
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

async function tagOnDisk(device: Device, path: string): Promise<string> {
	let written = '';
	await device.vault.process(path, (text) => {
		const { frontmatter, body } = splitFrontmatter(text);
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

			const written = await tagOnDisk(a, 'Notes/A.md');
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
			const written = await tagOnDisk(a, 'Notes/A.md');
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

	const SHOWS: Array<[string, Reload]> = [
		['the app replaces the editor text', (pane, text) => pane.load(text)],
		RELOADS[1]!,
	];
	for (const [name, reload] of SHOWS) {
		it(`keep this device: the note gets the copy's text everywhere, and the copy goes: ${name}`, async () => {
			const { hub, a, b, paneA, paneB, index } = await withCopy();
			await keepThisDevice(a.vault, COPY, 'Notes/A.md');
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
		await keepTheServer(a.vault, COPY);
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
});
