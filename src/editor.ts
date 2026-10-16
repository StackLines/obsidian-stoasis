import {
	Annotation,
	EditorSelection,
	Transaction,
	type ChangeSet,
	type EditorState,
	type Extension,
	type TransactionSpec,
} from '@codemirror/state';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import type { EditorHandle, EditorSync } from './sync/binding';
import type { TextEdit } from './sync/text';

/** Marks editor changes that came from the shared text, so they are not sent back. */
const fromSync = Annotation.define<boolean>();

/**
 * The file an editor shows. The app changes it on the view itself, without a
 * transaction, so an update can see the new file before the new file's text.
 */
function filePath(view: EditorView): string | null {
	return view.state.field(editorInfoField, false)?.file?.path ?? null;
}

/**
 * Whether a transaction replaced the whole of a non-empty text without the
 * user doing it: the app loading a file into the editor, which is not typing.
 * Typing, pasting, cutting and undoing carry a user event.
 */
export function isLoad(tr: Transaction): boolean {
	const length = tr.startState.doc.length;
	if (length === 0 || tr.annotation(Transaction.userEvent) !== undefined) {
		return false;
	}
	let changes = 0;
	let whole = false;
	tr.changes.iterChangedRanges((fromA, toA) => {
		changes++;
		whole = fromA === 0 && toA === length;
	});
	return changes === 1 && whole;
}

/** The parts of a CodeMirror view the binding uses. */
export interface EditorViewLike {
	readonly state: EditorState;
	dispatch(spec: TransactionSpec): void;
}

/** Keeps one editor linked to the note of the file it shows. */
export class SyncedEditor {
	private readonly handle: EditorHandle;

	constructor(
		sync: EditorSync,
		private readonly view: EditorViewLike,
		private readonly path: () => string | null,
	) {
		this.handle = sync.attach(
			{
				text: () => this.view.state.doc.toString(),
				applyRemote: (edits) => this.applyRemote(edits),
			},
			path(),
		);
	}

	/** Called after each view update, with the transactions it applied. */
	update(transactions: readonly Transaction[]): void {
		const path = this.path();
		if (path !== this.handle.path) {
			// The editor shows another file. Text changes in this update came
			// with the switch, not from typing, and the text may still be the
			// previous file's: send nothing, and let the new note check it.
			this.handle.setPath(path);
			return;
		}
		this.handle.resume();
		for (const tr of transactions) {
			if (!tr.docChanged || tr.annotation(fromSync) === true) {
				continue;
			}
			if (isLoad(tr)) {
				this.handle.loaded();
				continue;
			}
			const edits: TextEdit[] = [];
			tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
				edits.push({ pos: fromA, del: toA - fromA, ins: inserted.toString() });
			});
			this.handle.typed(edits);
		}
	}

	destroy(): void {
		this.handle.detach();
	}

	private applyRemote(edits: readonly TextEdit[]): void {
		if (edits.length === 0) {
			return;
		}
		const state = this.view.state;
		const changes = state.changes(
			edits.map((edit) => ({
				from: edit.pos,
				to: edit.pos + edit.del,
				insert: edit.ins,
			})),
		);
		const spec: TransactionSpec = {
			changes,
			annotations: [fromSync.of(true), Transaction.addToHistory.of(false)],
		};
		// Text inserted at the very start goes before a cursor there: that is
		// where the server adds frontmatter to a note that had none, and the
		// next keystroke belongs in the body, not in front of the `---`.
		if (edits.some((edit) => edit.pos === 0 && edit.ins !== '')) {
			spec.selection = keepAfterStart(state.selection, changes);
		}
		this.view.dispatch(spec);
	}
}

/** Maps a selection through changes, moving ends at the start past text inserted there. */
function keepAfterStart(selection: EditorSelection, changes: ChangeSet): EditorSelection {
	const map = (pos: number) => changes.mapPos(pos, pos === 0 ? 1 : -1);
	return EditorSelection.create(
		selection.ranges.map((range) => EditorSelection.range(map(range.anchor), map(range.head))),
		selection.mainIndex,
	);
}

/**
 * Connects every markdown editor to the shared text of the note it shows,
 * so edits from other devices appear while typing.
 */
export function syncedEditors(sync: EditorSync): Extension {
	return ViewPlugin.define((view) => {
		const editor = new SyncedEditor(sync, view, () => filePath(view));
		return {
			update: (update) => editor.update(update.transactions),
			destroy: () => editor.destroy(),
		};
	});
}
