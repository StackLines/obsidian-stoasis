import { describe, expect, it } from 'vitest';
import { describeStatus, explainStatus, type SyncSnapshot } from '../src/status';
import { applyPropertyPatch, FakePropertySuggester, tagNow } from '../src/tagging';
import {
	conflictPath,
	fingerprint,
	isNoteId,
	isSyncablePath,
	newNoteId,
	parentFolders,
	toRelative,
	toVaultPath,
} from '../src/sync/paths';

describe('status bar', () => {
	const base: SyncSnapshot = { paired: true, configured: true, connection: 'online', pending: 0, refused: 0, ready: true };

	it.each<[Partial<SyncSnapshot>, string]>([
		[{ paired: false }, 'Stoasis: not paired'],
		[{ configured: false }, 'Stoasis: sync off'],
		[{ connection: null }, 'Stoasis: sync off'],
		[{ connection: 'connecting' }, 'Stoasis: connecting'],
		[{ ready: false }, 'Stoasis: syncing'],
		[{ pending: 2 }, 'Stoasis: syncing'],
		[{}, 'Stoasis: synced'],
		[{ connection: 'offline' }, 'Stoasis: offline'],
		[{ connection: 'offline', pending: 3 }, 'Stoasis: offline, 3 waiting'],
		[{ connection: 'outdated' }, 'Stoasis: update needed'],
		[{ connection: 'refused' }, 'Stoasis: access refused'],
		[{ refused: 1 }, 'Stoasis: synced, 1 refused'],
		[{ connection: 'offline', pending: 2, refused: 3 }, 'Stoasis: offline, 2 waiting, 3 refused'],
	])('shows %o as "%s"', (change, text) => {
		const snapshot = { ...base, ...change };
		expect(describeStatus(snapshot)).toBe(text);
		expect(explainStatus(snapshot).length).toBeGreaterThan(10);
	});
});

describe('tag now', () => {
	it('adds suggested tags to the ones already there', () => {
		const frontmatter: Record<string, unknown> = { tags: ['work'], title: 'Mine' };
		expect(applyPropertyPatch(frontmatter, { tags: ['work', 'plans'], title: 'Theirs', status: 'draft' })).toEqual([
			'tags',
			'status',
		]);
		expect(frontmatter).toEqual({ tags: ['work', 'plans'], title: 'Mine', status: 'draft' });
	});

	it('reads tags written as a string', () => {
		const frontmatter: Record<string, unknown> = { tags: '#a, b' };
		applyPropertyPatch(frontmatter, { tags: ['c'] });
		expect(frontmatter['tags']).toEqual(['a', 'b', 'c']);
	});

	it('suggests with the stand-in and writes through the frontmatter writer', async () => {
		const suggester = new FakePropertySuggester();
		const written: Record<string, unknown>[] = [];
		const changed = await tagNow('Note.md', 'Plans for #Garden and #2024 #home/repairs', suggester, (_path, update) => {
			const frontmatter: Record<string, unknown> = {};
			update(frontmatter);
			written.push(frontmatter);
			return Promise.resolve();
		});
		expect(changed).toEqual(['tags']);
		expect(written).toEqual([{ tags: ['garden', 'home/repairs'] }]);
		expect(suggester.requests).toHaveLength(1);
	});

	it('writes nothing when there is nothing to suggest', async () => {
		let writes = 0;
		const changed = await tagNow('Note.md', 'plain text', new FakePropertySuggester(), () => {
			writes++;
			return Promise.resolve();
		});
		expect(changed).toEqual([]);
		expect(writes).toBe(0);
	});
});

describe('paths', () => {
	it('accepts plain relative markdown paths only', () => {
		for (const ok of ['a.md', 'Folder/Note.MD', 'x y/ü/ñ.md']) {
			expect(isSyncablePath(ok)).toBe(true);
		}
		for (const bad of ['', '/a.md', 'a/../b.md', './a.md', 'a//b.md', 'a\\b.md', '.hidden/a.md', 'a.canvas', 'a\u0000.md', `${'x'.repeat(1030)}.md`]) {
			expect(isSyncablePath(bad)).toBe(false);
		}
	});

	it('maps between vault paths and paths in the space', () => {
		expect(toRelative('Synced', 'Synced/A/b.md')).toBe('A/b.md');
		expect(toRelative('Synced', 'SyncedOther/b.md')).toBeNull();
		expect(toRelative('Synced', 'Synced/pic.png')).toBeNull();
		expect(toVaultPath('Synced', 'A/b.md')).toBe('Synced/A/b.md');
		expect(parentFolders('a/b/c.md')).toEqual(['a', 'a/b']);
		expect(parentFolders('c.md')).toEqual([]);
	});

	it('finds a free name for a conflict copy', () => {
		const day = new Date('2026-10-15T23:59:00Z');
		expect(conflictPath('A/Note.md', day, () => false)).toBe('A/Note (conflict 2026-10-15).md');
		const taken = new Set(['A/Note (conflict 2026-10-15).md']);
		expect(conflictPath('A/Note.md', day, (p) => taken.has(p))).toBe('A/Note (conflict 2026-10-15 2).md');
	});

	it('makes note ids the index accepts', () => {
		const id = newNoteId();
		expect(isNoteId(id)).toBe(true);
		expect(isNoteId('note-1')).toBe(false);
		expect(isNoteId(42)).toBe(false);
	});

	it('fingerprints text', () => {
		expect(fingerprint('a')).toBe(fingerprint('a'));
		expect(fingerprint('a')).not.toBe(fingerprint('b'));
	});
});
