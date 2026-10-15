import type * as Y from 'yjs';
import type { NoteLink } from './engine';
import { diffText, type TextEdit } from './text';

/** One open editor, as the binding sees it. */
export interface EditorPort {
	text(): string;
	/** Applies edits made elsewhere, without undo history and without echoing them back. */
	applyRemote(edits: readonly TextEdit[]): void;
}

/** Finds the shared text of a synced note, or null when the file is not synced. */
export interface NoteLinker {
	link(path: string): Promise<NoteLink | null>;
}

/** Keeps one editor and one note's shared text equal while both change. */
class Binding {
	private readonly observer: (event: Y.YTextEvent, tr: Y.Transaction) => void;

	constructor(
		private readonly link: NoteLink,
		private readonly port: EditorPort,
	) {
		// The editor may show text from before remote changes arrived, or edits
		// made while the note was loading: merge it in, then show the result.
		link.adopt(port.text());
		const edits = diffText(port.text(), link.text.toJSON());
		if (edits.length > 0) {
			port.applyRemote(edits);
		}
		this.observer = (event, tr) => {
			if (tr.origin !== this) {
				port.applyRemote(deltaToEdits(event.delta));
			}
		};
		link.text.observe(this.observer);
	}

	/** Applies the editor's own edits, given in positions before the change. */
	typed(edits: readonly TextEdit[]): void {
		const text = this.link.text;
		const doc = text.doc;
		if (doc === null || edits.length === 0) {
			return;
		}
		doc.transact(() => {
			for (let i = edits.length - 1; i >= 0; i--) {
				const edit = edits[i] as TextEdit;
				if (edit.del > 0) {
					text.delete(edit.pos, edit.del);
				}
				if (edit.ins !== '') {
					text.insert(edit.pos, edit.ins);
				}
			}
		}, this);
	}

	release(): void {
		this.link.text.unobserve(this.observer);
		this.link.release();
	}
}

/** Converts a shared-text change into edits in positions before the change. */
export function deltaToEdits(delta: Y.YTextEvent['delta']): TextEdit[] {
	const edits: TextEdit[] = [];
	let pos = 0;
	for (const op of delta) {
		if (op.retain !== undefined) {
			pos += op.retain;
		} else if (op.insert !== undefined) {
			const ins = typeof op.insert === 'string' ? op.insert : '';
			const last = edits[edits.length - 1];
			if (last !== undefined && last.pos + last.del === pos && last.ins === '') {
				last.ins = ins;
			} else if (ins !== '') {
				edits.push({ pos, del: 0, ins });
			}
		} else if (op.delete !== undefined) {
			edits.push({ pos, del: op.delete, ins: '' });
			pos += op.delete;
		}
	}
	return edits;
}

/**
 * The editors open in the app. Each synced note is bound to at most one
 * editor; when the same note is open twice, the app itself keeps the other
 * editors in step, and one of them takes over if the bound one goes away.
 */
export class EditorSync {
	private linker: NoteLinker | null = null;
	private readonly handles = new Set<EditorHandle>();

	setLinker(linker: NoteLinker | null): void {
		this.linker = linker;
		for (const handle of this.handles) {
			handle.unbind();
		}
		this.refresh();
	}

	/** Binds every editor that is not bound yet, if its note is synced now. */
	refresh(): void {
		for (const handle of this.handles) {
			this.consider(handle);
		}
	}

	attach(port: EditorPort, path: string | null): EditorHandle {
		const handle = new EditorHandle(this, port, path);
		this.handles.add(handle);
		this.consider(handle);
		return handle;
	}

	/** @internal */
	detach(handle: EditorHandle): void {
		this.handles.delete(handle);
		this.released(handle.path);
	}

	/** @internal */
	released(path: string | null): void {
		if (path === null) {
			return;
		}
		for (const other of this.handles) {
			if (other.path === path) {
				this.consider(other);
			}
		}
	}

	/** @internal */
	consider(handle: EditorHandle): void {
		const linker = this.linker;
		const path = handle.path;
		if (linker === null || path === null || handle.engaged) {
			return;
		}
		for (const other of this.handles) {
			if (other !== handle && other.path === path && other.engaged) {
				return;
			}
		}
		handle.bind(linker);
	}

	get size(): number {
		return this.handles.size;
	}
}

export class EditorHandle {
	private binding: Binding | null = null;
	private attempt = 0;
	private linking = false;

	constructor(
		private readonly owner: EditorSync,
		private readonly port: EditorPort,
		public path: string | null,
	) {}

	/** True while bound or about to be. */
	get engaged(): boolean {
		return this.binding !== null || this.linking;
	}

	get bound(): boolean {
		return this.binding !== null;
	}

	/** The editor now shows another file (or the same file under a new name). */
	setPath(path: string | null): void {
		if (path === this.path) {
			return;
		}
		const old = this.path;
		this.unbind();
		this.path = path;
		this.owner.released(old);
		this.owner.consider(this);
	}

	/** The editor's own edits, in positions before the change. */
	typed(edits: readonly TextEdit[]): void {
		this.binding?.typed(edits);
	}

	detach(): void {
		this.unbind();
		this.owner.detach(this);
	}

	/** @internal */
	bind(linker: NoteLinker): void {
		const attempt = ++this.attempt;
		const path = this.path;
		if (path === null) {
			return;
		}
		this.linking = true;
		void linker.link(path).then(
			(link) => {
				if (attempt !== this.attempt) {
					link?.release();
					return;
				}
				this.linking = false;
				if (link !== null) {
					this.binding = new Binding(link, this.port);
				}
			},
			() => {
				if (attempt === this.attempt) {
					this.linking = false;
				}
			},
		);
	}

	/** @internal */
	unbind(): void {
		this.attempt++;
		this.linking = false;
		this.binding?.release();
		this.binding = null;
	}
}
