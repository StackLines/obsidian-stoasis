import type * as Y from 'yjs';
import type { NoteLink } from './engine';
import { diffText, type MergeBase, type TextEdit } from './text';

/** The note an editor was linked to when its file got a new name, and its state then. */
interface Snapshot {
	id: string;
	base: MergeBase;
}

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

	/**
	 * `claim` is the text the editor held when it last showed a file it was
	 * not linked for, or null when its text is known to be this file's.
	 * `loaded` is the file's text the app last loaded into it, when known.
	 * `since` is set when the editor was linked to this same note under its
	 * old name: the editor's text was the note's then.
	 */
	constructor(
		private readonly link: NoteLink,
		private readonly port: EditorPort,
		claim: string | null,
		loaded: string | null,
		since: MergeBase | null,
	) {
		// The editor may show text from before remote changes arrived, or edits
		// made while the note was loading: merge it in, then show the result.
		// Right after the editor switched files, its text can still be the
		// previous file's: merge it only if it started out as this note's.
		// Otherwise the note's text wins and replaces it. After a rename, only
		// what was typed since the editor let go of the old name is new.
		if (since !== null) {
			link.adopt(port.text(), null, since);
		} else if (claim === null || link.owns(claim)) {
			link.adopt(port.text(), loaded);
		}
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

	/** The note and its state now, which the editor's text matches. */
	snapshot(): Snapshot {
		return { id: this.link.id, base: this.link.snapshot() };
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

	/** Links the editors showing `path` again, to the note now synced there. */
	relink(path: string): void {
		for (const handle of this.handles) {
			if (handle.path === path) {
				handle.unbind();
			}
		}
		this.released(path);
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
		if (linker === null || path === null || handle.engaged || handle.held) {
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
	/**
	 * The editor's text when it last showed a new file or was loaded, until a
	 * note is linked: the note checks it is its own before merging the
	 * editor's text. Null once linked, while the text is known to be the
	 * file's.
	 */
	private claim: string | null;
	/** The text the app loaded into the editor while it showed `path`, until linked. */
	private loadedText: string | null = null;
	private holding = false;
	/**
	 * Set when the file the editor shows was renamed while linked, until the
	 * editor links again. Any other change of file or a load drops it.
	 */
	private renamed: Snapshot | null = null;

	constructor(
		private readonly owner: EditorSync,
		private readonly port: EditorPort,
		public path: string | null,
	) {
		this.claim = port.text();
	}

	/** True while bound or about to be. */
	get engaged(): boolean {
		return this.binding !== null || this.linking;
	}

	get bound(): boolean {
		return this.binding !== null;
	}

	/** Loaded while showing `path`, and not yet known to be that file's text. */
	get held(): boolean {
		return this.holding;
	}

	/**
	 * The editor now shows another file, or with `renamed` the same file under
	 * a new name. Only a rename keeps what the editor was linked to; still
	 * linking after an earlier rename, that snapshot still holds.
	 */
	setPath(path: string | null, renamed = false): void {
		if (path === this.path) {
			return;
		}
		const old = this.path;
		this.renamed = !renamed ? null : this.binding !== null ? this.binding.snapshot() : this.linking ? this.renamed : null;
		this.unbind();
		this.holding = false;
		this.path = path;
		// The text may still be the previous file's until the new one loads.
		this.claim = this.port.text();
		this.loadedText = null;
		this.owner.released(old);
		this.owner.consider(this);
	}

	/**
	 * The app replaced the editor's whole text, by loading a file rather than
	 * by typing. If the editor is about to show another file, that file was
	 * loaded, so the text goes to no note yet: the editor stays unlinked until
	 * its next update shows which file it belongs to. `text` is what was
	 * loaded.
	 */
	loaded(text: string): void {
		this.renamed = null;
		this.unbind();
		this.holding = true;
		this.loadedText = text;
	}

	/**
	 * The editor's next update still shows the same file: what was loaded is
	 * this file's text, so link again and merge it.
	 */
	resume(): void {
		if (this.holding) {
			this.holding = false;
			this.claim = null;
			this.owner.consider(this);
		}
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
				const renamed = this.renamed;
				this.renamed = null;
				if (link !== null) {
					const since = renamed !== null && renamed.id === link.id ? renamed.base : null;
					this.binding = new Binding(link, this.port, this.claim, this.loadedText, since);
					this.claim = null;
					this.loadedText = null;
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
