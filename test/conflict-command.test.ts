import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, Menu, TFile, notices, openedModals, type ContainerEl } from './stubs/obsidian';
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

	it('shows what differs and keeps this device', async () => {
		const { app, run, modal } = await setUp();
		expect(await run(COPY)).toBe(true);
		expect(drawn(modal())[0]).toContain('"Ideas (conflict 2026-10-15).md" has the text this device had');
		expect(diffOf(modal())).toEqual(['  # Ideas', '  ', '− From this device.', '+ From the server.', '  ']);
		await modal().choose('device');
		expect(app.vault.files.get(NOTE)).toBe('# Ideas\n\nFrom this device.\n');
		expect(app.vault.files.has(COPY)).toBe(false);
		expect(modal().isOpen).toBe(false);
		expect(notices).toEqual([`"Ideas.md" now has this device's text; the copy is in the trash.`]);
	});

	it('keeps the server', async () => {
		const { app, run, modal } = await setUp();
		await run(COPY);
		await modal().choose('server');
		expect(app.vault.files.get(NOTE)).toBe('# Ideas\n\nFrom the server.\n');
		expect(app.vault.files.has(COPY)).toBe(false);
	});

	it('is in the editor menu of a conflict copy', async () => {
		const { app } = await setUp();
		const menu = new Menu();
		app.workspace.trigger('editor-menu', menu, {}, { file: new TFile(COPY) });
		expect(menu.items.map((i) => i.title)).toEqual(['Tag this note now', 'Compare with the synced note']);
	});
});
