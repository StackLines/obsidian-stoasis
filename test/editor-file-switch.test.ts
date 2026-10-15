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
import { replacesMost } from '../src/sync/text';
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
