import type * as Y from 'yjs';

/** Name of the shared text in a note document: the whole markdown file. */
export const NOTE_FIELD = 'content';
/** Name of the shared map in a space document: path → note entry. */
export const INDEX_FIELD = 'index';

export function noteDocName(noteId: string): string {
	return `note:${noteId}`;
}

export function spaceDocName(spaceId: string): string {
	return `space:${spaceId}`;
}

/**
 * Local storage of one document on this device, so edits survive a restart
 * and can be made offline. Small values (such as the last state written to
 * disk) are kept next to the document.
 */
export interface LocalStore {
	/** Settles once stored updates have been applied to the document. */
	readonly loaded: Promise<void>;
	get(key: string): Promise<unknown>;
	set(key: string, value: Uint8Array | string): Promise<void>;
	destroy(): Promise<void>;
	/** Deletes everything stored for the document. */
	clear(): Promise<void>;
}

export type LocalStoreFactory = (name: string, doc: Y.Doc) => LocalStore;

/** How the connection to the server is doing, as shown to the user. */
export type ConnectionState =
	| 'connecting'
	| 'online'
	| 'offline'
	/** The server refused this device; it must be paired again. */
	| 'refused'
	/** The server needs a newer plugin. */
	| 'outdated';

export interface OpenDoc {
	readonly name: string;
	readonly doc: Y.Doc;
	readonly store: LocalStore;
	/** True once the server's copy has been merged in this session. */
	readonly synced: boolean;
	/** True when the server refused access to this document. */
	readonly refused: boolean;
	/** Resolves when the server's copy has been merged in this session. */
	whenSynced(): Promise<void>;
}

/**
 * Where documents come from. Documents opened here are loaded from the local
 * store and kept in sync with the server whenever it can be reached.
 */
export interface DocSource {
	readonly state: ConnectionState;
	/**
	 * Documents with local changes the server has not confirmed yet and, while
	 * not offline, documents not synced yet.
	 */
	readonly pending: number;
	/** Calls `listener` when the state or the pending count changes. */
	onChange(listener: () => void): () => void;
	open(name: string): OpenDoc;
	close(name: string): Promise<void>;
	destroy(): Promise<void>;
}
