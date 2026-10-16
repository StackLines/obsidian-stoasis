import { describe, expect, it } from 'vitest';
import { folderNameFor, freeFolderName } from '../src/folder-name';
import { DownloadProgress, type DownloadState, type ProgressNotice } from '../src/progress';
import { describeStatus, explainStatus, type SyncSnapshot } from '../src/status';
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
		[{ ready: false, pending: 7, download: { listed: 10, present: 3 } }, 'Stoasis: downloading 3/10'],
		[{ connection: 'offline', pending: 7, download: { listed: 10, present: 3 } }, 'Stoasis: offline, 7 waiting'],
		[{ download: null }, 'Stoasis: synced'],
	])('shows %o as "%s"', (change, text) => {
		const snapshot = { ...base, ...change };
		expect(describeStatus(snapshot)).toBe(text);
		expect(explainStatus(snapshot).length).toBeGreaterThan(10);
	});

	it('explains how far a download has come, online and offline', () => {
		const download = { listed: 10, present: 3 };
		expect(explainStatus({ ...base, ready: false, download })).toBe(
			'Downloading your notes: 3 of 10 notes are on this device.',
		);
		expect(explainStatus({ ...base, connection: 'offline', download })).toBe(
			'The server cannot be reached. Changes made now are sent when it is back. ' +
				'3 of 10 notes are on this device so far.',
		);
	});
});

describe('download progress', () => {
	class FakeNotice implements ProgressNotice {
		hidden = false;
		constructor(public message: string) {}
		setMessage(message: string): this {
			this.message = message;
			return this;
		}
		hide(): void {
			this.hidden = true;
		}
	}

	function progress() {
		const shown: FakeNotice[] = [];
		const announced: string[] = [];
		const download = new DownloadProgress(
			(message) => {
				const notice = new FakeNotice(message);
				shown.push(notice);
				return notice;
			},
			(message) => announced.push(message),
		);
		return { download, shown, announced };
	}

	const state = (present: number, more: Partial<DownloadState> = {}): DownloadState => ({
		counts: { listed: 5, present },
		connection: 'online',
		ready: false,
		pending: 5 - present,
		refused: 0,
		...more,
	});

	it('shows one notice that follows the count, then closes it when every note is here', () => {
		const { download, shown, announced } = progress();
		download.update(state(0, { counts: { listed: 0, present: 0 } }));
		expect(shown).toEqual([]);
		download.update(state(0));
		download.update(state(2));
		download.update(state(2, { connection: 'offline' }));
		download.update(state(4));
		expect(shown).toHaveLength(1);
		expect(shown[0]?.message).toBe('Stoasis: downloading notes, 4 of 5.');
		expect(download.active).toBe(true);
		expect(download.showing).toBe(true);

		// All files are here, but the first pass has not finished yet.
		download.update(state(5));
		expect(shown[0]?.hidden).toBe(false);
		download.update(state(5, { ready: true }));
		expect(shown[0]?.hidden).toBe(true);
		expect(announced).toEqual(['Stoasis: your notes are on this device.']);
		expect(download.active).toBe(false);
		expect(download.showing).toBe(false);

		// Shown at most once per sync session.
		download.update(state(1, { counts: { listed: 6, present: 1 } }));
		expect(shown).toHaveLength(1);
	});

	it('says when the device is offline in the middle of a download', () => {
		const { download, shown } = progress();
		download.update(state(2, { connection: 'offline' }));
		expect(shown[0]?.message).toBe('Stoasis: offline. 2 of 5 notes are on this device so far.');
	});

	it('closes once nothing more can arrive', () => {
		const refused = progress();
		refused.download.update(state(3));
		refused.download.update(state(3, { ready: true, refused: 2, pending: 0 }));
		expect(refused.shown[0]?.hidden).toBe(true);

		const settled = progress();
		settled.download.update(state(3));
		settled.download.update(state(4, { ready: true, pending: 0 }));
		expect(settled.shown[0]?.hidden).toBe(true);
		expect(settled.announced).toHaveLength(1);

		const outdated = progress();
		outdated.download.update(state(3));
		outdated.download.update(state(3, { connection: 'outdated' }));
		expect(outdated.shown[0]?.hidden).toBe(true);
		expect(outdated.announced).toEqual([]);
	});

	it('says nothing when there was nothing to download', () => {
		const { download, shown, announced } = progress();
		download.update(state(5, { counts: { listed: 5, present: 5 }, ready: true, pending: 0 }));
		expect(shown).toEqual([]);
		expect(announced).toEqual([]);
		expect(download.active).toBe(false);
	});

	it('closes quietly when sync stops', () => {
		const { download, shown, announced } = progress();
		download.update(state(1));
		download.stop();
		expect(shown[0]?.hidden).toBe(true);
		expect(announced).toEqual([]);
		expect(download.active).toBe(false);
	});
});

describe('folder names', () => {
	it('names a folder after the space, without characters a path cannot hold', () => {
		expect(folderNameFor('Personal', 'Stoasis')).toBe('Personal');
		expect(folderNameFor('  Work: notes/2026 #a [b] ', 'Stoasis')).toBe('Work notes 2026 a b');
		expect(folderNameFor('.hidden.', 'Stoasis')).toBe('hidden');
		expect(folderNameFor('a\tb\nc', 'Stoasis')).toBe('a b c');
		expect(folderNameFor('x'.repeat(300), 'Stoasis')).toHaveLength(100);
		for (const empty of ['', '   ', '...', '/:*?']) {
			expect(folderNameFor(empty, 'Stoasis')).toBe('Stoasis');
		}
	});

	it('numbers the name until it is free', () => {
		const taken = new Set(['Personal', 'Personal 2']);
		expect(freeFolderName('Personal', (p) => !taken.has(p))).toBe('Personal 3');
		expect(freeFolderName('Work', (p) => !taken.has(p))).toBe('Work');
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
