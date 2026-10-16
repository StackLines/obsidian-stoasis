// A copy kept when this device's text could not be merged with the server's,
// such as "Ideas (conflict 2026-10-15).md" next to "Ideas.md": what differs
// between the two, and keeping one of them. src/conflict-modal.ts shows it.

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

/** The two files of a conflict: the copy, and the synced note it was kept next to. */
export type Side = 'copy' | 'original';

/** The texts of the two files as the user compared them. */
export interface Compared {
	copyText: string;
	originalText: string;
}

/**
 * The two files as they were when compared. Each operation acts on the
 * same file as then, wherever it is now, and never on another file put at
 * its path.
 */
export interface ConflictFiles {
	/** Whether the file is still at its path, the same file and the same synced note as when compared. */
	same(side: Side): boolean;
	/** What an open editor shows of the file now, unsaved typing included, or null when none has it open. */
	shown(side: Side): string | null;
	/** The file's saved text. */
	read(side: Side): Promise<string>;
	/** Changes the file: `update` gets its saved text, and nothing else writes it until `update` returns. */
	process(side: Side, update: (text: string) => string): Promise<void>;
	/** Moves the file to the trash. */
	trash(side: Side): Promise<void>;
}

/**
 * What came of keeping one side: `kept`; `changed` when either text changed
 * since the comparison, so it must be shown again; `gone` when either file
 * was moved, deleted or replaced; `copy-changed` when the note got the copy's
 * text but then the copy changed, or either file was moved, deleted or
 * replaced, so the copy was not trashed. Only `kept` trashed the copy.
 */
export type KeepResult = 'kept' | 'changed' | 'gone' | 'copy-changed';

const SIDES: readonly Side[] = ['copy', 'original'];

function textOf(compared: Compared, side: Side): string {
	return side === 'copy' ? compared.copyText : compared.originalText;
}

/**
 * Whether both files are still the ones compared, with the texts compared.
 * Checked again after every read, as anything can happen while one is
 * pending.
 */
async function unchanged(files: ConflictFiles, compared: Compared): Promise<'ok' | 'changed' | 'gone'> {
	const saved = new Map<Side, string>();
	for (const side of SIDES) {
		if (!SIDES.every((s) => files.same(s))) {
			return 'gone';
		}
		saved.set(side, await files.read(side));
	}
	if (!SIDES.every((s) => files.same(s))) {
		return 'gone';
	}
	return SIDES.every((side) => (files.shown(side) ?? saved.get(side)) === textOf(compared, side)) ? 'ok' : 'changed';
}

/**
 * Moves the copy to the trash if both files are still the ones compared and
 * the copy still has the text compared, saved first when an editor shows it
 * unsaved, so that the trash holds it. Nothing is awaited between the last
 * check and the move, so typing or sync since then cannot be lost with it.
 */
async function trashCopy(files: ConflictFiles, compared: Compared): Promise<'ok' | 'changed' | 'gone'> {
	const { copyText } = compared;
	for (let saved = false; ; ) {
		if (!SIDES.every((s) => files.same(s))) {
			return 'gone';
		}
		const disk = await files.read('copy');
		if (!SIDES.every((s) => files.same(s))) {
			return 'gone';
		}
		const shown = files.shown('copy');
		if ((shown ?? disk) !== copyText) {
			return 'changed';
		}
		if (disk === copyText) {
			await files.trash('copy');
			return 'ok';
		}
		if (saved) {
			return 'changed';
		}
		saved = true;
		let wrote = false;
		await files.process('copy', (text) => {
			if (text !== disk || !files.same('copy') || files.shown('copy') !== copyText) {
				return text;
			}
			wrote = true;
			return copyText;
		});
		if (!wrote) {
			return 'changed';
		}
	}
}

/**
 * Puts the copy's text, as compared, into the note, then moves the copy to
 * the trash once the note has it and the copy has not changed since. Sync
 * takes the note's new text as an edit made on this device.
 *
 * The note is written only if, as it is written, it is the file compared
 * and holds the text compared, saved and in any open editor. While an
 * editor has typing in it not saved yet, that cannot be told, so nothing is
 * written and the two are shown again.
 */
export async function useConflictCopy(files: ConflictFiles, compared: Compared): Promise<KeepResult> {
	const check = await unchanged(files, compared);
	if (check !== 'ok') {
		return check;
	}
	let result = null as KeepResult | null;
	await files.process('original', (text) => {
		if (!SIDES.every((s) => files.same(s))) {
			result = 'gone';
			return text;
		}
		const copy = files.shown('copy');
		if (
			text !== compared.originalText ||
			(files.shown('original') ?? text) !== compared.originalText ||
			(copy !== null && copy !== compared.copyText)
		) {
			// Written or typed in meanwhile: leave it.
			result = 'changed';
			return text;
		}
		return compared.copyText;
	});
	if (result !== null) {
		return result;
	}
	return (await trashCopy(files, compared)) === 'ok' ? 'kept' : 'copy-changed';
}

/** Moves the copy to the trash, leaving the note as it is, if neither changed since the comparison. */
export async function keepSyncedNote(files: ConflictFiles, compared: Compared): Promise<KeepResult> {
	const check = await unchanged(files, compared);
	if (check !== 'ok') {
		return check;
	}
	const trashed = await trashCopy(files, compared);
	return trashed === 'ok' ? 'kept' : trashed;
}
