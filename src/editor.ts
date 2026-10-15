import { Annotation, Transaction, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import type { EditorHandle, EditorSync } from './sync/binding';
import type { TextEdit } from './sync/text';

/** Marks editor changes that came from the shared text, so they are not sent back. */
const fromSync = Annotation.define<boolean>();

function filePath(view: EditorView): string | null {
	return view.state.field(editorInfoField, false)?.file?.path ?? null;
}

/**
 * Connects every markdown editor to the shared text of the note it shows,
 * so edits from other devices appear while typing.
 */
export function syncedEditors(sync: EditorSync): Extension {
	return ViewPlugin.fromClass(
		class {
			private readonly handle: EditorHandle;

			constructor(private readonly view: EditorView) {
				this.handle = sync.attach(
					{
						text: () => this.view.state.doc.toString(),
						applyRemote: (edits) => this.applyRemote(edits),
					},
					filePath(view),
				);
			}

			update(update: ViewUpdate): void {
				this.handle.setPath(filePath(update.view));
				if (!update.docChanged) {
					return;
				}
				for (const tr of update.transactions) {
					if (!tr.docChanged || tr.annotation(fromSync) === true) {
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
				this.view.dispatch({
					changes: edits.map((edit) => ({
						from: edit.pos,
						to: edit.pos + edit.del,
						insert: edit.ins,
					})),
					annotations: [fromSync.of(true), Transaction.addToHistory.of(false)],
				});
			}
		},
	);
}
