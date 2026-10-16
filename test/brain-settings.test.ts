import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, setRequestHandler, type ContainerEl, type Control } from './stubs/obsidian';
import StoasisPlugin from '../src/main';
import type { StoasisSettingTab } from '../src/settings';
import { FakeControlPlane, SPACE_ID } from './helpers/control-plane';

// The Brain section against the server's HTTP answers, through the plugin's own client.

const SERVER = 'https://notes.example.test';

type TestPlugin = StoasisPlugin & { settingTabs: StoasisSettingTab[] };

let control: FakeControlPlane;
const plugins: TestPlugin[] = [];

beforeEach(() => {
	control = new FakeControlPlane(SERVER);
	setRequestHandler(control.handle);
});

afterEach(() => {
	for (const plugin of plugins.splice(0)) {
		plugin.onunload();
	}
	setRequestHandler(null);
});

function reopen(tab: { hide(): void; display(): void }): void {
	tab.hide();
	tab.display();
}

const flush = async () => {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

async function openSettings(prepare: () => void = () => {}) {
	const plugin = new StoasisPlugin(new App() as never, { id: 'stoasis', version: '0.2.0' } as never) as TestPlugin;
	plugins.push(plugin);
	await plugin.onload();
	expect(await plugin.pair(SERVER, 'ABCD2345', 'Desk')).toBe(true);
	const [token] = control.keys.keys();
	control.handle({ url: `${SERVER}/notes/api/spaces`, method: 'POST', headers: { Authorization: `Bearer ${token}` } });
	plugin.settings.spaceId = SPACE_ID;
	prepare();
	const tab = plugin.settingTabs[0]!;
	// Pairing drew the tab already; open it afresh, as the app does.
	reopen(tab);
	await flush();
	const items = () => (tab.containerEl as unknown as ContainerEl).items;
	const names = () => items().filter((i) => i.kind !== 'element').map((i) => i.name);
	const controlOf = (name: string): Control => {
		const found = items().find((i) => i.name === name)?.controls?.[0];
		if (found === undefined) {
			throw new Error(`No control on ${name}`);
		}
		return found;
	};
	const errors = () => items().filter((i) => i.cls === 'stoasis-error').map((i) => i.text);
	return { plugin, tab, names, controlOf, errors };
}

describe('the Brain section, against the server', () => {
	it('shows the switch, the scan mode and base metadata to the owner, and changes them', async () => {
		const { names, controlOf } = await openSettings();
		expect(names()).toContain('Brain');
		expect(controlOf('Scan my notes automatically').value).toBe(true);
		await controlOf('Scan my notes automatically').change(false);
		expect(control.scanSettings.scan_enabled).toBe(false);
		await controlOf('Scan mode for your space').change('suggest');
		expect(control.spaces[0]?.['scan_mode']).toBe('suggest');
		await controlOf('Existing notes').click();
		expect(control.spaces[0]?.['base_backfill_requested']).toBe(true);
		await controlOf('Base metadata').change(false);
		expect(control.spaces[0]?.['base_metadata']).toBe(false);
		expect(names()).not.toContain('Existing notes');
	});

	it('is hidden while the server answers 404 for scan settings', async () => {
		const { names } = await openSettings(() => {
			control.scanSettingsStatus = 404;
		});
		expect(names()).not.toContain('Brain');
		expect(names()).toContain('Network and privacy');
	});

	it('leaves out base metadata until the server has it', async () => {
		const { names, controlOf } = await openSettings(() => {
			control.baseMetadataLive = false;
			delete control.spaces[0]?.['base_metadata'];
			delete control.spaces[0]?.['base_backfill_requested'];
		});
		expect(names()).toContain('Scan mode for your space');
		expect(names()).not.toContain('Base metadata');
		await controlOf('Scan mode for your space').change('auto');
		expect(control.spaces[0]?.['scan_mode']).toBe('auto');
	});

	it('hides the owner controls on a 403', async () => {
		const { names, controlOf, errors } = await openSettings(() => {
			control.notOwner = true;
		});
		await controlOf('Base metadata').change(false);
		expect(names()).toContain('Scan my notes automatically');
		expect(names()).not.toContain('Scan mode for your space');
		expect(names()).not.toContain('Base metadata');
		expect(errors()).toEqual(["Only the space's owner can change this."]);
	});

	it("says it couldn't reach the server, and keeps the controls", async () => {
		const { controlOf, errors } = await openSettings();
		setRequestHandler(null);
		await controlOf('Scan mode for your space').change('auto');
		expect(errors()).toEqual(["Couldn't reach the server. Nothing was changed."]);
		expect(controlOf('Scan mode for your space').value).toBe('off');
		expect(controlOf('Base metadata').value).toBe(true);
	});
});
