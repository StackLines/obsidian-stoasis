import * as Y from 'yjs';

/** Transaction origin for moving this device's text after new frontmatter. */
export const FRONTMATTER_FIRST = Symbol('frontmatter first');

/**
 * Keeps frontmatter that arrives at the start of a note at its start.
 *
 * Your server adds frontmatter to a note that has none by inserting it at the
 * start. When this device typed at the start at the same time, both inserts
 * have the start as their place, and Yjs orders them by client id: the typed
 * text can come first, which turns the frontmatter into body text. This
 * finds that insert in a remote change by what it is, one insert anchored at
 * the start that is a whole frontmatter block, and moves the text this device
 * put before it to just after it, which is where it lands when the order is
 * the other way round. Only this device's own text is moved, so two devices
 * never both move the same text; another device's text is left to it.
 */
export function keepFrontmatterFirst(event: Y.YTextEvent, transaction: Y.Transaction): void {
	const text = event.target;
	const doc = text.doc;
	const { local } = transaction;
	if (doc === null || local) {
		return;
	}
	let block: Y.Item | null = null;
	for (let item = text._start; item !== null && block === null; item = item.right) {
		if (!item.deleted && event.adds(item) && isStartBlock(item)) {
			block = item;
		}
	}
	if (block === null) {
		return;
	}
	// After every observer has seen this change as it came: a change made in
	// an observer would alter what the observers after it are told.
	const found = block;
	doc.once('afterAllTransactions', () => moveOwnTextAfter(text, found));
}

/** Moves the text this device put before `block` to just after it. */
function moveOwnTextAfter(text: Y.Text, block: Y.Item): void {
	const doc = text.doc;
	if (doc === null || block.deleted) {
		return;
	}
	const own: Array<{ index: number; text: string }> = [];
	let index = 0;
	let item = text._start;
	for (; item !== null && item !== block; item = item.right) {
		if (item.deleted || !item.countable) {
			continue;
		}
		if (item.id.client === doc.clientID && item.content instanceof Y.ContentString) {
			const last = own[own.length - 1];
			if (last !== undefined && last.index + last.text.length === index) {
				last.text += item.content.str;
			} else {
				own.push({ index, text: item.content.str });
			}
		}
		index += item.length;
	}
	if (item !== block || own.length === 0) {
		return;
	}
	const moved = own.map((range) => range.text).join('');
	const after = index - moved.length + block.length;
	doc.transact(() => {
		for (let i = own.length - 1; i >= 0; i--) {
			const range = own[i]!;
			text.delete(range.index, range.text.length);
		}
		text.insert(after, moved);
	}, FRONTMATTER_FIRST);
}

/** One insert anchored at the start of the text that is a whole frontmatter block. */
function isStartBlock(item: Y.Item): boolean {
	return (
		item.origin === null &&
		item.content instanceof Y.ContentString &&
		/^---\r?\n[\s\S]*\r?\n---\r?\n$/.test(item.content.str)
	);
}
