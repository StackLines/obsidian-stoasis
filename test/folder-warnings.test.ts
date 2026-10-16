import { describe, expect, it } from 'vitest';
import {
	attachmentsOutside,
	checkFolder,
	corePluginOn,
	describeRisk,
	inDropbox,
	inICloud,
	type FolderProbe,
} from '../src/folder-warnings';
import { parseSettings } from '../src/settings';

/** A vault at `base` with these hidden and listed paths. */
function probe(base: string | null, files: Record<string, string> = {}, folders: string[] = []): FolderProbe {
	return {
		configDir: '.obsidian',
		fullPath: (path) => (base === null ? null : `${base}/${path}`),
		exists: (path) => Promise.resolve(path in files || folders.includes(path)),
		read: (path) => Promise.resolve(files[path] ?? null),
	};
}

const INSIDE = { '.obsidian/app.json': '{"attachmentFolderPath":"./"}' };

describe('folder warnings', () => {
	it('finds iCloud Drive on a Mac and on iOS', () => {
		expect(inICloud('/Users/me/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault/Notes')).toBe(true);
		expect(inICloud('/Users/me/Library/Mobile Documents/com~apple~CloudDocs/Vault/Notes')).toBe(true);
		expect(inICloud('/private/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault')).toBe(true);
		expect(inICloud('C:\\Users\\me\\iCloudDrive\\Vault\\Notes')).toBe(true);
		expect(inICloud('/Users/me/Documents/Vault/Notes')).toBe(false);
		expect(inICloud('/Users/me/Documents/Mobile Documents archive/Notes')).toBe(false);
	});

	it('finds Dropbox, team folders too', () => {
		expect(inDropbox('/Users/me/Dropbox/Vault/Notes')).toBe(true);
		expect(inDropbox('/Users/me/Library/CloudStorage/Dropbox/Vault/Notes')).toBe(true);
		expect(inDropbox('C:\\Users\\me\\Dropbox (Team)\\Vault\\Notes')).toBe(true);
		expect(inDropbox('/Users/me/Documents/Vault/Dropbox notes')).toBe(false);
	});

	it('reads whether Obsidian Sync is on, in both formats of core-plugins.json', () => {
		expect(corePluginOn('{"sync":true,"file-explorer":true}', 'sync')).toBe(true);
		expect(corePluginOn('{"sync":false}', 'sync')).toBe(false);
		expect(corePluginOn('["file-explorer","sync"]', 'sync')).toBe(true);
		expect(corePluginOn('["file-explorer"]', 'sync')).toBe(false);
		expect(corePluginOn(null, 'sync')).toBe(false);
		expect(corePluginOn('not json', 'sync')).toBe(false);
	});

	it("reads where new attachments go from Obsidian's setting", () => {
		// Not set: the vault root.
		expect(attachmentsOutside(null, 'Notes')).toBe('/');
		expect(attachmentsOutside('{}', 'Notes')).toBe('/');
		expect(attachmentsOutside('{"attachmentFolderPath":"/"}', 'Notes')).toBe('/');
		expect(attachmentsOutside('{"attachmentFolderPath":"Files"}', 'Notes')).toBe('Files');
		expect(attachmentsOutside('{"attachmentFolderPath":"Notes Files"}', 'Notes')).toBe('Notes Files');
		// Next to the note, or a folder inside: fine.
		expect(attachmentsOutside('{"attachmentFolderPath":"./"}', 'Notes')).toBeNull();
		expect(attachmentsOutside('{"attachmentFolderPath":"./assets"}', 'Notes')).toBeNull();
		expect(attachmentsOutside('{"attachmentFolderPath":"Notes"}', 'Notes')).toBeNull();
		expect(attachmentsOutside('{"attachmentFolderPath":"Notes/Files"}', 'Notes')).toBeNull();
		expect(attachmentsOutside('{"attachmentFolderPath":"Work/Files"}', 'Work/Notes')).toBe('Work/Files');
	});

	it('finds nothing for a plain folder with attachments next to the notes', async () => {
		expect(await checkFolder(probe('/home/me/Vault', INSIDE), 'Notes')).toEqual({ risks: [], attachments: null });
	});

	it('finds each thing that also syncs or changes the folder', async () => {
		const files = {
			'.obsidian/core-plugins.json': '{"sync":true}',
			'.obsidian/app.json': '{"attachmentFolderPath":"Files"}',
		};
		const check = await checkFolder(probe('/Users/me/Dropbox/Mobile Documents/Vault', files, ['.git']), 'Notes');
		expect(check).toEqual({ risks: ['icloud', 'dropbox', 'obsidian-sync', 'git', 'attachments'], attachments: 'Files' });
	});

	it('finds a git working tree at the vault root, in the folder or a folder around it, or by the git plugin', async () => {
		const git = async (folders: string[], files: Record<string, string> = {}) =>
			(await checkFolder(probe(null, { ...INSIDE, ...files }, folders), 'Work/Notes')).risks.includes('git');
		expect(await git(['.git'])).toBe(true);
		expect(await git(['Work/.git'])).toBe(true);
		expect(await git(['Work/Notes/.git'])).toBe(true);
		expect(await git(['Other/.git'])).toBe(false);
		expect(await git([], { '.obsidian/community-plugins.json': '["obsidian-git"]' })).toBe(true);
		expect(await git([], { '.obsidian/community-plugins.json': '["dataview"]' })).toBe(false);
	});

	it('reads a full path given as a file URL', async () => {
		const base = 'file:///private/var/mobile/Library/Mobile%20Documents/iCloud~md~obsidian/Documents/Vault';
		expect((await checkFolder(probe(base, INSIDE), 'Notes')).risks).toEqual(['icloud']);
	});

	it('skips the path checks where the app has no full paths', async () => {
		expect((await checkFolder(probe(null, INSIDE), 'Notes')).risks).toEqual([]);
	});

	it('says what to do about each', () => {
		expect(describeRisk('icloud', 'Notes', null)).toBe(
			'"Notes" is in iCloud Drive, which syncs it too. The two can undo each other\'s changes or make ' +
				'duplicates; keep the vault out of iCloud Drive to sync it with Stoasis.',
		);
		expect(describeRisk('attachments', 'Notes', 'Files')).toBe(
			'New attachments go to "Files", outside "Notes". Stoasis does not sync attachments yet; when it ' +
				'does, it will sync only those inside the folder. To keep them with the notes, set "Default ' +
				'location for new attachments" in Files and links to the folder or next to the note.',
		);
		for (const risk of ['dropbox', 'obsidian-sync', 'git'] as const) {
			expect(describeRisk(risk, 'Notes', null)).toContain('"Notes"');
		}
	});

	it('keeps which warnings were shown in the settings', () => {
		expect(parseSettings({ folderWarnings: ['Notes\nicloud', 3, 'Notes\nicloud', 'Notes\ngit'] }).folderWarnings).toEqual([
			'Notes\nicloud',
			'Notes\ngit',
		]);
		expect(parseSettings({}).folderWarnings).toEqual([]);
		expect(parseSettings({ folderWarnings: 'Notes' }).folderWarnings).toEqual([]);
	});
});
