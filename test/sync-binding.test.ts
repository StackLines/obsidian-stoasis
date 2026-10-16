import { EditorState, Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { deltaToEdits, EditorSync, type EditorPort } from '../src/sync/binding';
import type { NoteLink } from '../src/sync/engine';
import { setText, type TextEdit } from '../src/sync/text';

/** An editor without a screen: CodeMirror state plus the binding's hooks. */
class TestEditor implements EditorPort {
	state: EditorState;
	undoable = 0;
	handle: ReturnType<EditorSync['attach']> | null = null;

	constructor(text: string) {
		this.state = EditorState.create({ doc: text });
	}

	text(): string {
		return this.state.doc.toString();
	}

	applyRemote(edits: readonly TextEdit[]): void {
		const tr = this.state.update({
			changes: edits.map((e) => ({ from: e.pos, to: e.pos + e.del, insert: e.ins })),
			annotations: Transaction.addToHistory.of(false),
		});
		this.state = tr.state;
	}

	type(from: number, to: number, insert: string): void {
		const tr = this.state.update({ changes: { from, to, insert } });
		this.state = tr.state;
		this.undoable++;
		const edits: TextEdit[] = [];
		tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
			edits.push({ pos: fromA, del: toA - fromA, ins: inserted.toString() });
		});
		this.handle?.typed(edits);
	}
}

class TestLinker {
	readonly docs = new Map<string, Y.Doc>();
	/** Files on disk; a note owns any text when its file is not listed. */
	readonly disk = new Map<string, string>();
	readonly links: string[] = [];
	released = 0;

	doc(path: string): Y.Doc {
		let doc = this.docs.get(path);
		if (doc === undefined) {
			doc = new Y.Doc();
			this.docs.set(path, doc);
		}
		return doc;
	}

	link(path: string): Promise<NoteLink | null> {
		if (!path.endsWith('.md')) {
			return Promise.resolve(null);
		}
		this.links.push(path);
		const text = this.doc(path).getText('content');
		return Promise.resolve({
			text,
			adopt: (editorText: string) => {
				if (text.length === 0) {
					setText(text, editorText);
				}
			},
			owns: (claim: string) => {
				const disk = this.disk.get(path);
				return disk === undefined || claim === disk || claim === text.toJSON();
			},
			release: () => {
				this.released++;
			},
		});
	}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup(text: string, path = 'Note.md') {
	const linker = new TestLinker();
	const sync = new EditorSync();
	sync.setLinker(linker);
	const editor = new TestEditor(text);
	editor.handle = sync.attach(editor, path);
	await tick();
	return { linker, sync, editor, ytext: linker.doc(path).getText('content') };
}

describe('editor binding', () => {
	it('sends typing to the shared text and shows remote edits', async () => {
		const { editor, ytext } = await setup('Hello');
		expect(ytext.toJSON()).toBe('Hello');

		editor.type(5, 5, ' world');
		expect(ytext.toJSON()).toBe('Hello world');

		ytext.insert(0, '> ');
		expect(editor.text()).toBe('> Hello world');
		ytext.delete(2, 6);
		expect(editor.text()).toBe('> world');
	});

	it('shows the shared text when the editor opened with an older copy', async () => {
		const linker = new TestLinker();
		linker.doc('Note.md').getText('content').insert(0, 'newer text');
		const sync = new EditorSync();
		sync.setLinker(linker);
		const editor = new TestEditor('older');
		editor.handle = sync.attach(editor, 'Note.md');
		await tick();
		expect(editor.text()).toBe('newer text');
	});

	it('does not echo remote edits back as local ones', async () => {
		const { editor, ytext } = await setup('abc');
		let updates = 0;
		ytext.doc?.on('update', () => updates++);
		ytext.insert(3, 'd');
		expect(updates).toBe(1);
		expect(editor.undoable).toBe(0);
	});

	it('binds only one editor per note and hands over when it closes', async () => {
		const { linker, sync, editor } = await setup('x');
		const second = new TestEditor('x');
		second.handle = sync.attach(second, 'Note.md');
		await tick();
		expect(linker.links).toEqual(['Note.md']);
		expect(second.handle.bound).toBe(false);

		editor.handle?.detach();
		await tick();
		expect(second.handle.bound).toBe(true);
		expect(linker.links).toEqual(['Note.md', 'Note.md']);
		expect(sync.size).toBe(1);
	});

	it('follows the editor to another file', async () => {
		const { linker, editor } = await setup('one');
		editor.handle?.setPath('Other.md');
		await tick();
		expect(linker.released).toBe(1);
		expect(linker.links).toEqual(['Note.md', 'Other.md']);
		editor.handle?.setPath('picture.png');
		await tick();
		expect(editor.handle?.bound).toBe(false);
	});

	it('shows the new note instead of merging the previous file\'s text into it', async () => {
		const linker = new TestLinker();
		const sync = new EditorSync();
		sync.setLinker(linker);
		for (const [path, text] of [['A.md', 'alpha'], ['B.md', 'bravo']]) {
			linker.disk.set(path as string, text as string);
			setText(linker.doc(path as string).getText('content'), text as string);
		}
		const editor = new TestEditor('alpha');
		editor.handle = sync.attach(editor, 'A.md');
		await tick();
		editor.handle.setPath('B.md');
		await tick();
		expect(linker.doc('B.md').getText('content').toJSON()).toBe('bravo');
		expect(editor.text()).toBe('bravo');
		editor.type(5, 5, '!');
		expect(linker.doc('B.md').getText('content').toJSON()).toBe('bravo!');
		expect(linker.doc('A.md').getText('content').toJSON()).toBe('alpha');
	});

	it('links no note after a load until the next update, then merges what was loaded', async () => {
		const { editor, ytext } = await setup('');
		expect(editor.handle?.bound).toBe(true);
		editor.state = EditorState.create({ doc: 'loaded' });
		editor.handle?.loaded('loaded');
		await tick();
		expect(editor.handle?.bound).toBe(false);
		expect(ytext.toJSON()).toBe('');
		editor.handle?.resume();
		await tick();
		expect(editor.handle?.bound).toBe(true);
		expect(ytext.toJSON()).toBe('loaded');
		expect(editor.text()).toBe('loaded');
	});

	it('unbinds everything when sync stops, and binds again when it starts', async () => {
		const { linker, sync, editor, ytext } = await setup('one');
		sync.setLinker(null);
		expect(linker.released).toBe(1);
		ytext.insert(0, 'remote ');
		expect(editor.text()).toBe('one');

		sync.setLinker(linker);
		await tick();
		expect(editor.text()).toBe('remote one');
	});
});

describe('deltaToEdits', () => {
	it('turns a change into edits in positions before it', () => {
		const doc = new Y.Doc();
		const text = doc.getText('t');
		text.insert(0, 'abcdef');
		let edits: TextEdit[] = [];
		text.observe((event) => {
			edits = deltaToEdits(event.delta);
		});
		doc.transact(() => {
			text.delete(1, 2);
			text.insert(1, 'XY');
			text.insert(6, '!');
		});
		const before = 'abcdef';
		let after = before;
		for (let i = edits.length - 1; i >= 0; i--) {
			const e = edits[i] as TextEdit;
			after = after.slice(0, e.pos) + e.ins + after.slice(e.pos + e.del);
		}
		expect(after).toBe(text.toJSON());
	});
});
