import * as Y from 'yjs';
import { INDEX_FIELD } from './docs';
import { isSyncablePath, isWithin } from './paths';

/** Name of the shared map in a space document that says what its paths are relative to. */
export const META_FIELD = 'meta';

/** Origin of the change that moves a space to a new root. */
export const REROOT = Symbol('stoasis-reroot');

/**
 * A space whose paths start at the vault root. `prefix` is the folder the
 * space was synced from before it was moved to the vault, empty when it
 * never was one. `epoch` counts the moves of the root.
 */
export interface RootMeta {
	root: 'vault';
	epoch: number;
	prefix: string;
}

/** The root marker of a space document, or null for a space synced from a folder. */
export function readRootMeta(doc: Y.Doc): RootMeta | null {
	const meta = doc.getMap<unknown>(META_FIELD);
	const epoch = meta.get('epoch');
	const prefix = meta.get('prefix');
	if (meta.get('root') !== 'vault' || typeof epoch !== 'number' || typeof prefix !== 'string') {
		return null;
	}
	return { root: 'vault', epoch, prefix };
}

/** Writes the marker of a space that starts at the vault root from the beginning. */
export function markVaultRooted(doc: Y.Doc, origin: unknown): void {
	if (readRootMeta(doc) !== null) {
		return;
	}
	doc.transact(() => writeMeta(doc, 1, ''), origin);
}

function writeMeta(doc: Y.Doc, epoch: number, prefix: string): void {
	const meta = doc.getMap<unknown>(META_FIELD);
	meta.set('root', 'vault');
	meta.set('epoch', epoch);
	meta.set('prefix', prefix);
}

/** The folder in a valid prefix form: no slashes at the ends, a safe path. */
export function isFolderPath(path: string): boolean {
	return isSyncablePath(`${path}/x.md`);
}

export type RerootPlan =
	| { ok: true; moves: Array<[string, string]> }
	| { ok: false; reason: 'prefix' | 'collision' | 'long' };

/**
 * Where every path of the index goes when the space starts one folder
 * higher: under `prefix`. Refuses a plan that would merge two notes into one
 * path, also when they differ only in case, or make a path too long to use.
 */
export function planReroot(paths: string[], prefix: string): RerootPlan {
	if (!isFolderPath(prefix)) {
		return { ok: false, reason: 'prefix' };
	}
	const moves: Array<[string, string]> = [];
	const taken = new Set<string>();
	for (const path of paths) {
		const to = `${prefix}/${path}`;
		// Keys this plugin does not sync are moved too, as they are.
		if (to.length > 1024) {
			return { ok: false, reason: 'long' };
		}
		if (taken.has(to.toLowerCase())) {
			return { ok: false, reason: 'collision' };
		}
		taken.add(to.toLowerCase());
		moves.push([path, to]);
	}
	return { ok: true, moves };
}

/**
 * Moves every note of the index under `prefix` and marks the space as
 * starting at the vault root, in one change: a note whose key disappears is
 * deleted by the server, so no state with only some of the keys moved may
 * ever be stored. Note ids stay, so history and links stay. Returns how many
 * notes moved, or null when the space was moved already or cannot be.
 */
export function rerootIndex(doc: Y.Doc, prefix: string): number | null {
	if (readRootMeta(doc) !== null) {
		return null;
	}
	const index = doc.getMap<unknown>(INDEX_FIELD);
	const plan = planReroot([...index.keys()], prefix);
	if (!plan.ok) {
		return null;
	}
	doc.transact(() => {
		for (const [from, to] of plan.moves) {
			index.set(to, index.get(from));
		}
		for (const [from] of plan.moves) {
			index.delete(from);
		}
		writeMeta(doc, 1, prefix);
	}, REROOT);
	return plan.moves.length;
}

/** What a device knew of a folder, as it is known from the vault root. */
export function translateKnown(known: Record<string, string>, prefix: string): Record<string, string> {
	return Object.fromEntries(Object.entries(known).map(([rel, id]) => [`${prefix}/${rel}`, id]));
}

/** Whether the vault folder `path` is the prefix, or lies inside or around it. */
export function overlapsPrefix(path: string, prefix: string): boolean {
	return isWithin(prefix, path) || isWithin(path, prefix);
}
