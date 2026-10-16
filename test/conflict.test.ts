import { describe, expect, it } from 'vitest';
import { conflictOriginal, diffLines, keepTheServer, keepThisDevice } from '../src/conflict';
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
			{ kind: 'device', text: 'mine' },
			{ kind: 'server', text: 'theirs' },
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
			'dx',
			'sb',
			'sc',
			'sd',
			'se',
			'dy',
		]);
	});

	it('says only how many lines are the same when nothing differs', () => {
		expect(diffLines('a\nb\nc', 'a\nb\nc')).toEqual([{ kind: 'skip', count: 3 }]);
		expect(diffLines('a', 'a')).toEqual([{ kind: 'same', text: 'a' }]);
	});

	it('shows text only on one side', () => {
		expect(diffLines('', 'new')).toEqual([
			{ kind: 'device', text: '' },
			{ kind: 'server', text: 'new' },
		]);
		expect(diffLines('a\nb', 'a')).toEqual([
			{ kind: 'same', text: 'a' },
			{ kind: 'device', text: 'b' },
		]);
	});

	it('shows two texts with too many differences one after the other', () => {
		const device = lines(3000).join('\n');
		const server = lines(3000, 5000).join('\n');
		const result = diffLines(device, server);
		expect(result.filter((l) => l.kind === 'device')).toHaveLength(3000);
		expect(result.filter((l) => l.kind === 'server')).toHaveLength(3000);
		expect(result[0]).toEqual({ kind: 'device', text: 'line 1' });
		expect(result[3000]).toEqual({ kind: 'server', text: 'line 5000' });
	});
});

describe('keeping one side', () => {
	const COPY = 'Notes/Ideas (conflict 2026-10-15).md';

	it("puts the copy's text into the note and trashes the copy", async () => {
		const vault = new FakeVault();
		vault.write('Notes/Ideas.md', 'server');
		vault.write(COPY, 'device');
		await keepThisDevice(vault, COPY, 'Notes/Ideas.md');
		expect(vault.files.get('Notes/Ideas.md')).toBe('device');
		expect(vault.trashed).toEqual([COPY]);
	});

	it('keeps the copy when the note could not be written', async () => {
		const vault = new FakeVault();
		vault.write('Notes/Ideas.md', 'server');
		vault.write(COPY, 'device');
		vault.failNext('process');
		await expect(keepThisDevice(vault, COPY, 'Notes/Ideas.md')).rejects.toThrow('disk write failed');
		expect(vault.files.get(COPY)).toBe('device');
		expect(vault.files.get('Notes/Ideas.md')).toBe('server');
	});

	it('trashes only the copy to keep the server', async () => {
		const vault = new FakeVault();
		vault.write('Notes/Ideas.md', 'server');
		vault.write(COPY, 'device');
		await keepTheServer(vault, COPY);
		expect(vault.files.get('Notes/Ideas.md')).toBe('server');
		expect(vault.trashed).toEqual([COPY]);
	});
});
