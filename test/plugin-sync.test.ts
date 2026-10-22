import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import StoasisPlugin, { LARGE_FIRST_SYNC } from '../src/main';
import { FakeControlPlane } from './helpers/control-plane';
import { eventually, TestSyncServer } from './helpers/sync-server';
import {
	App,
	notices,
	openedModals,
	setRequestHandler,
	shownNotices,
	TFile,
	type ContainerEl,
} from './stubs/obsidian';

// The whole plugin, two devices, a real sync server: pairing, mapping a folder,
// syncing both ways, going offline and the version gate.

/** The ws client throws on an unhandled error event; browsers only report it. */
class TestSocket extends WebSocket {
	constructor(address: string) {
		super(address);
		this.on('error', () => undefined);
	}
}

type TestPlugin = StoasisPlugin & { statusItems: ContainerEl[]; app: App };

const globals = globalThis as Record<string, unknown>;
const savedSocket = globals['WebSocket'];

beforeAll(() => {
	globals['WebSocket'] = TestSocket;
});

afterAll(() => {
	globals['WebSocket'] = savedSocket;
});

let server: TestSyncServer;
let control: FakeControlPlane;
const plugins: TestPlugin[] = [];

beforeEach(async () => {
	notices.length = 0;
	shownNotices.length = 0;
	server = new TestSyncServer();
	await server.start();
	control = new FakeControlPlane(server.url.replace('ws://', 'http://'));
	control.codes.add('EFGH2345');
	control.codes.add('JKMN2345');
	setRequestHandler(control.handle);
});

afterEach(async () => {
	for (const plugin of plugins.splice(0)) {
		plugin.onunload();
	}
	await new Promise((resolve) => setTimeout(resolve, 50));
	setRequestHandler(null);
	await server.stop();
});

async function device(code: string, folder: string, files: Record<string, string> = {}): Promise<TestPlugin> {
	const app = new App();
	app.vault.folders.add(folder);
	for (const [path, text] of Object.entries(files)) {
		app.vault.files.set(path, text);
	}
	const plugin = new StoasisPlugin(app as never, { id: 'stoasis', version: '0.1.0' } as never) as TestPlugin;
	plugins.push(plugin);
	await plugin.onload();
	app.workspace.ready();
	expect(await plugin.pair(control.server, code, 'Test device')).toBe(true);
	await plugin.setFolder(folder, false);
	await plugin.setSyncEnabled(true);
	return plugin;
}

/** A device paired and mapped to the whole vault, the confirmation answered as given. */
async function vaultDevice(
	code: string,
	files: Record<string, string>,
	answer: 'confirm' | 'cancel' = 'confirm',
): Promise<{ plugin: TestPlugin; chosen: boolean; asked: string }> {
	const app = new App();
	for (const [path, text] of Object.entries(files)) {
		app.vault.files.set(path, text);
		for (let at = path.indexOf('/'); at > 0; at = path.indexOf('/', at + 1)) {
			app.vault.folders.add(path.slice(0, at));
		}
	}
	const plugin = new StoasisPlugin(app as never, { id: 'stoasis', version: '0.3.0' } as never) as TestPlugin;
	plugins.push(plugin);
	await plugin.onload();
	app.workspace.ready();
	expect(await plugin.pair(control.server, code, 'Test device')).toBe(true);
	openedModals.length = 0;
	const choosing = plugin.chooseWholeVault();
	await eventually(() => expect(openedModals.length).toBe(1));
	const modal = openedModals[0] as unknown as { contentEl: ContainerEl; onClose(): void };
	await eventually(() => expect(modal.contentEl.items.length).toBeGreaterThan(1));
	const asked = modal.contentEl.items.map((i) => i.text ?? '').join(' ');
	const buttons = modal.contentEl.items.flatMap((i) => i.controls ?? []);
	await (buttons.find((b) => b.label === (answer === 'confirm' ? 'Sync the whole vault' : 'Cancel')) ?? fail()).click();
	const chosen = await choosing;
	if (chosen) {
		await plugin.setSyncEnabled(true);
	}
	return { plugin, chosen, asked };
}

function fail(): never {
	throw new Error('control not found');
}

function status(plugin: TestPlugin): string {
	return plugin.statusItems[0]?.text ?? '';
}

describe('plugin sync', () => {
	it('syncs a folder between two devices, both ways', async () => {
		const a = await device('ABCD2345', 'Notes', { 'Notes/Hello.md': '# Hello\n', 'Other/Private.md': 'stays' });
		await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 8000);

		const b = await device('EFGH2345', 'Synced');
		await eventually(() => expect(b.app.vault.files.get('Synced/Hello.md')).toBe('# Hello\n'), 8000);
		expect([...b.app.vault.files.keys()]).toEqual(['Synced/Hello.md']);

		await b.app.vault.modify(new TFile('Synced/Hello.md'), '# Hello\n\nFrom B\n');
		await eventually(() => expect(a.app.vault.files.get('Notes/Hello.md')).toBe('# Hello\n\nFrom B\n'), 8000);

		await a.app.vault.create('Notes/Ideas/New.md', 'new idea');
		await eventually(() => expect(b.app.vault.files.get('Synced/Ideas/New.md')).toBe('new idea'), 8000);
		await eventually(() => expect(status(b)).toBe('Stoasis: synced'), 8000);
	}, 30_000);

	it('warns once when attachments go outside the synced folder', async () => {
		notices.length = 0;
		const a = await device('ABCD2345', 'Notes', { 'Notes/Hello.md': '# Hello\n' });
		await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 8000);
		const warning = (n: string) => n.startsWith('New attachments go to "/", outside "Notes".');
		await eventually(() => expect(notices.filter(warning)).toHaveLength(1), 8000);
		expect(a.settings.folderWarnings).toEqual(['Notes\nattachments']);

		// Not again when sync starts again, or after the plugin is loaded again.
		await a.setSyncEnabled(false);
		await a.setSyncEnabled(true);
		await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 8000);
		expect(notices.filter(warning)).toHaveLength(1);
		const stored = (a as unknown as { storedData: { folderWarnings?: unknown } }).storedData;
		expect(stored.folderWarnings).toEqual(['Notes\nattachments']);
	}, 30_000);

	it('keeps edits made while the server is unreachable and sends them later', async () => {
		const a = await device('ABCD2345', 'Notes', { 'Notes/Day.md': 'start' });
		const b = await device('EFGH2345', 'Notes');
		await eventually(() => expect(b.app.vault.files.get('Notes/Day.md')).toBe('start'), 8000);

		await server.drop();
		await eventually(() => expect(status(a)).toMatch(/^Stoasis: offline/), 8000);
		await a.app.vault.modify(new TFile('Notes/Day.md'), 'start, offline on A');
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(status(a)).toBe('Stoasis: offline, 1 waiting');

		await server.start();
		await eventually(() => expect(b.app.vault.files.get('Notes/Day.md')).toBe('start, offline on A'), 15_000);
		await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 8000);
	}, 40_000);

	it('stops syncing and says so when the server needs a newer plugin', async () => {
		const a = await device('ABCD2345', 'Notes', { 'Notes/Day.md': 'start' });
		await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 8000);
		control.minPlugin = '0.2.0';
		await server.drop();
		await server.start();
		await eventually(() => expect(status(a)).toBe('Stoasis: update needed'), 15_000);
	}, 30_000);

	it('follows the synced folder when it is renamed, without deleting anything', async () => {
		const a = await device('ABCD2345', 'Notes', { 'Notes/One.md': 'one', 'Notes/Two.md': 'two' });
		const b = await device('EFGH2345', 'Notes');
		await eventually(() => expect(b.app.vault.files.size).toBe(2), 8000);

		await a.app.vault.rename(a.app.vault.getAbstractFileByPath('Notes') as never, 'Renamed');
		expect(a.settings.mapping).toEqual({ kind: 'folder', path: 'Renamed' });
		await a.app.vault.modify(new TFile('Renamed/One.md'), 'one, edited');
		await eventually(() => expect(b.app.vault.files.get('Notes/One.md')).toBe('one, edited'), 8000);
		expect(b.app.vault.files.get('Notes/Two.md')).toBe('two');
	}, 30_000);

	it('pauses instead of deleting notes everywhere when the synced folder is deleted', async () => {
		const a = await device('ABCD2345', 'Notes', { 'Notes/One.md': 'one' });
		const b = await device('EFGH2345', 'Notes');
		await eventually(() => expect(b.app.vault.files.get('Notes/One.md')).toBe('one'), 8000);

		await a.app.vault.delete(a.app.vault.getAbstractFileByPath('Notes') as never);
		await eventually(() => expect(status(a)).toBe('Stoasis: sync off'), 8000);
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(b.app.vault.files.get('Notes/One.md')).toBe('one');
	}, 30_000);

	it('downloads the space to an empty device in one step, showing progress in a notice', async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 30; i++) {
			files[`Notes/Note ${i}.md`] = `text ${i}`;
		}
		const a = await device('ABCD2345', 'Notes', files);
		await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 8000);
		// The first device had nothing to download.
		expect(shownNotices.filter((n) => n.message.startsWith('Stoasis: downloading'))).toEqual([]);

		const app = new App();
		// Attachments go inside the folder, so there is no folder warning.
		app.vault.adapter.hidden.set('.obsidian/app.json', '{"attachmentFolderPath":"Personal/Attachments"}');
		const b = new StoasisPlugin(app as never, { id: 'stoasis', version: '0.1.0' } as never) as TestPlugin;
		plugins.push(b);
		await b.onload();
		app.workspace.ready();
		expect(await b.pair(control.server, 'EFGH2345', 'Phone')).toBe(true);
		notices.length = 0;
		shownNotices.length = 0;
		// Slow enough that the download is still going on when progress is first shown.
		server.authDelayMs = 600;
		await b.downloadToDevice();
		expect(b.settings).toMatchObject({ mapping: { kind: 'folder', path: 'Personal' }, syncEnabled: true });
		// The status bar and the settings tab show the same count while the notice is up.
		await eventually(() => expect(status(b)).toMatch(/^Stoasis: downloading \d+\/30$/), 8000);
		expect(b.status().download?.listed).toBe(30);

		await eventually(() => expect(app.vault.getMarkdownFiles()).toHaveLength(30), 15_000);
		expect(app.vault.files.get('Personal/Note 12.md')).toBe('text 12');
		await eventually(() => expect(status(b)).toBe('Stoasis: synced'), 8000);

		const progress = shownNotices.filter((n) => n.duration === 0);
		expect(progress).toHaveLength(1);
		expect(notices[0]).toMatch(/^Stoasis: downloading notes, \d+ of 30\.$/);
		await eventually(() => expect(progress[0]?.hidden).toBe(true), 8000);
		expect(notices.at(-1)).toBe('Stoasis: your notes are on this device.');
		expect(notices.filter((n) => n.startsWith('Stoasis: downloading'))).toHaveLength(1);
	}, 40_000);

	describe('moving a folder space to the whole vault', () => {
		const VAULT = {
			'Notes/One.md': 'one',
			'Notes/Deep/Two.md': 'two',
			'Inbox/Todo.md': 'todo',
			'Projects/Plan.md': 'plan',
		};

		/** Waits for the next window, reads it, and presses `label`. */
		const answered = new Set<unknown>();
		beforeEach(() => {
			openedModals.length = 0;
		});
		async function answerNext(label: string): Promise<string> {
			await eventually(() => expect(openedModals.some((m) => !answered.has(m))).toBe(true));
			const next = openedModals.find((m) => !answered.has(m));
			answered.add(next);
			const modal = next as unknown as { contentEl: ContainerEl };
			await eventually(() => expect(modal.contentEl.items.length).toBeGreaterThan(1));
			const text = modal.contentEl.items.map((i) => i.text ?? '').join(' ');
			const buttons = modal.contentEl.items.flatMap((i) => i.controls ?? []);
			if (!buttons.some((b) => b.label === label)) {
				throw new Error(`no ${label} in ${text}`);
			}
			await (buttons.find((b) => b.label === label) ?? fail()).click();
			return text;
		}

		async function folderDevices(): Promise<{ a: TestPlugin; b: TestPlugin }> {
			const a = await device('ABCD2345', 'Notes', VAULT);
			await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 8000);
			const b = await device('EFGH2345', 'Synced');
			await eventually(() => expect(b.app.vault.files.get('Synced/Deep/Two.md')).toBe('two'), 8000);
			return { a, b };
		}

		it('puts the notes under their folder, uploads the others, and keeps every id', async () => {
			const { a } = await folderDevices();
			const ids = { ...a.settings.sync.known };
			const moving = a.chooseWholeVault();
			const text = await answerNext('Move the space');
			expect(text).toContain('The space now starts at "Notes"');
			expect(text).toContain('2 notes');
			expect(await moving).toBe(true);
			expect(a.settings.mapping).toEqual({ kind: 'vault' });
			await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 10_000);
			await eventually(() => expect(Object.keys(a.settings.sync.known).sort()).toEqual([
				'Inbox/Todo.md',
				'Notes/Deep/Two.md',
				'Notes/One.md',
				'Projects/Plan.md',
			]), 10_000);
			expect(a.settings.sync.known['Notes/One.md']).toBe(ids['One.md']);
			expect(a.settings.sync.known['Notes/Deep/Two.md']).toBe(ids['Deep/Two.md']);
			// Nothing was moved or copied in the vault.
			expect(a.app.vault.files.get('Notes/One.md')).toBe('one');
			expect([...a.app.vault.files.keys()].sort()).toEqual(Object.keys(VAULT).sort());
		}, 40_000);

		it('asks another device to follow, renames its folder, and brings it the other folders', async () => {
			const { a, b } = await folderDevices();
			const moving = a.chooseWholeVault();
			await answerNext('Move the space');
			await moving;
			const text = await answerNext('Sync the whole vault');
			expect(text).toContain('Another device moved the space to the vault root');
			expect(text).toContain('"Synced" will be renamed to "Notes"');
			await eventually(() => expect(b.settings.mapping).toEqual({ kind: 'vault' }), 8000);
			await eventually(() => expect(b.app.vault.files.get('Projects/Plan.md')).toBe('plan'), 15_000);
			expect(b.app.vault.files.get('Notes/Deep/Two.md')).toBe('two');
			expect([...b.app.vault.files.keys()].some((p) => p.startsWith('Synced/'))).toBe(false);
			// No copies, and both keep syncing.
			expect(b.app.vault.getMarkdownFiles()).toHaveLength(4);
			await b.app.vault.modify(new TFile('Notes/One.md'), 'one, edited on B');
			await eventually(() => expect(a.app.vault.files.get('Notes/One.md')).toBe('one, edited on B'), 8000);
			await a.app.vault.create('Inbox/Later.md', 'later');
			await eventually(() => expect(b.app.vault.files.get('Inbox/Later.md')).toBe('later'), 8000);
		}, 60_000);

		it('does nothing to a device that has not followed yet, until it agrees', async () => {
			const { a, b } = await folderDevices();
			const moving = a.chooseWholeVault();
			await answerNext('Move the space');
			await moving;
			await answerNext('Cancel');
			await eventually(() => expect(b.settings.syncEnabled).toBe(false), 8000);
			expect(b.settings.mapping).toEqual({ kind: 'folder', path: 'Synced' });
			expect([...b.app.vault.files.keys()].sort()).toEqual(['Synced/Deep/Two.md', 'Synced/One.md']);
		}, 60_000);

		it('lets a new device join the space at the vault root', async () => {
			const { a } = await folderDevices();
			const moving = a.chooseWholeVault();
			await answerNext('Move the space');
			await moving;
			const { plugin: c, chosen } = await vaultDevice('JKMN2345', {});
			expect(chosen, notices.join(' | ')).toBe(true);
			await eventually(() => expect(c.app.vault.files.get('Notes/Deep/Two.md')).toBe('two'), 15_000);
			expect(c.app.vault.files.get('Inbox/Todo.md')).toBe('todo');
		}, 60_000);
	});

	describe('mapped to the whole vault', () => {
		const VAULT = {
			'Inbox.md': '# Inbox\n',
			'Work/Plan.md': 'plan',
			'Work/Deep/Notes.md': 'deep',
			'.obsidian/plugins/stoasis/data.md': 'the paired key lives here',
			'.trash/Old.md': 'trashed',
			'Work/.hidden/x.md': 'hidden',
			'Work/picture.png': 'binary',
		};

		it('syncs notes from the root, nested folders included, and nothing hidden', async () => {
			const { plugin: a, chosen } = await vaultDevice('ABCD2345', VAULT);
			expect(chosen).toBe(true);
			expect(a.settings.mapping).toEqual({ kind: 'vault' });
			await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 8000);
			expect(Object.keys(a.settings.sync.known).sort()).toEqual(['Inbox.md', 'Work/Deep/Notes.md', 'Work/Plan.md']);

			// Another device syncs the whole vault too: paths in the index are the vault's own.
			const { plugin: b } = await vaultDevice('EFGH2345', {});
			await eventually(() => expect(b.app.vault.files.get('Work/Deep/Notes.md')).toBe('deep'), 8000);
			expect(b.app.vault.files.get('Inbox.md')).toBe('# Inbox\n');
			expect([...b.app.vault.files.keys()].sort()).toEqual([
				'Inbox.md',
				'Work/Deep/Notes.md',
				'Work/Plan.md',
			]);

			await b.app.vault.create('Fresh.md', 'new');
			await eventually(() => expect(a.app.vault.files.get('Fresh.md')).toBe('new'), 8000);
		}, 40_000);

		it('follows a note at the root through a rename, a move and a delete', async () => {
			const { plugin: a } = await vaultDevice('ABCD2345', { 'Inbox.md': 'inbox' });
			const { plugin: b } = await vaultDevice('EFGH2345', {});
			await eventually(() => expect(b.app.vault.files.get('Inbox.md')).toBe('inbox'), 8000);

			await a.app.vault.rename(new TFile('Inbox.md') as never, 'Todo.md');
			await eventually(() => expect(b.app.vault.files.get('Todo.md')).toBe('inbox'), 8000);
			expect(b.app.vault.files.has('Inbox.md')).toBe(false);

			await a.app.vault.rename(new TFile('Todo.md') as never, 'Work/Todo.md');
			await eventually(() => expect(b.app.vault.files.get('Work/Todo.md')).toBe('inbox'), 8000);

			await a.app.vault.delete(new TFile('Work/Todo.md') as never);
			await eventually(() => expect(b.app.vault.files.has('Work/Todo.md')).toBe(false), 8000);
			expect(a.settings.mapping).toEqual({ kind: 'vault' });
			expect(status(a)).toBe('Stoasis: synced');
		}, 40_000);

		it('treats renaming and deleting a folder as moving and deleting its notes, and keeps syncing', async () => {
			const { plugin: a } = await vaultDevice('ABCD2345', {
				'Inbox.md': 'inbox',
				'Work/Plan.md': 'plan',
				'Work/Deep/Notes.md': 'deep',
				'Old/Gone.md': 'gone',
			});
			const { plugin: b } = await vaultDevice('EFGH2345', {});
			await eventually(() => expect(b.app.vault.files.size).toBe(4), 8000);

			await a.app.vault.rename(a.app.vault.getAbstractFileByPath('Work') as never, 'Projects');
			await eventually(() => expect(b.app.vault.files.get('Projects/Deep/Notes.md')).toBe('deep'), 8000);
			expect(b.app.vault.files.has('Work/Plan.md')).toBe(false);
			// The vault root is not a mapped folder that went missing.
			expect(a.settings.mapping).toEqual({ kind: 'vault' });
			expect(status(a)).toBe('Stoasis: synced');

			await a.app.vault.delete(a.app.vault.getAbstractFileByPath('Old') as never);
			await eventually(() => expect(b.app.vault.files.has('Old/Gone.md')).toBe(false), 8000);
			expect(b.app.vault.files.get('Inbox.md')).toBe('inbox');
			expect(a.settings.syncEnabled).toBe(true);
			expect(status(a)).toBe('Stoasis: synced');

			await b.app.vault.create('After.md', 'after');
			await eventually(() => expect(a.app.vault.files.get('After.md')).toBe('after'), 8000);
		}, 40_000);

		it('keeps its mapping and its notes across a restart', async () => {
			const { plugin: a } = await vaultDevice('ABCD2345', { 'Inbox.md': 'inbox', 'Work/Plan.md': 'plan' });
			await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 8000);
			await a.saveSettings();
			const stored = (a as unknown as { storedData: unknown }).storedData;
			expect(stored).toMatchObject({ mapping: { kind: 'vault' }, syncEnabled: true });
			expect(stored).not.toHaveProperty('folder');
			const { app } = a;
			a.onunload();

			const again = new StoasisPlugin(app, { id: 'stoasis', version: '0.3.0' } as never) as TestPlugin;
			plugins.push(again);
			(again as unknown as { storedData: unknown }).storedData = stored;
			await again.onload();
			app.workspace.ready();
			expect(again.settings.mapping).toEqual({ kind: 'vault' });
			await eventually(() => expect(status(again)).toBe('Stoasis: synced'), 8000);
			await app.vault.modify(new TFile('Work/Plan.md'), 'plan, edited');
			const { plugin: b } = await vaultDevice('EFGH2345', {});
			await eventually(() => expect(b.app.vault.files.get('Work/Plan.md')).toBe('plan, edited'), 8000);
			expect(b.app.vault.files.get('Inbox.md')).toBe('inbox');
		}, 40_000);

		it('asks first, saying how many notes will be uploaded, and maps nothing when cancelled', async () => {
			const { plugin, chosen, asked: text } = await vaultDevice('ABCD2345', VAULT, 'cancel');
			expect(chosen).toBe(false);
			expect(plugin.settings.mapping).toBeNull();
			// Hidden folders, the configuration folder and other files do not count.
			expect(text).toContain('3 notes will be uploaded to your server.');
			expect(text).toContain("except Obsidian's own settings and hidden folders");
			expect(plugin.settings.syncEnabled).toBe(false);
		});

		it('warns about a large vault before uploading', async () => {
			const files: Record<string, string> = {};
			for (let i = 0; i < LARGE_FIRST_SYNC + 1; i++) {
				files[`Many/${i}.md`] = `n${i}`;
			}
			const { plugin, chosen, asked: text } = await vaultDevice('ABCD2345', files, 'cancel');
			expect(chosen).toBe(false);
			expect(text).toContain(`${LARGE_FIRST_SYNC + 1} notes will be uploaded to your server. This can take a while`);
			expect(plugin.settings.mapping).toBeNull();
		});

		it('is refused for a space synced from a folder when this device syncs no folder, and changes nothing', async () => {
			const a = await device('ABCD2345', 'Notes', { 'Notes/One.md': 'one' });
			await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 8000);
			const app = new App();
			app.vault.files.set('Inbox.md', 'inbox');
			const plugin = new StoasisPlugin(app as never, { id: 'stoasis', version: '0.3.0' } as never) as TestPlugin;
			plugins.push(plugin);
			await plugin.onload();
			app.workspace.ready();
			expect(await plugin.pair(control.server, 'EFGH2345', 'Test device')).toBe(true);
			openedModals.length = 0;
			notices.length = 0;
			expect(await plugin.chooseWholeVault()).toBe(false);
			expect(openedModals).toHaveLength(0);
			expect(notices.join('\n')).toContain('This space was synced from a folder');
			expect(plugin.settings.mapping).toBeNull();
		}, 30_000);

		it('warns once about the vault root, in words that fit it', async () => {
			const app = new App();
			app.vault.adapter.hidden.set('.obsidian/core-plugins.json', '{"sync":true}');
			app.vault.files.set('Inbox.md', 'inbox');
			const plugin = new StoasisPlugin(app as never, { id: 'stoasis', version: '0.3.0' } as never) as TestPlugin;
			plugins.push(plugin);
			await plugin.onload();
			app.workspace.ready();
			expect(await plugin.pair(control.server, 'ABCD2345', 'Test device')).toBe(true);
			notices.length = 0;
			const choosing = plugin.chooseWholeVault();
			await eventually(() => expect(openedModals.length).toBeGreaterThan(0));
			const modal = openedModals[openedModals.length - 1] as unknown as { contentEl: ContainerEl };
			await eventually(() => expect(modal.contentEl.items.length).toBeGreaterThan(1));
			const buttons = modal.contentEl.items.flatMap((i) => i.controls ?? []);
			await (buttons.find((b) => b.label === 'Sync the whole vault') ?? fail()).click();
			await choosing;
			await plugin.setSyncEnabled(true);
			await eventually(() => expect(notices.filter((n) => n.startsWith('Obsidian Sync is turned on')).length).toBe(1), 8000);
			expect(notices.find((n) => n.startsWith('Obsidian Sync is turned on'))).toContain('syncs its notes too');
			expect(plugin.settings.folderWarnings).toContain('\nobsidian-sync');
		}, 30_000);

		it('asks before switching from the whole vault to a folder, and changes nothing when cancelled', async () => {
			const { plugin: a } = await vaultDevice('ABCD2345', { 'Inbox.md': 'inbox', 'Work/Plan.md': 'plan' });
			await eventually(() => expect(status(a)).toBe('Stoasis: synced'), 8000);
			openedModals.length = 0;
			const switching = a.setFolder('Work', false);
			await eventually(() => expect(openedModals.length).toBe(1));
			const modal = openedModals[0] as unknown as { contentEl: ContainerEl };
			await eventually(() => expect(modal.contentEl.items.length).toBeGreaterThan(1));
			const buttons = modal.contentEl.items.flatMap((i) => i.controls ?? []);
			await (buttons.find((b) => b.label === 'Cancel') ?? fail()).click();
			await switching;
			expect(a.settings.mapping).toEqual({ kind: 'vault' });
			expect(a.settings.syncEnabled).toBe(true);
		}, 30_000);
	});
});

describe('note history', () => {
	const OLD = '# Plan\n\nFirst draft.\n';
	const NEW = '# Plan\n\nSecond draft, rewritten.\n';

	it('lists versions, compares one with the note now, and restores it on every device', async () => {
		const a = await vaultDevice('ABCD2345', { 'Plan.md': OLD });
		await eventually(() => expect(status(a.plugin)).toBe('Stoasis: synced'), 8000);
		const b = await vaultDevice('EFGH2345', {}, 'confirm');
		await eventually(() => expect(b.plugin.app.vault.files.get('Plan.md')).toBe(OLD), 8000);

		const id = (a.plugin as unknown as { session: { engine: { noteAt(p: string): string } } }).session.engine.noteAt('Plan.md');
		await a.plugin.app.vault.modify(new TFile('Plan.md'), NEW);
		await eventually(() => expect(b.plugin.app.vault.files.get('Plan.md')).toBe(NEW), 8000);
		const stamp = (n: number) => `2026-10-16T09:4${n}:00+00:00`;
		control.versions.set(id, [
			{ version: 1, created_at: stamp(1), actor_kind: 'person', actor_label: 'you', reason: 'idle', size: OLD.length, text: OLD },
			{ version: 2, created_at: stamp(2), actor_kind: 'scanner', actor_label: 'Scanner', reason: 'scan', size: NEW.length, text: NEW },
		]);

		openedModals.length = 0;
		a.plugin.showHistory(new TFile('Plan.md') as never);
		const modal = openedModals[0] as unknown as { contentEl: ContainerEl };
		const clicks = (label: string) =>
			modal.contentEl.items.flatMap((i) => i.controls ?? []).filter((c) => c.label === label);
		await eventually(() => expect(clicks('View').length).toBe(2));
		const names = modal.contentEl.items.map((i) => i.name ?? '');
		expect(names.findIndex((n) => n.includes('Scanner edit'))).toBeLessThan(names.findIndex((n) => n.includes(': Edit by you')));

		// The older version is second in the list (newest first).
		await clicks('View')[1]?.click();
		const diffText = () =>
			(modal.contentEl.items.find((i) => i.cls === 'stoasis-diff')?.children ?? []).map((i) => i.text);
		await eventually(() => expect(diffText()).toContain('− First draft.'));
		expect(diffText()).toContain('+ Second draft, rewritten.');

		await clicks('Restore this version')[0]?.click();
		await eventually(() => expect(a.plugin.app.vault.files.get('Plan.md')).toBe(OLD), 8000);
		await eventually(() => expect(b.plugin.app.vault.files.get('Plan.md')).toBe(OLD), 8000);
	}, 40_000);

	it('shows a note that is not synced as having no history', async () => {
		const a = await vaultDevice('ABCD2345', { 'Plan.md': OLD });
		await eventually(() => expect(status(a.plugin)).toBe('Stoasis: synced'), 8000);
		notices.length = 0;
		openedModals.length = 0;
		a.plugin.showHistory(new TFile('Missing.md') as never);
		expect(openedModals.length).toBe(0);
		expect(notices.join(' ')).toContain('not synced');
	});
});
