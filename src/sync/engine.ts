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
	toRelative,
	toVaultPath,
} from './paths';
import { captureBase, mergeOutsideEdit, setText, type MergeBase } from './text';

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
}

/** A link between an open editor and a note's shared text. */
export interface NoteLink {
	readonly text: Y.Text;
	/** Merges the editor's text, which may predate remote changes, into the note. */
	adopt(editorText: string): void;
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
	editors: number;
	writeTimer: number | null;
	waiting: boolean;
	unobserve: () => void;
}

/** Transaction origin for changes the engine makes itself. */
const ENGINE = Symbol('stoasis-engine');
const BASE_KEY = 'base';

/**
 * Keeps one vault folder and one space in step: the space index decides which
 * note lives at which path, and each note's text follows its document.
 *
 * All work runs one task at a time. Handlers check the current state rather
 * than remembering what the engine did itself, so the vault events caused by
 * the engine's own writes are harmless no-ops.
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
	private queue: Promise<void> = Promise.resolve();
	private stopped = false;
	private started = false;
	private unobserveIndex: (() => void) | null = null;

	constructor(private readonly options: EngineOptions) {
		this.vault = options.vault;
		this.source = options.source;
		this.folder = options.folder;
		this.state = options.state;
		this.writeDelayMs = options.writeDelayMs ?? 500;
		this.now = options.now ?? (() => new Date());
	}

	/** True once the first full pass over the folder has run. */
	get ready(): boolean {
		return this.started;
	}

	/** Loads the space, waiting for the server the first time only, then reconciles. */
	async start(): Promise<void> {
		const index = this.source.open(spaceDocName(this.options.spaceId));
		this.index = index;
		await index.store.loaded;
		if (!this.state.seeded) {
			await index.whenSynced();
		}
		if (this.stopped) {
			return;
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

		await this.enqueue(async () => {
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
			this.started = true;
		});
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.unobserveIndex?.();
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
		void this.enqueue(async () => {
			if (from === null && to !== null) {
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
		void this.enqueue(() => this.scanDisk());
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
		note.editors++;
		let released = false;
		return {
			text: note.text,
			adopt: (editorText) => {
				if (editorText !== note.text.toJSON()) {
					this.mergeDisk(note, editorText, false);
				}
			},
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

	private async addLocalNote(rel: string): Promise<void> {
		const text = await this.vault.read(this.path(rel));
		const id = newNoteId();
		const note = await this.note(id);
		note.open.doc.transact(() => setText(note.text, text), ENGINE);
		this.setBase(note);
		this.requireMap().doc?.transact(() => {
			this.requireMap().set(rel, { id, kind: 'markdown' });
		}, ENGINE);
		this.state.known[rel] = id;
		this.save();
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
		this.mergeDisk(note, text);
		if (note.text.toJSON() !== text) {
			this.scheduleWrite(note);
		} else {
			this.setBase(note);
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
		await this.vault.process(path, (current) => {
			if (current !== note.text.toJSON() && current !== note.base?.text) {
				// Edited on disk since the last sync and not seen yet: merge first.
				this.mergeDisk(note, current);
			}
			return note.text.toJSON();
		});
		this.setBase(note);
	}

	/** Brings the folder in line with the space index. */
	private async reconcile(): Promise<void> {
		if (this.stopped) {
			return;
		}
		const map = this.requireMap();
		const entries = this.entries();
		const indexed = new Map<string, string>();
		for (const [rel, entry] of entries) {
			indexed.set(entry.id, rel);
		}
		const known = this.state.known;

		// Notes no longer in the space.
		for (const [rel, id] of Object.entries(known)) {
			if (indexed.has(id)) {
				continue;
			}
			delete known[rel];
			if (this.entry(rel) !== null) {
				// Another device put a different note at this path, typically
				// while both created it offline. Keep ours next to it.
				const spare = conflictPath(rel, this.now(), (p) => this.taken(p));
				known[spare] = id;
				map.doc?.transact(() => map.set(spare, { id, kind: 'markdown' }), ENGINE);
				if (this.vault.exists(this.path(rel))) {
					await this.vault.rename(this.path(rel), this.path(spare));
				}
				this.options.onProblem?.(
					`Another device also created "${rel}"; this device's copy is now "${spare}".`,
				);
				continue;
			}
			// Removed from the space: remove it here too.
			const path = this.path(rel);
			if (this.vault.exists(path)) {
				const note = await this.note(id);
				const text = await this.vault.read(path);
				if (note.base !== null && text !== note.base.text) {
					// Changed here since the last sync: keep it as a new note.
					await this.forget(id);
					await this.addLocalNote(rel);
					continue;
				}
				await this.vault.trash(path);
			}
			await this.forget(id);
		}

		// Notes moved to another path.
		for (const [rel, id] of Object.entries(known)) {
			const target = indexed.get(id);
			if (target === undefined || target === rel) {
				continue;
			}
			delete known[rel];
			const from = this.path(rel);
			const to = this.path(target);
			if (!this.vault.exists(from)) {
				continue;
			}
			if (this.vault.exists(to) && known[target] === undefined) {
				// An untracked file is in the way: keep it as a note of its own.
				const spare = conflictPath(target, this.now(), (p) => this.taken(p));
				await this.vault.rename(to, this.path(spare));
				await this.addLocalNote(spare);
			}
			if (!this.vault.exists(to)) {
				known[target] = id;
				await this.vault.rename(from, to);
			}
		}

		for (const [rel, entry] of this.entries()) {
			const id = entry.id;
			const current = known[rel];
			if (current === id) {
				continue;
			}
			if (current !== undefined) {
				// Still taken by a note the passes above could not move.
				continue;
			}
			const note = await this.note(id);
			if (!this.isReady(note)) {
				this.whenReady(note);
				continue;
			}
			const path = this.path(rel);
			if (!this.vault.exists(path)) {
				known[rel] = id;
				await this.vault.create(path, note.text.toJSON());
				this.setBase(note);
				continue;
			}
			await this.bindExisting(rel, note);
		}
		this.save();
	}

	/** A file already sits where the index puts a note this device has not seen. */
	private async bindExisting(rel: string, note: Note): Promise<void> {
		const path = this.path(rel);
		const disk = await this.vault.read(path);
		const remote = note.text.toJSON();
		this.state.known[rel] = note.id;
		if (disk === remote) {
			this.setBase(note);
		} else if (remote === '') {
			note.open.doc.transact(() => setText(note.text, disk), ENGINE);
			this.setBase(note);
		} else if (disk === '') {
			await this.vault.process(path, () => note.text.toJSON());
			this.setBase(note);
		} else {
			// Both have different text: keep the local file as its own note.
			const spare = conflictPath(rel, this.now(), (p) => this.taken(p));
			delete this.state.known[rel];
			await this.vault.rename(path, this.path(spare));
			await this.addLocalNote(spare);
			this.state.known[rel] = note.id;
			await this.vault.create(path, note.text.toJSON());
			this.setBase(note);
			this.options.onProblem?.(
				`"${rel}" differed from the server copy; your copy was kept as "${spare}".`,
			);
		}
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
		const open = this.source.open(noteDocName(id));
		const text = open.doc.getText(NOTE_FIELD);
		const note: Note = {
			id,
			open,
			text,
			base: null,
			editors: 0,
			writeTimer: null,
			waiting: false,
			unobserve: () => undefined,
		};
		const observer = (_event: Y.YTextEvent, tr: Y.Transaction) => {
			if (tr.origin !== ENGINE && note.editors === 0 && !this.stopped) {
				this.scheduleWrite(note);
			}
		};
		text.observe(observer);
		note.unobserve = () => text.unobserve(observer);
		this.notes.set(id, note);
		await open.store.loaded;
		const stored = await open.store.get(BASE_KEY);
		if (stored instanceof Uint8Array) {
			const scratch = new Y.Doc();
			Y.applyUpdate(scratch, stored);
			note.base = { update: stored, text: scratch.getText(NOTE_FIELD).toJSON() };
			scratch.destroy();
		}
		return note;
	}

	private setBase(note: Note): void {
		this.keepBase(note, captureBase(note.open.doc, NOTE_FIELD));
	}

	private keepBase(note: Note, base: MergeBase): void {
		note.base = base;
		void note.open.store.set(BASE_KEY, base.update);
	}

	/** Whether a note's text can be trusted: synced, or known on this device. */
	private isReady(note: Note): boolean {
		return note.open.synced || note.base !== null || note.text.length > 0;
	}

	private whenReady(note: Note): void {
		if (note.waiting) {
			return;
		}
		note.waiting = true;
		void note.open.whenSynced().then(() => {
			note.waiting = false;
			if (!note.open.refused) {
				void this.enqueue(() => this.reconcile());
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
