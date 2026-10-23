import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	App,
	notices,
	openedModals,
	requests,
	setRequestHandler,
	type ContainerEl,
} from './stubs/obsidian';
import StoasisPlugin from '../src/main';
import type { PairModal } from '../src/pair-modal';
import { FakeControlPlane, SPACE_ID } from './helpers/control-plane';

const SERVER = 'https://notes.example.test';

type TestPlugin = StoasisPlugin & {
	statusItems: ContainerEl[];
	settingTabs: unknown[];
	editorExtensions: unknown[];
	protocolHandlers: Map<string, (p: Record<string, string>) => void>;
	storedData: unknown;
	saved: unknown[];
	commands: { id: string; callback?: () => void }[];
	domEvents: { el: ContainerEl; type: string; callback: () => void }[];
};

async function loadedPlugin(storedData: unknown = null): Promise<TestPlugin> {
	const plugin = new StoasisPlugin(new App() as never, { id: 'stoasis', version: '0.1.0' } as never) as TestPlugin;
	plugin.storedData = storedData;
	await plugin.onload();
	return plugin;
}

function link(plugin: TestPlugin, params: Record<string, string>): void {
	plugin.protocolHandlers.get('stoasis')?.({ action: 'stoasis', ...params });
}

let control: FakeControlPlane;
const plugins: TestPlugin[] = [];

beforeEach(() => {
	notices.length = 0;
	requests.length = 0;
	openedModals.length = 0;
	control = new FakeControlPlane(SERVER);
	setRequestHandler(control.handle);
});

afterEach(() => {
	for (const plugin of plugins.splice(0)) {
		plugin.onunload();
	}
	setRequestHandler(null);
	vi.restoreAllMocks();
});

describe('plugin load', () => {
	it('shows the not paired state in the status bar', async () => {
		const plugin = await loadedPlugin();
		expect(plugin.statusItems).toHaveLength(1);
		expect(plugin.statusItems[0]?.text).toBe('Stoasis: not paired');
	});

	it('registers a settings tab, the pairing link handler and the editor extension', async () => {
		const plugin = await loadedPlugin();
		expect(plugin.settingTabs).toHaveLength(1);
		expect([...plugin.protocolHandlers.keys()]).toEqual(['stoasis']);
		expect(plugin.editorExtensions).toHaveLength(1);
	});

	it('gives the vault a random id for its local sync storage', async () => {
		const a = await loadedPlugin();
		const b = await loadedPlugin();
		expect(a.settings.installId).toMatch(/^[0-9a-f-]{36}$/);
		expect(a.settings.installId).not.toBe(b.settings.installId);
	});

	it('loads stored settings through the same validation', async () => {
		const plugin = await loadedPlugin({ serverUrl: 3, folder: 'Notes', syncEnabled: 'yes' });
		expect(plugin.settings.serverUrl).toBe('');
		expect(plugin.settings.mapping).toEqual({ kind: 'folder', path: 'Notes' });
		expect(plugin.settings.syncEnabled).toBe(false);
	});
});

describe('sync status and history', () => {
	const stored = { activity: { contactAt: 1_000, entries: [{ at: 2_000, direction: 'upload', action: 'edit', path: 'Notes/Plan.md' }] } };

	it('opens from the command and from the status bar, and lists what synced', async () => {
		const plugin = await loadedPlugin(stored);
		plugins.push(plugin);
		const command = plugin.commands.find((c) => c.id === 'sync-status');
		command?.callback?.();
		expect(openedModals).toHaveLength(1);
		const text = JSON.stringify(openedModals[0]?.contentEl);
		expect(text).toContain('Plan.md');
		expect(text).toContain('Uploaded, edited');
		expect(text).toContain('Notes');

		plugin.domEvents.find((e) => e.el === plugin.statusItems[0] && e.type === 'click')?.callback();
		expect(openedModals).toHaveLength(2);
	});

	it('forgets the history when the device disconnects', async () => {
		const plugin = await loadedPlugin({ ...stored, serverUrl: SERVER, deviceKey: 'k', keyId: 'i' });
		plugins.push(plugin);
		await plugin.unpair();
		expect(plugin.settings.activity).toEqual({ entries: [], contactAt: null });
	});
});

describe('pairing link', () => {
	it('asks before pairing, and pairs with the code from the link', async () => {
		const plugin = await loadedPlugin();
		link(plugin, { server: SERVER, code: 'abcd-2345' });

		expect(openedModals).toHaveLength(1);
		expect(requests).toEqual([]);

		await (openedModals[0] as unknown as PairModal).confirm();
		expect(requests.map((r) => `${r.method} ${r.url.slice(SERVER.length)}`)).toEqual([
			'GET /notes/api/version',
			'POST /notes/api/pair',
			'GET /notes/api/spaces',
			'POST /notes/api/spaces',
		]);
		expect(JSON.parse(requests[1]?.body ?? '')).toEqual({
			code: 'ABCD2345',
			device_label: 'Obsidian on Linux',
		});
		expect(plugin.settings).toMatchObject({
			serverUrl: SERVER,
			deviceKey: 'device-key-1',
			keyId: 'key-1',
			personName: 'Ada',
			spaceId: SPACE_ID,
		});
		expect(notices).toEqual([
			'Paired as Ada. To get your notes on this device, open the Stoasis settings and choose "Download to this device".',
		]);
		expect(openedModals[0]?.isOpen).toBe(false);
		expect(plugin.statusItems[0]?.text).toBe('Stoasis: sync off');
	});

	it('never sends the key in a URL', async () => {
		const plugin = await loadedPlugin();
		link(plugin, { server: SERVER, code: 'ABCD2345' });
		await (openedModals[0] as unknown as PairModal).confirm();
		for (const request of requests) {
			expect(request.url).not.toContain('device-key');
		}
		expect(requests[2]?.headers?.['Authorization']).toBe('Bearer device-key-1');
	});

	it('keeps the dialog open and explains a rejected code', async () => {
		const plugin = await loadedPlugin();
		link(plugin, { server: SERVER, code: 'WXYZ2345' });
		await (openedModals[0] as unknown as PairModal).confirm();
		expect(notices).toEqual([
			'This pairing code is not valid or has expired. Create a new one and try again.',
		]);
		expect(openedModals[0]?.isOpen).toBe(true);
		expect(plugin.settings.deviceKey).toBe('');
	});

	it('refuses to pair with a server that needs a newer plugin', async () => {
		control.minPlugin = '0.2.0';
		const plugin = await loadedPlugin();
		link(plugin, { server: SERVER, code: 'ABCD2345' });
		await (openedModals[0] as unknown as PairModal).confirm();
		expect(notices).toEqual([
			'Your server needs Stoasis 0.2.0 or later. Update the plugin to keep syncing.',
		]);
		expect(requests.map((r) => r.url)).toEqual([`${SERVER}/notes/api/version`]);
		expect(plugin.settings.deviceKey).toBe('');
	});

	it('rejects an invalid link without opening anything or echoing the code', async () => {
		const plugin = await loadedPlugin();
		link(plugin, { server: 'http://example.test', code: 'secret-code-1' });
		expect(notices).toEqual(['This pairing link is not valid.']);
		expect(openedModals).toHaveLength(0);
		expect(plugin.settings.deviceKey).toBe('');
	});

	it('writes nothing to the console while loading, pairing or handling bad links', async () => {
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
			vi.spyOn(console, method).mockImplementation(() => undefined),
		);
		const plugin = await loadedPlugin();
		link(plugin, { server: SERVER, code: 'ABCD2345' });
		await (openedModals[0] as unknown as PairModal).confirm();
		link(plugin, { server: 'notes', code: 'abc123' });
		link(plugin, {});
		for (const spy of spies) {
			expect(spy).not.toHaveBeenCalled();
		}
	});
});

describe('pairing by hand', () => {
	it('pairs with a typed address and code', async () => {
		const plugin = await loadedPlugin();
		expect(await plugin.pair(`${SERVER}/`, ' abcd 2345 ', 'Desk')).toBe(true);
		expect(plugin.settings.serverUrl).toBe(SERVER);
		expect(plugin.settings.deviceLabel).toBe('Desk');
	});

	it('explains what is wrong with the typed values', async () => {
		const plugin = await loadedPlugin();
		expect(await plugin.pair('', 'ABCD2345', 'Desk')).toBe(false);
		expect(await plugin.pair('http://notes.example.test', 'ABCD2345', 'Desk')).toBe(false);
		expect(await plugin.pair(SERVER, 'not a code!', 'Desk')).toBe(false);
		expect(notices).toEqual([
			'Enter the server address.',
			'The server address must start with https://.',
			'This pairing code is not valid. Check it and try again.',
		]);
		expect(requests).toEqual([]);
	});

	it('reports an unreachable server', async () => {
		setRequestHandler(null);
		const plugin = await loadedPlugin();
		expect(await plugin.pair(SERVER, 'ABCD2345', 'Desk')).toBe(false);
		expect(notices).toEqual(['Could not reach the server. Check the address and your connection.']);
	});

	it('disconnects by revoking its own key and forgetting it', async () => {
		const plugin = await loadedPlugin();
		await plugin.pair(SERVER, 'ABCD2345', 'Desk');
		await plugin.unpair();
		expect(control.revoked).toEqual(['key-1']);
		expect(plugin.settings).toMatchObject({ serverUrl: '', deviceKey: '', keyId: '', spaceId: '' });
		expect(JSON.stringify(plugin.storedData)).not.toContain('device-key-1');
		expect(plugin.statusItems[0]?.text).toBe('Stoasis: not paired');
	});
});

describe('download to this device', () => {
	async function pairedPlugin(app = new App()): Promise<TestPlugin> {
		const plugin = new StoasisPlugin(app as never, { id: 'stoasis', version: '0.1.0' } as never) as TestPlugin;
		plugins.push(plugin);
		await plugin.onload();
		expect(await plugin.pair(SERVER, 'ABCD2345', 'Phone')).toBe(true);
		// No sync server here: the space looks like one that starts at a folder.
		vi.spyOn(plugin as unknown as { withSpace: () => Promise<unknown> }, 'withSpace').mockResolvedValue(null);
		return plugin;
	}

	it('creates a folder named after the space, syncs it and saves that', async () => {
		const app = new App();
		const plugin = await pairedPlugin(app);
		expect(plugin.settings.spaceName).toBe('Personal');
		expect(plugin.downloadFolder()).toBe('Personal');

		await plugin.downloadToDevice();
		expect(app.vault.folders.has('Personal')).toBe(true);
		expect(plugin.settings).toMatchObject({ mapping: { kind: 'folder', path: 'Personal' }, syncEnabled: true });
		expect(plugin.settings.sync).toEqual({ known: {}, seeded: false });
		expect(plugin.storedData).toMatchObject({ mapping: { kind: 'folder', path: 'Personal' }, syncEnabled: true });
		expect(plugin.status().configured).toBe(true);
	});

	it('picks a free name when a folder of that name already holds something', async () => {
		const app = new App();
		app.vault.folders.add('Personal');
		app.vault.files.set('Personal/Old.md', 'kept');
		app.vault.folders.add('personal 2');
		const plugin = await pairedPlugin(app);
		expect(plugin.downloadFolder()).toBe('Personal 3');
		await plugin.downloadToDevice();
		expect(plugin.settings.mapping).toEqual({ kind: 'folder', path: 'Personal 3' });
		expect(app.vault.folders.has('Personal 3')).toBe(true);
		expect(app.vault.files.get('Personal/Old.md')).toBe('kept');
	});

	it('uses an empty folder of that name, and avoids a file of that name', async () => {
		const app = new App();
		app.vault.folders.add('Personal');
		const plugin = await pairedPlugin(app);
		expect(plugin.downloadFolder()).toBe('Personal');

		app.vault.folders.delete('Personal');
		app.vault.files.set('Personal', 'a file without an extension');
		expect(plugin.downloadFolder()).toBe('Personal 2');
	});

	it('falls back to the suggested name when the space has no usable name', async () => {
		const plugin = await pairedPlugin();
		plugin.settings.spaceName = '';
		expect(plugin.downloadFolder()).toBe('Stoasis');
		plugin.settings.spaceName = '..:/';
		expect(plugin.downloadFolder()).toBe('Stoasis');
		plugin.settings.spaceName = 'Ada\'s notes: 2026/10';
		expect(plugin.downloadFolder()).toBe("Ada's notes 2026 10");
	});
});
