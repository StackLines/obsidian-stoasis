import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, MarkdownView, Menu, TFile, notices, openedModals, type ContainerEl } from './stubs/obsidian';
import StoasisPlugin from '../src/main';
import type { ConflictModal } from '../src/conflict-modal';

const NOTE = 'Notes/Ideas.md';
const COPY = 'Notes/Ideas (conflict 2026-10-15).md';

type TestPlugin = StoasisPlugin & {
	commands: Array<{ id: string; editorCheckCallback?: (...args: unknown[]) => boolean | void }>;
};

const plugins: TestPlugin[] = [];

beforeEach(() => {
	notices.length = 0;
	openedModals.length = 0;
});

afterEach(() => {
	for (const plugin of plugins.splice(0)) {
		plugin.onunload();
	}
});

async function setUp() {
	const app = new App();
	app.vault.files.set(NOTE, '# Ideas\n\nFrom the server.\n');
	app.vault.files.set(COPY, '# Ideas\n\nFrom this device.\n');
	const plugin = new StoasisPlugin(app as never, { id: 'stoasis', version: '0.2.0' } as never) as TestPlugin;
	plugins.push(plugin);
	await plugin.onload();
	const command = plugin.commands.find((c) => c.id === 'compare-conflict-copy');
	const run = async (path: string): Promise<boolean | void> => {
		const info = { file: new TFile(path) };
		const available = command?.editorCheckCallback?.(true, {}, info);
		if (available === true) {
			command?.editorCheckCallback?.(false, {}, info);
			for (let i = 0; i < 10; i++) {
				await Promise.resolve();
			}
		}
		return available;
	};
	const modal = () => openedModals[openedModals.length - 1] as unknown as ConflictModal & { isOpen: boolean };
	return { app, plugin, run, modal };
}

/** The diff's lines as the modal drew them. */
function diffOf(modal: ConflictModal): string[] {
	const content = (modal as unknown as { contentEl: ContainerEl }).contentEl;
	const diff = content.items.find((i) => i.cls === 'stoasis-diff');
	return (diff?.children ?? []).map((i) => i.text ?? '');
}

/** The modal's buttons, in order. */
function buttons(modal: ConflictModal): string[] {
	const content = (modal as unknown as { contentEl: ContainerEl }).contentEl;
	return content.items.flatMap((i) => (i.controls ?? []).map((c) => c.label));
}

/** The modal's paragraphs as it drew them. */
function drawn(modal: ConflictModal): string[] {
	const content = (modal as unknown as { contentEl: ContainerEl }).contentEl;
	return content.items.map((i) => i.text ?? '');
}

describe('comparing a conflict copy with its note', () => {
	it('is offered only for a conflict copy whose note is next to it', async () => {
		const { app, run } = await setUp();
		expect(await run(NOTE)).toBe(false);
		app.vault.files.delete(NOTE);
		expect(await run(COPY)).toBe(false);
		expect(openedModals).toHaveLength(0);
	});

	it('shows what differs and uses the conflict copy', async () => {
		const { app, run, modal } = await setUp();
		expect(await run(COPY)).toBe(true);
		expect(drawn(modal())[0]).toContain(
			'"Ideas (conflict 2026-10-15).md" is the conflict copy, with the text this device had; "Ideas.md" is the current synced note.',
		);
		expect(diffOf(modal())).toEqual(['  # Ideas', '  ', '− From this device.', '+ From the server.', '  ']);
		expect(buttons(modal())).toEqual(['Cancel', 'Keep current synced note', 'Use conflict copy']);
		await modal().choose('copy');
		expect(app.vault.files.get(NOTE)).toBe('# Ideas\n\nFrom this device.\n');
		expect(app.vault.files.has(COPY)).toBe(false);
		expect(modal().isOpen).toBe(false);
		expect(notices).toEqual([
			'"Ideas.md" now has the text of "Ideas (conflict 2026-10-15).md", which is in the trash.',
		]);
	});

	it('keeps the current synced note', async () => {
		const { app, run, modal } = await setUp();
		await run(COPY);
		await modal().choose('note');
		expect(app.vault.files.get(NOTE)).toBe('# Ideas\n\nFrom the server.\n');
		expect(app.vault.files.has(COPY)).toBe(false);
		expect(notices).toEqual(['Kept "Ideas.md" as it is; "Ideas (conflict 2026-10-15).md" is in the trash.']);
	});

	it('uses the text of the open conflict copy, typing not yet saved included', async () => {
		const { app, run, modal } = await setUp();
		const open = new MarkdownView(app.vault.fileAt(COPY), '# Ideas\n\nFrom this device, and typed since.\n');
		app.workspace.leaves.push({ view: open });
		await run(COPY);
		expect(diffOf(modal())).toContain('− From this device, and typed since.');
		await modal().choose('copy');
		expect(app.vault.files.get(NOTE)).toBe('# Ideas\n\nFrom this device, and typed since.\n');
		expect(app.vault.files.has(COPY)).toBe(false);
	});

	it('shows the two again, and writes nothing, when the open copy changed after the comparison', async () => {
		const { app, run, modal } = await setUp();
		const open = new MarkdownView(app.vault.fileAt(COPY), '# Ideas\n\nFrom this device.\n');
		app.workspace.leaves.push({ view: open });
		await run(COPY);
		open.editor.setValue('# Ideas\n\nFrom this device, with more.\n');
		await modal().choose('copy');
		expect(app.vault.files.get(NOTE)).toBe('# Ideas\n\nFrom the server.\n');
		expect(app.vault.files.get(COPY)).toBe('# Ideas\n\nFrom this device.\n');
		expect(modal().isOpen).toBe(true);
		expect(drawn(modal())[0]).toContain('changed while this was open');
		expect(diffOf(modal())).toContain('− From this device, with more.');
		// Chosen again, it uses what is shown now.
		await modal().choose('copy');
		expect(app.vault.files.get(NOTE)).toBe('# Ideas\n\nFrom this device, with more.\n');
		expect(app.vault.files.has(COPY)).toBe(false);
	});

	it('shows the two again when the synced note changed after the comparison', async () => {
		const { app, run, modal } = await setUp();
		await run(COPY);
		app.vault.files.set(NOTE, '# Ideas\n\nFrom the server, edited on another device.\n');
		await modal().choose('note');
		expect(app.vault.files.has(COPY)).toBe(true);
		expect(modal().isOpen).toBe(true);
		expect(diffOf(modal())).toContain('+ From the server, edited on another device.');
	});

	it('keeps the copy when it is written while the note gets its text', async () => {
		const { app, run, modal } = await setUp();
		await run(COPY);
		const process = app.vault.process.bind(app.vault);
		app.vault.process = async (file, update) => {
			const next = await process(file, update);
			app.vault.files.set(COPY, '# Ideas\n\nFrom this device, saved meanwhile.\n');
			return next;
		};
		await modal().choose('copy');
		expect(app.vault.files.get(NOTE)).toBe('# Ideas\n\nFrom this device.\n');
		expect(app.vault.files.get(COPY)).toBe('# Ideas\n\nFrom this device, saved meanwhile.\n');
		expect(notices).toEqual([
			'"Ideas.md" now has the text of "Ideas (conflict 2026-10-15).md" as compared. ' +
				'"Ideas (conflict 2026-10-15).md" changed meanwhile, so it was kept.',
		]);
	});

	it('writes nothing over another note put where the synced note was', async () => {
		const { app, run, modal } = await setUp();
		await run(COPY);
		await app.vault.rename(app.vault.fileAt(NOTE), 'Notes/Renamed.md');
		await app.vault.create(NOTE, '# Ideas\n\nFrom the server.\n');
		for (const which of ['copy', 'note'] as const) {
			await modal().choose(which);
			expect(app.vault.files.get(NOTE)).toBe('# Ideas\n\nFrom the server.\n');
			expect(app.vault.files.get('Notes/Renamed.md')).toBe('# Ideas\n\nFrom the server.\n');
			expect(app.vault.files.get(COPY)).toBe('# Ideas\n\nFrom this device.\n');
		}
		expect(notices[0]).toBe(
			'"Ideas (conflict 2026-10-15).md" or "Ideas.md" was moved, deleted or replaced while this was open. ' +
				'Nothing was changed.',
		);
	});

	it('keeps the copy when the synced note was deleted after the comparison', async () => {
		const { app, run, modal } = await setUp();
		await run(COPY);
		await app.vault.delete(app.vault.fileAt(NOTE));
		await modal().choose('note');
		expect(app.vault.files.get(COPY)).toBe('# Ideas\n\nFrom this device.\n');
		expect(modal().isOpen).toBe(false);
		await run(COPY);
		expect(openedModals).toHaveLength(1);
	});

	it('is in the editor menu of a conflict copy', async () => {
		const { app } = await setUp();
		const menu = new Menu();
		app.workspace.trigger('editor-menu', menu, {}, { file: new TFile(COPY) });
		expect(menu.items.map((i) => i.title)).toEqual(['Tag this note now', 'Compare with the synced note']);
	});
});
