import { TFile, TFolder, type App } from 'obsidian';
import type { FolderProbe } from './folder-warnings';
import type { VaultAdapter } from './sync/engine';
import { parentFolders } from './sync/paths';

/** The engine's view of the vault, through the app's own file operations. */
export function obsidianVault(app: App): VaultAdapter {
	const { vault, fileManager } = app;

	function file(path: string): TFile {
		const found = vault.getAbstractFileByPath(path);
		if (!(found instanceof TFile)) {
			throw new Error(`Not a file: ${path}`);
		}
		return found;
	}

	async function ensureParents(path: string): Promise<void> {
		for (const folder of parentFolders(path)) {
			const existing = vault.getAbstractFileByPath(folder);
			if (existing === null) {
				await vault.createFolder(folder);
			} else if (!(existing instanceof TFolder)) {
				throw new Error(`Not a folder: ${folder}`);
			}
		}
	}

	return {
		listMarkdown: (folder) =>
			vault
				.getMarkdownFiles()
				.map((f) => f.path)
				.filter((path) => path.startsWith(`${folder}/`)),
		exists: (path) => vault.getAbstractFileByPath(path) instanceof TFile,
		read: (path) => vault.read(file(path)),
		create: async (path, text) => {
			await ensureParents(path);
			await vault.create(path, text);
		},
		process: async (path, update) => {
			await vault.process(file(path), update);
		},
		rename: async (from, to) => {
			await ensureParents(to);
			// A plain rename: links were already updated on the device that moved the note.
			await vault.rename(file(from), to);
		},
		trash: (path) => fileManager.trashFile(file(path)),
	};
}

/** What the folder warnings read, through the app's file system adapter. */
export function folderProbe(app: App): FolderProbe {
	// Both adapters have full paths; the mobile one only since 1.7.2.
	const adapter = app.vault.adapter as App['vault']['adapter'] & { getFullPath?: (path: string) => string };
	return {
		configDir: app.vault.configDir,
		fullPath: (path) => {
			try {
				return typeof adapter.getFullPath === 'function' ? adapter.getFullPath(path) : null;
			} catch {
				return null;
			}
		},
		exists: async (path) => {
			try {
				return await adapter.exists(path);
			} catch {
				return false;
			}
		},
		read: async (path) => {
			try {
				return await adapter.read(path);
			} catch {
				return null;
			}
		},
	};
}
