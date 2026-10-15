import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import StoasisPlugin from '../src/main';
import { FakeControlPlane } from './helpers/control-plane';
import { eventually, TestSyncServer } from './helpers/sync-server';
import { App, setRequestHandler, TFile, type ContainerEl } from './stubs/obsidian';

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
	server = new TestSyncServer();
	await server.start();
	control = new FakeControlPlane(server.url.replace('ws://', 'http://'));
	control.codes.add('EFGH2345');
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
		expect(a.settings.folder).toBe('Renamed');
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
});
