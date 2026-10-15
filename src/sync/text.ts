import * as Y from 'yjs';

/** One replacement in the coordinates of the original text. */
export interface TextEdit {
	/** Offset in UTF-16 code units, as Y.Text and the editor count. */
	pos: number;
	/** Number of code units removed at pos. */
	del: number;
	ins: string;
}

/** Upper bound on the edit distance tried before falling back to one replacement. */
const MAX_LINE_EDITS = 400;
const MAX_CHAR_EDITS = 400;
/** Changed regions longer than this are replaced whole rather than refined. */
const MAX_REFINE_LENGTH = 20_000;

/**
 * Computes a small list of edits that turns `a` into `b`: whole lines first,
 * then characters within each changed run of lines. Edits are sorted, do not
 * overlap, and never split a surrogate pair.
 */
export function diffText(a: string, b: string): TextEdit[] {
	let start = 0;
	const minLength = Math.min(a.length, b.length);
	while (start < minLength && a.charCodeAt(start) === b.charCodeAt(start)) {
		start++;
	}
	if (start > 0 && isHighSurrogate(a.charCodeAt(start - 1))) {
		start--;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
		endA--;
		endB--;
	}
	if (endA < a.length && isLowSurrogate(a.charCodeAt(endA))) {
		endA++;
		endB++;
	}
	if (start === endA && start === endB) {
		return [];
	}

	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	if (midA === '' || midB === '') {
		return [{ pos: start, del: midA.length, ins: midB }];
	}

	const linesA = splitLines(midA);
	const linesB = splitLines(midB);
	const hunks = diffSequences(linesA, linesB, MAX_LINE_EDITS);
	if (hunks === null) {
		return [{ pos: start, del: midA.length, ins: midB }];
	}

	const offsetsA = prefixLengths(linesA);
	const offsetsB = prefixLengths(linesB);
	const edits: TextEdit[] = [];
	for (const hunk of hunks) {
		const fromA = offsetsA[hunk.aStart] ?? 0;
		const toA = offsetsA[hunk.aEnd] ?? 0;
		const removed = midA.slice(fromA, toA);
		const inserted = midB.slice(offsetsB[hunk.bStart] ?? 0, offsetsB[hunk.bEnd] ?? 0);
		const base = start + fromA;
		if (removed === '' || inserted === '' || removed.length + inserted.length > MAX_REFINE_LENGTH) {
			edits.push({ pos: base, del: removed.length, ins: inserted });
			continue;
		}
		edits.push(...diffChars(removed, inserted, base));
	}
	return edits;
}

/** Share of a text that counts as most of it. */
const MOST = 0.9;

/**
 * Whether going from `before` to `after` removes most of a non-empty
 * `before`, counting whole lines.
 */
export function replacesMost(before: string, after: string): boolean {
	if (before === '' || before === after) {
		return false;
	}
	return removedLength(before, after) >= before.length * MOST;
}

/**
 * How much of `a` going to `b` removes, counting whole lines: lines `b`
 * still has are kept, wherever single characters happen to match. When the
 * texts differ too much to compare line by line, everything between their
 * common start and end counts as removed.
 */
function removedLength(a: string, b: string): number {
	let start = 0;
	const minLength = Math.min(a.length, b.length);
	while (start < minLength && a.charCodeAt(start) === b.charCodeAt(start)) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
		endA--;
		endB--;
	}
	const linesA = splitLines(a.slice(start, endA));
	const hunks = diffSequences(linesA, splitLines(b.slice(start, endB)), MAX_LINE_EDITS);
	if (hunks === null) {
		return endA - start;
	}
	let removed = 0;
	for (const hunk of hunks) {
		for (let i = hunk.aStart; i < hunk.aEnd; i++) {
			removed += linesA[i]?.length ?? 0;
		}
	}
	return removed;
}

/** Character-level edits between two short strings, by code point. */
function diffChars(a: string, b: string, base: number): TextEdit[] {
	const pointsA = Array.from(a);
	const pointsB = Array.from(b);
	const hunks = diffSequences(pointsA, pointsB, MAX_CHAR_EDITS);
	if (hunks === null) {
		return [{ pos: base, del: a.length, ins: b }];
	}
	const offsetsA = prefixLengths(pointsA);
	const offsetsB = prefixLengths(pointsB);
	return hunks.map((hunk) => {
		const fromA = offsetsA[hunk.aStart] ?? 0;
		const toA = offsetsA[hunk.aEnd] ?? 0;
		return {
			pos: base + fromA,
			del: toA - fromA,
			ins: b.slice(offsetsB[hunk.bStart] ?? 0, offsetsB[hunk.bEnd] ?? 0),
		};
	});
}

interface Hunk {
	aStart: number;
	aEnd: number;
	bStart: number;
	bEnd: number;
}

/**
 * Myers' shortest edit script between two sequences, grouped into changed
 * runs. Returns null when more than `maxEdits` insertions and deletions would
 * be needed, so callers can fall back to a single replacement.
 */
export function diffSequences(a: readonly string[], b: readonly string[], maxEdits: number): Hunk[] | null {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, maxEdits);
	const offset = max + 1;
	const v = new Int32Array(2 * max + 3);
	const trace: Int32Array[] = [];
	let found = false;

	for (let d = 0; d <= max && !found; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) {
				x = v[offset + k + 1] ?? 0;
			} else {
				x = (v[offset + k - 1] ?? 0) + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = true;
				break;
			}
		}
	}
	if (!found) {
		return null;
	}

	// Walk back from the end, recording each insertion and deletion.
	const moves: Array<{ kind: 'del' | 'ins'; x: number; y: number }> = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const vd = trace[d] as Int32Array;
		const k = x - y;
		const prevK =
			k === -d || (k !== d && (vd[offset + k - 1] ?? 0) < (vd[offset + k + 1] ?? 0))
				? k + 1
				: k - 1;
		const prevX = vd[offset + prevK] ?? 0;
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
		}
		if (d > 0) {
			moves.push(x === prevX ? { kind: 'ins', x: prevX, y: prevY } : { kind: 'del', x: prevX, y: prevY });
		}
		x = prevX;
		y = prevY;
	}
	moves.reverse();

	const hunks: Hunk[] = [];
	for (const move of moves) {
		const last = hunks[hunks.length - 1];
		const extends_ = last !== undefined && last.aEnd === move.x && last.bEnd === move.y;
		const hunk = extends_ ? last : { aStart: move.x, aEnd: move.x, bStart: move.y, bEnd: move.y };
		if (move.kind === 'del') {
			hunk.aEnd++;
		} else {
			hunk.bEnd++;
		}
		if (!extends_) {
			hunks.push(hunk);
		}
	}
	return hunks;
}

/** Applies sorted, non-overlapping edits to a Y.Text, last first. */
export function applyEdits(ytext: Y.Text, edits: readonly TextEdit[]): void {
	for (let i = edits.length - 1; i >= 0; i--) {
		const edit = edits[i] as TextEdit;
		if (edit.del > 0) {
			ytext.delete(edit.pos, edit.del);
		}
		if (edit.ins !== '') {
			ytext.insert(edit.pos, edit.ins);
		}
	}
}

/** Makes a Y.Text read `text`, touching only what differs. */
export function setText(ytext: Y.Text, text: string): void {
	applyEdits(ytext, diffText(ytext.toJSON(), text));
}

/** A document state and the text it held, to merge later edits against. */
export interface MergeBase {
	update: Uint8Array;
	text: string;
}

export function captureBase(doc: Y.Doc, field: string): MergeBase {
	return { update: Y.encodeStateAsUpdate(doc), text: doc.getText(field).toJSON() };
}

/**
 * Merges a text that was edited outside the document (on disk, say) into it.
 *
 * `base` is the document state the outside copy started from. The outside
 * edits are replayed against that state in a scratch document and then merged
 * into the live one as concurrent changes, so edits that reached the live
 * document in the meantime (from other devices) are kept: the outside copy
 * can only delete text it knew about.
 *
 * Returns a base for the edited text, to merge the next outside edit against.
 */
export function mergeOutsideEdit(
	doc: Y.Doc,
	field: string,
	base: MergeBase,
	edited: string,
	origin: unknown,
): MergeBase {
	const ytext = doc.getText(field);
	if (ytext.toJSON() === base.text) {
		doc.transact(() => setText(ytext, edited), origin);
		return captureBase(doc, field);
	}
	const scratch = new Y.Doc();
	Y.applyUpdate(scratch, base.update);
	const scratchText = scratch.getText(field);
	const before = Y.encodeStateVector(scratch);
	// The base text is what the scratch copy holds; diff from it, not from base.text,
	// in case the two ever disagree.
	setText(scratchText, edited);
	const changes = Y.encodeStateAsUpdate(scratch, before);
	const next = captureBase(scratch, field);
	scratch.destroy();
	Y.applyUpdate(doc, changes, origin);
	return next;
}

function splitLines(text: string): string[] {
	const lines = text.split('\n');
	return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line)).filter((line) => line !== '');
}

function prefixLengths(parts: readonly string[]): number[] {
	const offsets = [0];
	let total = 0;
	for (const part of parts) {
		total += part.length;
		offsets.push(total);
	}
	return offsets;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}
