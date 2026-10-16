import * as Y from 'yjs';
import {
	INDEX_FIELD,
	NOTE_FIELD,
	noteDocName,
	spaceDocName,
	type DocSource,
	type OpenDoc,
} from './docs';
import {
	conflictPath,
	isNoteId,
	isSyncablePath,
	newNoteId,
	sparePath,
	toRelative,
	toVaultPath,
} from './paths';
import { captureBase, mergeOutsideEdit, replacesMost, setText, type MergeBase } from './text';

/** The few vault operations the engine needs, with vault-relative paths. */
export interface VaultAdapter {
	/** Markdown files anywhere under `folder`. */
	listMarkdown(folder: string): string[];
	exists(path: string): boolean;
	read(path: string): Promise<string>;
	/** Creates a file and any missing parent folders. */
	create(path: string, text: string): Promise<void>;
	/** Replaces a file's text from its current text, atomically. */
	process(path: string, update: (current: string) => string): Promise<void>;
	/** Moves a file, creating any missing parent folders. */
	rename(from: string, to: string): Promise<void>;
	/** Moves a file to the trash, where the user can still recover it. */
	trash(path: string): Promise<void>;
}

/** Added to the notice for a conflict copy: how to choose between it and the note. */
const COMPARE_HINT = ' Open the copy and run "Compare with the synced note" to keep one of them.';

/** What the engine remembers between sessions, per mapped folder. */
export interface EngineState {
	/** Notes as they were last seen on disk here: relative path → note id. */
	known: Record<string, string>;
	/** True once the space index has been synced from the server at least once. */
	seeded: boolean;
}

export function emptyEngineState(): EngineState {
	return { known: {}, seeded: false };
}

export function parseEngineState(value: unknown): EngineState {
	const state = emptyEngineState();
	if (typeof value !== 'object' || value === null) {
		return state;
	}
	const stored = value as Record<string, unknown>;
	const known = stored['known'];
	if (typeof known === 'object' && known !== null) {
		for (const [rel, id] of Object.entries(known as Record<string, unknown>)) {
			if (isSyncablePath(rel) && isNoteId(id)) {
				state.known[rel] = id;
			}
		}
	}
	state.seeded = stored['seeded'] === true;
	return state;
}

export interface EngineOptions {
	vault: VaultAdapter;
	source: DocSource;
	spaceId: string;
	/** Vault folder the space is mapped to, without a trailing slash. */
	folder: string;
	state: EngineState;
	saveState: (state: EngineState) => void;
	/** Delay before a remote change to a closed note is written to disk. */
	writeDelayMs?: number;
	now?: () => Date;
	/** Called when something went wrong that the user may want to know about. */
	onProblem?: (message: string) => void;
	/** Called when the set of synced files may have changed. */
	onTracked?: () => void;
	/**
	 * Called when the file at `path` now belongs to another note: editors
	 * linked to it must link again.
	 */
	onRelink?: (path: string) => void;
}

/** A link between an open editor and a note's shared text. */
export interface NoteLink {
	/** The note's id: the same for every link to it, under any name. */
	readonly id: string;
	readonly text: Y.Text;
	/**
	 * Merges the editor's text, which may predate remote changes, into the
	 * note. `loaded` is the file's text the app last loaded into the editor,
	 * when known: the merge starts from the state the file had then, so text
	 * that reached the file after the load is not taken as deleted. `since`,
	 * when given, is the state the editor last matched, from `snapshot`, and
	 * the merge starts there instead. Refuses, and reports it, when that would
	 * replace most of the note's text.
	 */
	adopt(editorText: string, loaded?: string | null, since?: MergeBase | null): void;
	/** The note's state now, to merge from later with `adopt`. */
	snapshot(): MergeBase;
	/**
	 * Whether `text` is this note's file as this device knows it: on disk
	 * when linked, as last synced, or as the note holds it now.
	 */
	owns(text: string): boolean;
	release(): void;
}

interface IndexEntry {
	id: string;
	kind: string;
}

interface Note {
	id: string;
	open: OpenDoc;
	text: Y.Text;
	/** State matching the text on disk, to merge disk edits against. */
	base: MergeBase | null;
	/** The few bases before it, newest first, for an editor loaded from an older file. */
	earlier: MergeBase[];
	/**
	 * Changed on this device since the server last confirmed the note while
	 * the space still listed it. Kept across restarts.
	 */
	dirty: boolean;
	editors: number;
	writeTimer: number | null;
	waiting: boolean;
	unobserve: () => void;
}

/** Transaction origin for changes the engine makes itself. */
const ENGINE = Symbol('stoasis-engine');
const BASE_KEY = 'base';
const DIRTY_KEY = 'dirty';
/** How many earlier bases a note keeps in memory. */
const EARLIER_BASES = 4;
/** Kept with the space document once it holds the server's index. */
const SEEDED_KEY = 'seeded';
/**
 * Notes loaded from this device's storage at a time when sync starts. Between
 * batches the folder is reconciled, so files appear while the rest load.
 */
const LOAD_BATCH = 25;

/**
 * Keeps one vault folder and one space in step: the space index decides which
 * note lives at which path, and each note's text follows its document.
 *
 * All work runs one task at a time. Handlers check the current state rather
 * than remembering what the engine did itself, so the vault events caused by
 * the engine's own writes are harmless no-ops; only the engine's own moves
 * are remembered, because a move cannot be told apart from the user's.
 * What the engine tracks on disk changes only after the file operation
 * succeeded.
 */
export class SyncEngine {
	private readonly vault: VaultAdapter;
	private readonly source: DocSource;
	private folder: string;
	private readonly state: EngineState;
	private readonly writeDelayMs: number;
	private readonly now: () => Date;
	private index: OpenDoc | null = null;
	private map: Y.Map<unknown> | null = null;
	private readonly notes = new Map<string, Note>();
	/** Moves the engine made, as "from\0to", until their vault events arrive. */
	private readonly ownMoves = new Set<string>();
	private queue: Promise<void> = Promise.resolve();
	private stopped = false;
	private started = false;
	/**
	 * While the first pass loads notes in batches: reconciling creates files
	 * only for notes loaded already, and leaves the others to a later pass.
	 */
	private loading = false;
	private readonly stopping: Promise<void>;
	private signalStop: () => void = () => undefined;
	private unobserveIndex: (() => void) | null = null;
	private unwatchSource: (() => void) | null = null;

	constructor(private readonly options: EngineOptions) {
		this.vault = options.vault;
		this.source = options.source;
		this.folder = options.folder;
		this.state = options.state;
		this.writeDelayMs = options.writeDelayMs ?? 500;
		this.now = options.now ?? (() => new Date());
		this.stopping = new Promise((resolve) => {
			this.signalStop = resolve;
		});
	}

	/** True once the first full pass over the folder has run. */
	get ready(): boolean {
		return this.started;
	}

	/** How many notes the space lists, and how many of them are files here. */
	progress(): { listed: number; present: number } {
		const listed = new Set(this.entries().map(([, entry]) => entry.id));
		let present = 0;
		for (const id of new Set(Object.values(this.state.known))) {
			if (listed.has(id)) {
				present++;
			}
		}
		return { listed: listed.size, present };
	}

	/**
	 * Loads the space and reconciles the folder with it. The first time, and
	 * whenever the space is missing from this device's cache, it waits for the
	 * server first. Settles early, without starting, when stopped meanwhile or
	 * when the server cannot be used.
	 */
	async start(): Promise<void> {
		const index = this.source.open(spaceDocName(this.options.spaceId));
		this.index = index;
		await Promise.race([index.store.loaded, this.stopping]);
		if (this.stopped) {
			return;
		}
		const cached = (await index.store.get(SEEDED_KEY)) === '1';
		if (!this.state.seeded || !cached) {
			// Without the server's index here, a file missing from it could be
			// mistaken for a note deleted elsewhere.
			await Promise.race([index.whenSynced(), this.stopping]);
			if (this.stopped || !index.synced) {
				return;
			}
		}
		const map = index.doc.getMap<unknown>(INDEX_FIELD);
		this.map = map;
		const onIndex = (_event: Y.YMapEvent<unknown>, tr: Y.Transaction) => {
			if (tr.origin !== ENGINE) {
				void this.enqueue(() => this.reconcile());
			}
		};
		map.observe(onIndex);
		this.unobserveIndex = () => map.unobserve(onIndex);
		this.unwatchSource = this.source.onChange(() => this.confirmNotes());

		// Load the notes in batches, each its own task, and reconcile after each,
		// so that on a device new to the space files appear while the rest load,
		// and notes that arrive meanwhile are written without waiting for all.
		// Reconciling early is safe: deletions still come only from what this
		// device knew, never from a file missing on disk, and a pass creates
		// files only for notes loaded already; the full pass below covers the rest.
		const ids = [
			...new Set([...this.entries().map(([, entry]) => entry.id), ...Object.values(this.state.known)]),
		];
		this.loading = true;
		for (let i = 0; i < ids.length; i += LOAD_BATCH) {
			const batch = ids.slice(i, i + LOAD_BATCH);
			await this.enqueue(async () => {
				// All settle before the task ends, so none still loads while another
				// runs. A failure here is not reported: the full pass below does the
				// same work again and reports what still fails.
				const loads = await Promise.allSettled(batch.map((id) => this.note(id)));
				for (const [n, load] of loads.entries()) {
					if (load.status === 'rejected') {
						// Not used half loaded: the full pass opens it again.
						await this.forget(batch[n] ?? '');
					}
				}
				await this.reconcile().catch(() => undefined);
			});
			if (this.stopped) {
				return;
			}
		}

		await this.enqueue(async () => {
			this.loading = false;
			// Opens notes listed while the batches ran, and any that failed to load.
			for (const id of new Set(this.entries().map(([, entry]) => entry.id))) {
				await this.note(id);
			}
			for (const id of Object.values(this.state.known)) {
				await this.note(id);
			}
			await this.reconcile();
			await this.scanDisk();
			this.state.seeded = true;
			this.save();
			await index.store.set(SEEDED_KEY, '1');
			this.started = true;
		});
	}

	/** Stops all work; settles once the task running now, if any, is done. */
	async stop(): Promise<void> {
		this.stopped = true;
		this.signalStop();
		this.unobserveIndex?.();
		this.unwatchSource?.();
		await this.queue;
		for (const note of this.notes.values()) {
			if (note.writeTimer !== null) {
				window.clearTimeout(note.writeTimer);
			}
			note.unobserve();
		}
		this.notes.clear();
	}

	/** Waits until all queued work is done (for tests). */
	idle(): Promise<void> {
		return this.queue;
	}

	// Vault events. Each is safe to receive for a change the engine made itself.

	fileCreated(path: string): void {
		const rel = this.relative(path);
		if (rel !== null) {
			void this.enqueue(() => this.diskCreated(rel));
		}
	}

	fileModified(path: string): void {
		const rel = this.relative(path);
		if (rel !== null) {
			void this.enqueue(() => this.diskModified(rel));
		}
	}

	fileDeleted(path: string): void {
		const rel = this.relative(path);
		if (rel !== null) {
			void this.enqueue(() => this.diskDeleted(rel));
		}
	}

	fileRenamed(path: string, oldPath: string): void {
		const from = this.relative(oldPath);
		const to = this.relative(path);
		if (from === null && to === null) {
			return;
		}
		const own = this.ownMoves.delete(`${oldPath}\0${path}`);
		void this.enqueue(async () => {
			if (own) {
				// The engine moved this file itself and already tracks it.
				if (to !== null) {
					await this.diskModified(to);
				}
			} else if (from === null && to !== null) {
				await this.diskCreated(to);
			} else if (from !== null && to === null) {
				await this.diskDeleted(from);
			} else if (from !== null && to !== null) {
				this.diskRenamed(from, to);
			}
		});
	}

	/**
	 * The mapped folder itself was renamed or moved. Call this when the event
	 * for the folder arrives; events for the files inside it then match up.
	 */
	folderMoved(folder: string): void {
		this.folder = folder;
	}

	/** Checks the folder against what the engine knows, as at startup. */
	rescan(): void {
		void this.enqueue(async () => {
			await this.scanDisk();
			await this.reconcile();
		});
	}

	/** Whether a vault file is one this engine syncs. */
	tracks(path: string): boolean {
		const rel = this.relative(path);
		return rel !== null && this.state.known[rel] !== undefined;
	}

	/**
	 * Links an open editor to the note at `path`, or returns null when the
	 * file is not synced. While linked, the editor writes the file and the
	 * engine leaves it alone.
	 */
	async link(path: string): Promise<NoteLink | null> {
		const rel = this.relative(path);
		const id = rel === null ? undefined : this.state.known[rel];
		if (id === undefined || this.stopped) {
			return null;
		}
		const note = await this.note(id);
		await note.open.store.loaded;
		let disk: string | null = null;
		try {
			disk = await this.vault.read(path);
		} catch {
			// Not readable now: the note's own copies still count.
		}
		note.editors++;
		let released = false;
		return {
			id: note.id,
			text: note.text,
			snapshot: () => captureBase(note.open.doc, NOTE_FIELD),
			adopt: (editorText, loaded, since) => {
				const current = note.text.toJSON();
				if (editorText === current) {
					return;
				}
				const base = since ?? this.baseFor(note, loaded);
				if (base === null && current !== '' && editorText !== '') {
					// Nothing on this device says how the two relate: show the
					// note's text, and keep the editor's as a note of its own.
					const at = this.relOf(note.id) ?? rel ?? 'Untitled.md';
					void this.enqueue(() => this.keepCopy(at, editorText));
					return;
				}
				if (replacesMost(current, this.mergedText(note, editorText, base))) {
					// Nobody typed this: an editor that still shows another
					// note's text must not replace this one. Show the note's.
					this.options.onProblem?.(
						`An editor's text was not merged into "${this.relOf(note.id) ?? rel ?? path}" because it would have replaced most of the note; the synced text was kept.`,
					);
					return;
				}
				if (base === note.base) {
					this.mergeDisk(note, editorText, false);
				} else if (base !== null) {
					mergeOutsideEdit(note.open.doc, NOTE_FIELD, base, editorText, ENGINE);
				}
			},
			owns: (text) => text === disk || text === note.base?.text || text === note.text.toJSON(),
			release: () => {
				if (!released) {
					released = true;
					note.editors--;
					if (note.editors === 0) {
						// Catch up on anything the editor did not save.
						this.scheduleWrite(note);
					}
				}
			},
		};
	}

	// Disk → document.

	private async diskCreated(rel: string): Promise<void> {
		if (!this.vault.exists(this.path(rel))) {
			return;
		}
		if (this.state.known[rel] !== undefined) {
			await this.diskModified(rel);
			return;
		}
		if (this.entry(rel) !== null) {
			// The server already has a note here; reconcile decides.
			await this.reconcile();
			return;
		}
		await this.addLocalNote(rel);
	}

	/**
	 * Makes the file at `rel` a new note and returns its id. The note holds
	 * `text` when given, which the file does not hold yet, or else the file's.
	 */
	private async addLocalNote(rel: string, text?: string): Promise<string> {
		const disk = await this.vault.read(this.path(rel));
		const id = newNoteId();
		// List the note, open it and fill it in one step, with no wait between:
		// - listed first, because the server lets a device open a new note only
		//   once its space lists it, and the source attaches notes only after the
		//   server confirmed the space;
		// - filled before anything else runs, because once listed, other devices
		//   may open and edit the note, and filling it later would replace their
		//   edits. A new id has nothing stored on this device to wait for.
		const map = this.requireMap();
		map.doc?.transact(() => map.set(rel, { id, kind: 'markdown' }), ENGINE);
		const note = this.openNote(id);
		note.open.doc.transact(() => setText(note.text, disk), ENGINE);
		this.setBase(note);
		if (text !== undefined && text !== disk) {
			note.open.doc.transact(() => setText(note.text, text), ENGINE);
		}
		this.state.known[rel] = id;
		this.save();
		await this.loadNote(note);
		return id;
	}

	/** Keeps `text` as a new note next to `rel`. */
	private async keepCopy(rel: string, text: string): Promise<void> {
		const spare = conflictPath(rel, this.now(), (p) => this.taken(p));
		await this.vault.create(this.path(spare), text);
		await this.addLocalNote(spare);
		this.options.onProblem?.(
			`"${rel}" differed from the server copy; your copy was kept as "${spare}".` + COMPARE_HINT,
		);
	}

	private async diskModified(rel: string): Promise<void> {
		const id = this.state.known[rel];
		if (id === undefined) {
			await this.diskCreated(rel);
			return;
		}
		const path = this.path(rel);
		if (!this.vault.exists(path)) {
			return;
		}
		const note = await this.note(id);
		const text = await this.vault.read(path);
		if (text === note.text.toJSON()) {
			if (note.base?.text !== text) {
				this.setBase(note);
			}
			return;
		}
		if (note.editors > 0) {
			// The open editor is the source of truth and saves on its own.
			return;
		}
		if (note.base === null) {
			// What this device last synced is unknown (its cache was lost, say):
			// compare with the server's copy instead of overwriting either.
			if (!this.isReady(note)) {
				this.whenReady(note);
				return;
			}
			await this.bindExisting(rel, note);
			return;
		}
		this.mergeDisk(note, text);
		if (note.text.toJSON() !== text) {
			this.scheduleWrite(note);
		}
	}

	/**
	 * Merges text edited outside the document into it, keeping concurrent
	 * remote edits. With `onDisk`, the text is what the file holds, and later
	 * disk edits merge against it.
	 */
	private mergeDisk(note: Note, text: string, onDisk = true): void {
		let base: MergeBase;
		if (note.base === null) {
			note.open.doc.transact(() => setText(note.text, text), ENGINE);
			base = captureBase(note.open.doc, NOTE_FIELD);
		} else {
			base = mergeOutsideEdit(note.open.doc, NOTE_FIELD, note.base, text, ENGINE);
		}
		if (onDisk) {
			this.keepBase(note, base);
		}
	}

	/**
	 * The base to merge an editor's text against: the one matching the file's
	 * text the editor loaded, else the current one.
	 */
	private baseFor(note: Note, loaded: string | null | undefined): MergeBase | null {
		if (loaded === null || loaded === undefined || note.base === null || note.base.text === loaded) {
			return note.base;
		}
		return note.earlier.find((base) => base.text === loaded) ?? note.base;
	}

	/** The text the note would hold after merging `text` as an outside edit. */
	private mergedText(note: Note, text: string, base = note.base): string {
		if (base === null || note.text.toJSON() === base.text) {
			return text;
		}
		const scratch = new Y.Doc();
		Y.applyUpdate(scratch, Y.encodeStateAsUpdate(note.open.doc));
		mergeOutsideEdit(scratch, NOTE_FIELD, base, text, ENGINE);
		const merged = scratch.getText(NOTE_FIELD).toJSON();
		scratch.destroy();
		return merged;
	}

	private async diskDeleted(rel: string): Promise<void> {
		const id = this.state.known[rel];
		// A stop can come while a task waits; a deletion seen after it may be
		// the synced folder going away, which must not reach other devices.
		if (this.stopped || id === undefined || this.vault.exists(this.path(rel))) {
			return;
		}
		const map = this.requireMap();
		if (this.entry(rel)?.id === id) {
			map.doc?.transact(() => map.delete(rel), ENGINE);
		}
		delete this.state.known[rel];
		this.save();
		await this.forget(id);
	}

	private diskRenamed(from: string, to: string): void {
		const id = this.state.known[from];
		if (id === undefined) {
			// Not a synced note before; if it is one now, it is new.
			void this.enqueue(() => this.diskCreated(to));
			return;
		}
		if (this.state.known[to] !== undefined) {
			// Already tracked there: the engine made this move itself.
			return;
		}
		const map = this.requireMap();
		const entry = this.entry(from);
		map.doc?.transact(() => {
			if (entry !== null && entry.id === id) {
				map.delete(from);
			}
			map.set(to, { id, kind: 'markdown' });
		}, ENGINE);
		delete this.state.known[from];
		this.state.known[to] = id;
		this.save();
	}

	// Document → disk.

	private scheduleWrite(note: Note): void {
		if (note.writeTimer !== null) {
			window.clearTimeout(note.writeTimer);
		}
		note.writeTimer = window.setTimeout(() => {
			note.writeTimer = null;
			void this.enqueue(() => this.writeNote(note));
		}, this.writeDelayMs);
	}

	private async writeNote(note: Note): Promise<void> {
		if (note.editors > 0 || this.notes.get(note.id) !== note) {
			return;
		}
		const rel = this.relOf(note.id);
		if (rel === null) {
			return;
		}
		const path = this.path(rel);
		if (!this.vault.exists(path)) {
			return;
		}
		if (note.base === null) {
			await this.diskModified(rel);
			return;
		}
		await this.writeFile(path, note);
	}

	/**
	 * Writes a note's text to its file, first merging disk edits not seen yet.
	 * The base is what was actually written, so a change arriving while the
	 * file is written is written later, not mistaken for a disk edit. With
	 * `expected`, writes only over that text and returns whether it did.
	 */
	private async writeFile(path: string, note: Note, expected?: string): Promise<boolean> {
		const written: { base?: MergeBase } = {};
		await this.vault.process(path, (current) => {
			if (expected !== undefined && current !== expected) {
				return current;
			}
			if (note.base !== null && current !== note.base.text && current !== note.text.toJSON()) {
				// Edited on disk since the last sync and not seen yet: merge first,
				// and remember that the note holds it, so that if the write fails,
				// the next merge starts from it rather than replay it.
				this.mergeDisk(note, current);
			}
			written.base = captureBase(note.open.doc, NOTE_FIELD);
			return written.base.text;
		});
		if (written.base === undefined) {
			return false;
		}
		this.keepBase(note, written.base);
		return true;
	}

	/** Creates the file for a note, tracking it once it exists. */
	private async createFile(rel: string, note: Note): Promise<void> {
		const base = captureBase(note.open.doc, NOTE_FIELD);
		await this.vault.create(this.path(rel), base.text);
		this.state.known[rel] = note.id;
		this.keepBase(note, base);
		this.save();
	}

	/** Moves a file the engine tracks; the vault event for it is then ignored. */
	private async moveFile(from: string, to: string): Promise<void> {
		const key = `${this.path(from)}\0${this.path(to)}`;
		this.ownMoves.add(key);
		try {
			await this.vault.rename(this.path(from), this.path(to));
		} catch (error) {
			this.ownMoves.delete(key);
			throw error;
		}
		const id = this.state.known[from];
		if (id !== undefined) {
			delete this.state.known[from];
			this.state.known[to] = id;
			this.save();
		}
	}

	/** Brings the folder in line with the space index. */
	private async reconcile(): Promise<void> {
		if (this.stopped) {
			return;
		}
		this.normalizeIndex();
		const map = this.requireMap();
		const indexed = new Map<string, string>();
		for (const [rel, entry] of this.entries()) {
			indexed.set(entry.id, rel);
		}
		const known = this.state.known;

		// Notes no longer in the space.
		for (const [rel, id] of Object.entries(known)) {
			if (indexed.has(id) || known[rel] !== id) {
				continue;
			}
			const path = this.path(rel);
			if (this.entry(rel) !== null) {
				// Another device put a different note at this path, typically
				// while both created it offline. Keep ours next to it.
				if (!this.vault.exists(path)) {
					delete known[rel];
					this.save();
					await this.forget(id);
					continue;
				}
				const spare = conflictPath(rel, this.now(), (p) => this.taken(p));
				await this.moveFile(rel, spare);
				map.doc?.transact(() => map.set(spare, { id, kind: 'markdown' }), ENGINE);
				indexed.set(id, spare);
				this.options.onProblem?.(
					`Another device also created "${rel}"; this device's copy is now "${spare}".` + COMPARE_HINT,
				);
				continue;
			}
			// Removed from the space: remove it here too, unless this device has
			// changes the other one cannot have seen.
			if (this.vault.exists(path)) {
				const note = await this.note(id);
				const text = await this.vault.read(path);
				const unseen =
					note.base === null || text !== note.base.text || note.dirty || note.editors > 0;
				if (unseen) {
					indexed.set(await this.keepDeleted(rel, note, text), rel);
					this.options.onProblem?.(
						`"${rel}" was deleted on another device, but had changes here that it had not seen; it was kept.`,
					);
					continue;
				}
				await this.vault.trash(path);
			}
			delete known[rel];
			this.save();
			await this.forget(id);
		}

		await this.applyMoves(indexed);

		const knownIds = new Set(Object.values(known));
		for (const [rel, entry] of this.entries()) {
			const id = entry.id;
			if (known[rel] !== undefined || knownIds.has(id)) {
				// Already here, or still taken by a note the passes above could not move.
				continue;
			}
			if (this.loading && !this.notes.has(id)) {
				// Not loaded yet: a later pass of the first start creates it.
				continue;
			}
			const note = await this.note(id);
			if (!this.isReady(note)) {
				this.whenReady(note);
				continue;
			}
			if (!this.vault.exists(this.path(rel))) {
				await this.createFile(rel, note);
			} else {
				await this.bindExisting(rel, note);
			}
			knownIds.add(id);
		}
		this.save();
	}

	/**
	 * Keeps a note another device deleted, with everything it holds here, as a
	 * new note at the same path: the server does not take a note back once its
	 * space stopped listing it. An editor linked to the old note links to the
	 * new one.
	 */
	private async keepDeleted(rel: string, note: Note, disk: string): Promise<string> {
		if (note.editors === 0 && note.base !== null && disk !== note.text.toJSON()) {
			// Disk edits not merged yet.
			this.mergeDisk(note, disk);
		}
		// An open editor is the source of truth, and the note holds what it
		// shows; otherwise the note holds the file and any changes not written.
		const text = note.editors === 0 && note.base === null ? disk : note.text.toJSON();
		const id = await this.addLocalNote(rel, text);
		this.options.onRelink?.(this.path(rel));
		await this.forget(note.id);
		const added = this.notes.get(id);
		if (added !== undefined && added.editors === 0 && text !== disk) {
			this.scheduleWrite(added);
		}
		return id;
	}

	/**
	 * Keeps one path per note. Devices that renamed a note at the same time
	 * each add their path; all of them keep the same one.
	 */
	private normalizeIndex(): void {
		const map = this.requireMap();
		const keep = new Map<string, string>();
		const drop: string[] = [];
		for (const [rel, entry] of this.entries()) {
			const kept = keep.get(entry.id);
			if (kept === undefined) {
				keep.set(entry.id, rel);
			} else if (rel < kept) {
				drop.push(kept);
				keep.set(entry.id, rel);
			} else {
				drop.push(rel);
			}
		}
		if (drop.length > 0) {
			map.doc?.transact(() => {
				for (const rel of drop) {
					map.delete(rel);
				}
			}, ENGINE);
		}
	}

	/** Moves tracked files to where the index puts their notes. */
	private async applyMoves(indexed: Map<string, string>): Promise<void> {
		const known = this.state.known;
		for (;;) {
			let progress = true;
			while (progress) {
				progress = false;
				for (const [rel, id] of Object.entries(known)) {
					const target = indexed.get(id);
					if (target === undefined || target === rel || known[rel] !== id) {
						continue;
					}
					if (!this.vault.exists(this.path(rel))) {
						// Gone from here; it is created where it belongs below.
						delete known[rel];
						this.save();
						progress = true;
						continue;
					}
					if (known[target] !== undefined) {
						// Another note still sits there and moves away first.
						continue;
					}
					if (this.vault.exists(this.path(target))) {
						// An untracked file is in the way: keep it as a note of its own.
						const spare = conflictPath(target, this.now(), (p) => this.taken(p));
						await this.moveFile(target, spare);
						indexed.set(await this.addLocalNote(spare), spare);
					}
					await this.moveFile(rel, target);
					progress = true;
				}
			}
			// What is left waits on notes that wait in turn. Where they wait on
			// each other in a circle, such as two notes that swapped paths, step
			// one of them aside, then go on.
			const stuck = Object.keys(known).find((rel) => this.movesInCircle(rel, indexed));
			if (stuck === undefined) {
				return;
			}
			await this.moveFile(stuck, sparePath(stuck, 'moving', (p) => this.taken(p)));
		}
	}

	/** Whether the note at `rel` waits for a chain of notes that waits for it. */
	private movesInCircle(rel: string, indexed: Map<string, string>): boolean {
		const known = this.state.known;
		const seen = new Set<string>();
		let current = rel;
		for (;;) {
			const id = known[current];
			const target = id === undefined ? undefined : indexed.get(id);
			if (target === undefined || target === current || known[target] === undefined) {
				return false;
			}
			if (target === rel) {
				return true;
			}
			if (seen.has(target)) {
				return false;
			}
			seen.add(target);
			current = target;
		}
	}

	/**
	 * A file sits where the index puts a note, and this device does not know
	 * how the two relate: a note it has not seen yet, or one whose last synced
	 * state was lost. Tracks the file as that note once both agree.
	 */
	private async bindExisting(rel: string, note: Note): Promise<void> {
		const path = this.path(rel);
		const disk = await this.vault.read(path);
		const remote = note.text.toJSON();
		if (disk === remote) {
			this.setBase(note);
		} else if (remote === '') {
			note.open.doc.transact(() => setText(note.text, disk), ENGINE);
			this.setBase(note);
		} else if (disk === '') {
			if (!(await this.writeFile(path, note, disk))) {
				// Typed into meanwhile; the event for that comes next.
				return;
			}
		} else {
			// Both have different text: keep the local file as its own note.
			const spare = conflictPath(rel, this.now(), (p) => this.taken(p));
			await this.moveFile(rel, spare);
			delete this.state.known[spare];
			await this.addLocalNote(spare);
			await this.createFile(rel, note);
			this.options.onProblem?.(
				`"${rel}" differed from the server copy; your copy was kept as "${spare}".` + COMPARE_HINT,
			);
			return;
		}
		this.state.known[rel] = note.id;
		this.save();
	}

	/** Picks up changes made to the folder while the plugin was not running. */
	private async scanDisk(): Promise<void> {
		if (this.stopped) {
			return;
		}
		const onDisk = new Set<string>();
		for (const path of this.vault.listMarkdown(this.folder)) {
			const rel = this.relative(path);
			if (rel !== null) {
				onDisk.add(rel);
			}
		}
		for (const rel of onDisk) {
			if (this.stopped) {
				return;
			}
			if (this.state.known[rel] !== undefined) {
				await this.diskModified(rel);
			} else if (this.entry(rel) === null) {
				await this.addLocalNote(rel);
			}
		}
		for (const rel of Object.keys(this.state.known)) {
			if (!onDisk.has(rel)) {
				await this.diskDeleted(rel);
			}
		}
	}

	// Notes.

	private async note(id: string): Promise<Note> {
		const existing = this.notes.get(id);
		if (existing !== undefined) {
			return existing;
		}
		const note = this.openNote(id);
		await this.loadNote(note);
		return note;
	}

	/** Opens a note's document and follows its changes; load it before use. */
	private openNote(id: string): Note {
		const open = this.source.open(noteDocName(id));
		const text = open.doc.getText(NOTE_FIELD);
		const note: Note = {
			id,
			open,
			text,
			base: null,
			earlier: [],
			dirty: false,
			editors: 0,
			writeTimer: null,
			waiting: false,
			unobserve: () => undefined,
		};
		const observer = (_event: Y.YTextEvent, { local, origin }: Y.Transaction) => {
			if (local || origin === ENGINE) {
				this.markDirty(note);
			}
			if (origin !== ENGINE && note.editors === 0 && !this.stopped) {
				this.scheduleWrite(note);
			}
		};
		text.observe(observer);
		note.unobserve = () => text.unobserve(observer);
		this.notes.set(id, note);
		return note;
	}

	/** Waits for what this device stored of a note, and reads its sync state. */
	private async loadNote(note: Note): Promise<void> {
		const open = note.open;
		await open.store.loaded;
		const stored = await open.store.get(BASE_KEY);
		if (stored instanceof Uint8Array) {
			const scratch = new Y.Doc();
			Y.applyUpdate(scratch, stored);
			note.base = { update: stored, text: scratch.getText(NOTE_FIELD).toJSON() };
			scratch.destroy();
		}
		if ((await open.store.get(DIRTY_KEY)) === '1') {
			note.dirty = true;
		}
	}

	private markDirty(note: Note): void {
		if (!note.dirty) {
			note.dirty = true;
			void note.open.store.set(DIRTY_KEY, '1');
		}
	}

	/** Clears `dirty` on notes the server has confirmed while the space lists them. */
	private confirmNotes(): void {
		if (this.stopped || this.index?.synced !== true) {
			return;
		}
		let listed: Set<string> | null = null;
		for (const note of this.notes.values()) {
			if (!note.dirty || !note.open.confirmed) {
				continue;
			}
			listed ??= new Set(this.entries().map(([, entry]) => entry.id));
			if (listed.has(note.id)) {
				note.dirty = false;
				void note.open.store.set(DIRTY_KEY, '0');
			}
		}
	}

	private setBase(note: Note): void {
		this.keepBase(note, captureBase(note.open.doc, NOTE_FIELD));
	}

	private keepBase(note: Note, base: MergeBase): void {
		if (note.base !== null && note.base.text !== base.text) {
			note.earlier = [note.base, ...note.earlier.filter((b) => b.text !== base.text)].slice(0, EARLIER_BASES);
		}
		note.base = base;
		void note.open.store.set(BASE_KEY, base.update);
	}

	/** Whether a note's text can be trusted: synced, or known on this device. */
	private isReady(note: Note): boolean {
		return note.open.synced || note.base !== null || note.text.length > 0;
	}

	/** Reconciles again once the server's copy of the note arrives. */
	private whenReady(note: Note): void {
		if (note.waiting) {
			return;
		}
		note.waiting = true;
		void note.open.whenSynced().then(() => {
			note.waiting = false;
			// Refused, or the source stopped: nothing will arrive.
			if (note.open.synced && !this.stopped) {
				void this.enqueue(async () => {
					await this.reconcile();
					const rel = this.relOf(note.id);
					if (rel !== null) {
						await this.diskModified(rel);
					}
				});
			}
		});
	}

	private async forget(id: string): Promise<void> {
		const note = this.notes.get(id);
		if (note === undefined || note.editors > 0) {
			return;
		}
		if (note.writeTimer !== null) {
			window.clearTimeout(note.writeTimer);
		}
		note.unobserve();
		this.notes.delete(id);
		await this.source.close(noteDocName(id));
	}

	// Helpers.

	private enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.queue.then(async () => {
			if (this.stopped) {
				return;
			}
			try {
				await task();
			} catch (error) {
				this.options.onProblem?.(
					`Sync step failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
		this.queue = run;
		return run;
	}

	private requireMap(): Y.Map<unknown> {
		if (this.map === null) {
			throw new Error('Space index is not loaded');
		}
		return this.map;
	}

	private entries(): Array<[string, IndexEntry]> {
		const map = this.map;
		if (map === null) {
			return [];
		}
		const result: Array<[string, IndexEntry]> = [];
		map.forEach((value, rel) => {
			const entry = readEntry(value);
			if (entry !== null && entry.kind === 'markdown' && isSyncablePath(rel)) {
				result.push([rel, entry]);
			}
		});
		return result;
	}

	private entry(rel: string): IndexEntry | null {
		const entry = readEntry(this.map?.get(rel));
		return entry !== null && entry.kind === 'markdown' ? entry : null;
	}

	private relOf(id: string): string | null {
		for (const [rel, known] of Object.entries(this.state.known)) {
			if (known === id) {
				return rel;
			}
		}
		return null;
	}

	private taken(rel: string): boolean {
		return (
			this.vault.exists(this.path(rel)) ||
			this.state.known[rel] !== undefined ||
			this.map?.has(rel) === true
		);
	}

	private relative(path: string): string | null {
		return toRelative(this.folder, path);
	}

	private path(rel: string): string {
		return toVaultPath(this.folder, rel);
	}

	private save(): void {
		this.options.saveState(this.state);
		this.options.onTracked?.();
	}
}

function readEntry(value: unknown): IndexEntry | null {
	if (typeof value !== 'object' || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const id = record['id'];
	const kind = record['kind'];
	if (!isNoteId(id) || typeof kind !== 'string') {
		return null;
	}
	return { id, kind };
}
