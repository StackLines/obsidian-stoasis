// A copy kept when this device's text could not be merged with the server's,
// such as "Ideas (conflict 2026-10-15).md" next to "Ideas.md": what differs
// between the two, and keeping one of them. src/conflict-modal.ts shows it.

import type { VaultAdapter } from './sync/engine';
import { diffSequences } from './sync/text';

const CONFLICT = / \(conflict \d{4}-\d{2}-\d{2}(?: \d+)?\)\.md$/;

/** The note a conflict copy was kept next to, or null when `path` is not a conflict copy. */
export function conflictOriginal(path: string): string | null {
	return CONFLICT.test(path) ? path.replace(CONFLICT, '.md') : null;
}

export type DiffLine =
	| { kind: 'same' | 'copy' | 'note'; text: string }
	/** Unchanged lines left out between changes. */
	| { kind: 'skip'; count: number };

/** Unchanged lines shown around each change. */
const CONTEXT = 2;
/** Past this many changed lines the texts are shown one after the other. */
const MAX_EDITS = 4000;

/**
 * The lines of the conflict copy and of the synced note, in order, with long
 * unchanged runs left out.
 */
export function diffLines(copy: string, note: string): DiffLine[] {
	const a = copy.split('\n');
	const b = note.split('\n');
	const hunks = diffSequences(a, b, MAX_EDITS) ?? [{ aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length }];
	const lines: DiffLine[] = [];
	let ai = 0;
	for (const hunk of hunks) {
		same(lines, a.slice(ai, hunk.aStart), lines.length === 0, false);
		for (const text of a.slice(hunk.aStart, hunk.aEnd)) {
			lines.push({ kind: 'copy', text });
		}
		for (const text of b.slice(hunk.bStart, hunk.bEnd)) {
			lines.push({ kind: 'note', text });
		}
		ai = hunk.aEnd;
	}
	same(lines, a.slice(ai), lines.length === 0, true);
	return lines;
}

/** Adds an unchanged run, keeping only the lines next to a change. */
function same(lines: DiffLine[], run: readonly string[], first: boolean, last: boolean): void {
	const head = first ? 0 : CONTEXT;
	const tail = last ? 0 : CONTEXT;
	if (run.length <= head + tail + 1) {
		for (const text of run) {
			lines.push({ kind: 'same', text });
		}
		return;
	}
	for (const text of run.slice(0, head)) {
		lines.push({ kind: 'same', text });
	}
	lines.push({ kind: 'skip', count: run.length - head - tail });
	for (const text of run.slice(run.length - tail)) {
		lines.push({ kind: 'same', text });
	}
}

/** The two files as the user compared them, and their texts then. */
export interface Compared {
	copy: string;
	original: string;
	copyText: string;
	originalText: string;
}

/** What the keep operations read and change. */
export interface ConflictFiles {
	vault: VaultAdapter;
	/** A file's text now: what an open editor shows, else what is on disk. */
	current(path: string): Promise<string>;
	/** Whether `path` still holds the same file, and the same synced note, as when compared. */
	same(path: string): boolean;
}

/**
 * What came of keeping one side: `kept`; `changed` when either text changed
 * since the comparison, so it must be shown again; `gone` when either file
 * was moved, deleted or replaced; `copy-changed` when the note got the copy's
 * text but the copy changed meanwhile, so it was not trashed. Only `kept`
 * trashed the copy.
 */
export type KeepResult = 'kept' | 'changed' | 'gone' | 'copy-changed';

/** Whether both files are still the ones compared, with the texts compared. */
async function unchanged(files: ConflictFiles, compared: Compared): Promise<'ok' | 'changed' | 'gone'> {
	const { vault } = files;
	for (const path of [compared.copy, compared.original]) {
		if (!vault.exists(path) || !files.same(path)) {
			return 'gone';
		}
	}
	const copyText = await files.current(compared.copy);
	const originalText = await files.current(compared.original);
	return copyText === compared.copyText && originalText === compared.originalText ? 'ok' : 'changed';
}

/**
 * Puts the copy's text, as compared, into the note, then moves the copy to
 * the trash once the note has it and the copy has not changed since. Sync
 * takes the note's new text as an edit made on this device.
 */
export async function useConflictCopy(files: ConflictFiles, compared: Compared): Promise<KeepResult> {
	const { vault } = files;
	const check = await unchanged(files, compared);
	if (check !== 'ok') {
		return check;
	}
	const disk = await vault.read(compared.original);
	let raced = false;
	await vault.process(compared.original, (text) => {
		if (text !== disk) {
			// Written meanwhile: leave it.
			raced = true;
			return text;
		}
		return compared.copyText;
	});
	if (raced) {
		return 'changed';
	}
	if (!vault.exists(compared.copy) || !files.same(compared.copy)) {
		return 'gone';
	}
	if ((await files.current(compared.copy)) !== compared.copyText) {
		return 'copy-changed';
	}
	if ((await vault.read(compared.original)) !== compared.copyText) {
		return 'changed';
	}
	await vault.trash(compared.copy);
	return 'kept';
}

/** Moves the copy to the trash, leaving the note as it is, if neither changed since the comparison. */
export async function keepSyncedNote(files: ConflictFiles, compared: Compared): Promise<KeepResult> {
	const check = await unchanged(files, compared);
	if (check !== 'ok') {
		return check;
	}
	await files.vault.trash(compared.copy);
	return 'kept';
}
