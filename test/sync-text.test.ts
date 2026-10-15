import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
	applyEdits,
	captureBase,
	diffSequences,
	diffText,
	mergeOutsideEdit,
	setText,
	type TextEdit,
} from '../src/sync/text';

function apply(text: string, edits: TextEdit[]): string {
	let out = text;
	for (let i = edits.length - 1; i >= 0; i--) {
		const e = edits[i] as TextEdit;
		out = out.slice(0, e.pos) + e.ins + out.slice(e.pos + e.del);
	}
	return out;
}

function docWith(text: string): Y.Doc {
	const doc = new Y.Doc();
	doc.getText('content').insert(0, text);
	return doc;
}

function sync(a: Y.Doc, b: Y.Doc): void {
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe('diffText', () => {
	const pairs: Array<[string, string]> = [
		['', ''],
		['', 'new'],
		['old', ''],
		['same', 'same'],
		['hello world', 'hello brave world'],
		['a\nb\nc\n', 'a\nB\nc\nd\n'],
		['line one\nline two\nline three', 'line one\nline 2\nline three\nline four'],
		['abc', 'xyz'],
		['😀 smile', '😃 smile'],
		['x😀y', 'x😃y'],
		['---\ntags: [a]\n---\nBody', '---\ntags: [a, b]\n---\nBody text'],
	];

	for (const [a, b] of pairs) {
		it(`turns ${JSON.stringify(a)} into ${JSON.stringify(b)}`, () => {
			const edits = diffText(a, b);
			expect(apply(a, edits)).toBe(b);
			for (let i = 1; i < edits.length; i++) {
				const prev = edits[i - 1] as TextEdit;
				expect((edits[i] as TextEdit).pos).toBeGreaterThanOrEqual(prev.pos + prev.del);
			}
		});
	}

	it('returns no edits for equal texts', () => {
		expect(diffText('abc', 'abc')).toEqual([]);
	});

	it('keeps edits small and local', () => {
		const a = 'one\ntwo\nthree\nfour\nfive\n';
		const b = 'one\nTWO\nthree\nfour\nfive!\n';
		const edits = diffText(a, b);
		expect(edits.reduce((n, e) => n + e.del, 0)).toBeLessThanOrEqual(4);
	});

	it('never splits a surrogate pair', () => {
		for (const [a, b] of [
			['😀', '😃'],
			['a😀', 'a😃'],
			['😀b', '😃b'],
		] as const) {
			for (const edit of diffText(a, b)) {
				const removed = a.slice(edit.pos, edit.pos + edit.del);
				expect(Array.from(removed).join('')).toBe(removed);
				expect(removed).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
				expect(edit.ins).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
			}
		}
	});

	it('handles random edits', () => {
		let seed = 7;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed % n;
		};
		const alphabet = 'ab\n c';
		for (let round = 0; round < 200; round++) {
			let a = '';
			for (let i = rand(40); i > 0; i--) a += alphabet[rand(alphabet.length)];
			let b = a;
			for (let i = rand(5); i > 0; i--) {
				const at = rand(b.length + 1);
				b = b.slice(0, at) + alphabet[rand(alphabet.length)] + b.slice(at + rand(3));
			}
			expect(apply(a, diffText(a, b))).toBe(b);
		}
	});

	it('falls back to one replacement for very different long texts', () => {
		const a = Array.from({ length: 2000 }, (_, i) => `a${i}\n`).join('');
		const b = Array.from({ length: 2000 }, (_, i) => `b${i}\n`).join('');
		const edits = diffText(a, b);
		expect(edits).toHaveLength(1);
		expect(apply(a, edits)).toBe(b);
	});
});

describe('diffSequences', () => {
	it('gives up past the edit limit', () => {
		expect(diffSequences(['a', 'b', 'c'], ['x', 'y', 'z'], 2)).toBeNull();
		expect(diffSequences(['a'], ['a'], 0)).toEqual([]);
	});
});

describe('Y.Text helpers', () => {
	it('applies edits to a Y.Text', () => {
		const doc = docWith('hello world');
		applyEdits(doc.getText('content'), diffText('hello world', 'hello there world!'));
		expect(doc.getText('content').toJSON()).toBe('hello there world!');
	});

	it('sets text with minimal changes', () => {
		const doc = docWith('a\nb\nc');
		let deleted = 0;
		doc.getText('content').observe((event) => {
			for (const op of event.delta) deleted += op.delete ?? 0;
		});
		setText(doc.getText('content'), 'a\nB\nc');
		expect(doc.getText('content').toJSON()).toBe('a\nB\nc');
		expect(deleted).toBe(1);
	});
});

describe('mergeOutsideEdit', () => {
	it('applies the edit directly when nothing changed since the base', () => {
		const doc = docWith('one two three');
		const base = captureBase(doc, 'content');
		mergeOutsideEdit(doc, 'content', base, 'one 2 three', 'disk');
		expect(doc.getText('content').toJSON()).toBe('one 2 three');
	});

	it('keeps a concurrent remote edit when merging an outside edit', () => {
		const local = docWith('Title\n\nFirst paragraph.\n\nSecond paragraph.\n');
		const remote = new Y.Doc();
		sync(local, remote);
		const base = captureBase(local, 'content');

		// Another device edits the second paragraph and the change reaches us.
		const remoteText = remote.getText('content');
		const at = remoteText.toJSON().indexOf('Second');
		remoteText.insert(at, 'Remote: ');
		sync(remote, local);

		// Meanwhile a tool rewrote the first paragraph on disk, from the base.
		mergeOutsideEdit(
			local,
			'content',
			base,
			'Title\n\nFirst paragraph, edited on disk.\n\nSecond paragraph.\n',
			'disk',
		);

		expect(local.getText('content').toJSON()).toBe(
			'Title\n\nFirst paragraph, edited on disk.\n\nRemote: Second paragraph.\n',
		);
		sync(local, remote);
		expect(remote.getText('content').toJSON()).toBe(local.getText('content').toJSON());
	});

	it('keeps text inserted remotely inside a region the outside edit rewrote', () => {
		const local = docWith('alpha beta gamma');
		const remote = new Y.Doc();
		sync(local, remote);
		const base = captureBase(local, 'content');
		remote.getText('content').insert(6, 'REMOTE ');
		sync(remote, local);

		mergeOutsideEdit(local, 'content', base, 'alpha delta gamma', 'disk');

		const merged = local.getText('content').toJSON();
		expect(merged).toContain('REMOTE');
		expect(merged).toContain('delta');
		expect(merged).not.toContain('beta');
	});

	it('uses the given transaction origin', () => {
		const doc = docWith('x');
		const base = captureBase(doc, 'content');
		const origins: unknown[] = [];
		doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin));
		mergeOutsideEdit(doc, 'content', base, 'y', 'disk');
		expect(origins).toEqual(['disk']);
	});
});
