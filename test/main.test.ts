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
		expect(plugin.settings.folder).toBe('Notes');
		expect(plugin.settings.syncEnabled).toBe(false);
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
		expect(notices).toEqual(['Paired as Ada. Choose a folder to sync in the Stoasis settings.']);
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
