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
	| { kind: 'same' | 'device' | 'server'; text: string }
	/** Unchanged lines left out between changes. */
	| { kind: 'skip'; count: number };

/** Unchanged lines shown around each change. */
const CONTEXT = 2;
/** Past this many changed lines the texts are shown one after the other. */
const MAX_EDITS = 4000;

/**
 * The lines of this device's copy and of the server's note, in order, with
 * long unchanged runs left out.
 */
export function diffLines(device: string, server: string): DiffLine[] {
	const a = device.split('\n');
	const b = server.split('\n');
	const hunks = diffSequences(a, b, MAX_EDITS) ?? [{ aStart: 0, aEnd: a.length, bStart: 0, bEnd: b.length }];
	const lines: DiffLine[] = [];
	let ai = 0;
	for (const hunk of hunks) {
		same(lines, a.slice(ai, hunk.aStart), lines.length === 0, false);
		for (const text of a.slice(hunk.aStart, hunk.aEnd)) {
			lines.push({ kind: 'device', text });
		}
		for (const text of b.slice(hunk.bStart, hunk.bEnd)) {
			lines.push({ kind: 'server', text });
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

/**
 * Puts the copy's text into the note and moves the copy to the trash. Sync
 * takes the note's new text as an edit made on this device.
 */
export async function keepThisDevice(vault: VaultAdapter, copy: string, original: string): Promise<void> {
	const text = await vault.read(copy);
	await vault.process(original, () => text);
	await vault.trash(copy);
}

/** Moves the copy to the trash, leaving the note as the server has it. */
export async function keepTheServer(vault: VaultAdapter, copy: string): Promise<void> {
	await vault.trash(copy);
}
