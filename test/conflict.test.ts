import { describe, expect, it } from 'vitest';
import { conflictOriginal, diffLines, keepSyncedNote, useConflictCopy, type Compared, type ConflictFiles } from '../src/conflict';
import { FakeVault } from './helpers/memory-source';

describe('conflictOriginal', () => {
	it('finds the note a conflict copy was kept next to', () => {
		expect(conflictOriginal('Notes/Ideas (conflict 2026-10-15).md')).toBe('Notes/Ideas.md');
		expect(conflictOriginal('Notes/Ideas (conflict 2026-10-15 2).md')).toBe('Notes/Ideas.md');
		expect(conflictOriginal('Ideas (conflict 2026-10-15) (conflict 2026-10-16).md')).toBe(
			'Ideas (conflict 2026-10-15).md',
		);
	});

	it('takes nothing else for a conflict copy', () => {
		for (const path of [
			'Notes/Ideas.md',
			'Notes/Ideas (moving).md',
			'Notes/Ideas (conflict).md',
			'Notes/Ideas (conflict 2026-10-15).txt',
			'Notes/Ideas (conflict 2026-10-15)x.md',
		]) {
			expect(conflictOriginal(path), path).toBeNull();
		}
	});
});

describe('diffLines', () => {
	const lines = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`);

	it('shows a changed line among the lines next to it, and leaves the rest out', () => {
		const device = [...lines(10), 'mine', ...lines(10, 11)].join('\n');
		const server = [...lines(10), 'theirs', ...lines(10, 11)].join('\n');
		expect(diffLines(device, server)).toEqual([
			{ kind: 'skip', count: 8 },
			{ kind: 'same', text: 'line 9' },
			{ kind: 'same', text: 'line 10' },
			{ kind: 'copy', text: 'mine' },
			{ kind: 'note', text: 'theirs' },
			{ kind: 'same', text: 'line 11' },
			{ kind: 'same', text: 'line 12' },
			{ kind: 'skip', count: 8 },
		]);
	});

	it('keeps short unchanged runs between changes whole', () => {
		const device = ['a', 'x', 'b', 'c', 'd', 'e', 'y'].join('\n');
		const server = ['a', 'b', 'c', 'd', 'e'].join('\n');
		expect(diffLines(device, server).map((l) => (l.kind === 'skip' ? `…${l.count}` : `${l.kind[0]}${l.text}`))).toEqual([
			'sa',
			'cx',
			'sb',
			'sc',
			'sd',
			'se',
			'cy',
		]);
	});

	it('says only how many lines are the same when nothing differs', () => {
		expect(diffLines('a\nb\nc', 'a\nb\nc')).toEqual([{ kind: 'skip', count: 3 }]);
		expect(diffLines('a', 'a')).toEqual([{ kind: 'same', text: 'a' }]);
	});

	it('shows text only on one side', () => {
		expect(diffLines('', 'new')).toEqual([
			{ kind: 'copy', text: '' },
			{ kind: 'note', text: 'new' },
		]);
		expect(diffLines('a\nb', 'a')).toEqual([
			{ kind: 'same', text: 'a' },
			{ kind: 'copy', text: 'b' },
		]);
	});

	it('shows two texts with too many differences one after the other', () => {
		const device = lines(3000).join('\n');
		const server = lines(3000, 5000).join('\n');
		const result = diffLines(device, server);
		expect(result.filter((l) => l.kind === 'copy')).toHaveLength(3000);
		expect(result.filter((l) => l.kind === 'note')).toHaveLength(3000);
		expect(result[0]).toEqual({ kind: 'copy', text: 'line 1' });
		expect(result[3000]).toEqual({ kind: 'note', text: 'line 5000' });
	});
});

describe('keeping one side', () => {
	const COPY = 'Notes/Ideas (conflict 2026-10-15).md';
	const NOTE = 'Notes/Ideas.md';

	function setUp() {
		const vault = new FakeVault();
		vault.write(NOTE, 'server');
		vault.write(COPY, 'device');
		const same = new Set([COPY, NOTE]);
		const files: ConflictFiles = { vault, current: (path) => vault.read(path), same: (path) => same.has(path) };
		const compared: Compared = { copy: COPY, original: NOTE, copyText: 'device', originalText: 'server' };
		return { vault, files, compared, same };
	}

	it("puts the copy's text into the note and trashes the copy", async () => {
		const { vault, files, compared } = setUp();
		expect(await useConflictCopy(files, compared)).toBe('kept');
		expect(vault.files.get(NOTE)).toBe('device');
		expect(vault.trashed).toEqual([COPY]);
	});

	it('keeps the copy when the note could not be written', async () => {
		const { vault, files, compared } = setUp();
		vault.failNext('process');
		await expect(useConflictCopy(files, compared)).rejects.toThrow('disk write failed');
		expect(vault.files.get(COPY)).toBe('device');
		expect(vault.files.get(NOTE)).toBe('server');
	});

	it('trashes only the copy to keep the synced note', async () => {
		const { vault, files, compared } = setUp();
		expect(await keepSyncedNote(files, compared)).toBe('kept');
		expect(vault.files.get(NOTE)).toBe('server');
		expect(vault.trashed).toEqual([COPY]);
	});

	it('changes nothing when either text differs from what was compared', async () => {
		for (const [path, text] of [
			[COPY, 'device, edited'],
			[NOTE, 'server, edited'],
		] as const) {
			const { vault, files, compared } = setUp();
			vault.write(path, text);
			expect(await useConflictCopy(files, compared)).toBe('changed');
			expect(await keepSyncedNote(files, compared)).toBe('changed');
			expect(vault.files.get(path)).toBe(text);
			expect(vault.trashed).toEqual([]);
		}
	});

	it('changes nothing when either file is gone or is another file now', async () => {
		for (const path of [COPY, NOTE]) {
			const replaced = setUp();
			replaced.same.delete(path);
			expect(await useConflictCopy(replaced.files, replaced.compared)).toBe('gone');
			expect(await keepSyncedNote(replaced.files, replaced.compared)).toBe('gone');
			expect(replaced.vault.files.get(NOTE)).toBe('server');
			expect(replaced.vault.trashed).toEqual([]);

			const deleted = setUp();
			deleted.vault.files.delete(path);
			expect(await useConflictCopy(deleted.files, deleted.compared)).toBe('gone');
			expect(await keepSyncedNote(deleted.files, deleted.compared)).toBe('gone');
			expect(deleted.vault.trashed).toEqual([]);
		}
	});

	it('leaves the note as it is when it is written while the copy is put in', async () => {
		const { vault, files, compared } = setUp();
		const process = vault.process.bind(vault);
		vault.process = async (path, update) => {
			vault.files.set(NOTE, 'server, just synced');
			await process(path, update);
		};
		expect(await useConflictCopy(files, compared)).toBe('changed');
		expect(vault.files.get(NOTE)).toBe('server, just synced');
		expect(vault.files.get(COPY)).toBe('device');
	});
});
