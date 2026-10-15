import { describe, expect, it } from 'vitest';
import type { Control, ContainerEl, RenderedItem } from './stubs/obsidian';
import {
	DEFAULT_SETTINGS,
	StoasisSettingTab,
	SUGGESTED_FOLDER,
	describePairingState,
	getPairingState,
	parseSettings,
	type SettingsHost,
	type StoasisSettings,
} from '../src/settings';
import type { SyncSnapshot } from '../src/status';

describe('default settings', () => {
	it('start in the not paired state', () => {
		expect(DEFAULT_SETTINGS.serverUrl).toBe('');
		expect(getPairingState(DEFAULT_SETTINGS)).toBe('not-paired');
		expect(describePairingState('not-paired')).toBe('Not paired');
		expect(describePairingState('paired')).toBe('Paired');
	});

	it('count as paired only with both an address and a device key', () => {
		expect(getPairingState({ ...DEFAULT_SETTINGS, serverUrl: 'https://notes.example.test' })).toBe('not-paired');
		expect(
			getPairingState({ ...DEFAULT_SETTINGS, serverUrl: 'https://notes.example.test', deviceKey: 'k' }),
		).toBe('paired');
	});
});

describe('parseSettings', () => {
	it('falls back to the defaults when nothing is stored', () => {
		for (const data of [null, undefined, 'text', 42, []]) {
			expect(parseSettings(data)).toEqual(DEFAULT_SETTINGS);
		}
	});

	it('keeps stored values of the right type', () => {
		const stored = {
			serverUrl: 'https://notes.example.test',
			deviceKey: 'k',
			folder: 'Notes',
			syncEnabled: true,
			sync: { known: { 'a.md': '6f1c1d9e-8f0a-4a57-9a51-2f4f3e0f9a10' }, seeded: true },
		};
		expect(parseSettings(stored)).toMatchObject(stored);
	});

	it('drops unknown fields and values of the wrong type', () => {
		const settings = parseSettings({ serverUrl: 7, extra: 'x', syncEnabled: 'yes', sync: 'broken' });
		expect(settings).toEqual(DEFAULT_SETTINGS);
		expect(settings).not.toHaveProperty('extra');
	});

	it('returns a copy, never the defaults object itself', () => {
		const settings = parseSettings(null);
		settings.serverUrl = 'changed';
		settings.sync.known['a.md'] = 'x';
		expect(DEFAULT_SETTINGS.serverUrl).toBe('');
		expect(DEFAULT_SETTINGS.sync.known).toEqual({});
		settings.pendingRevocations.push({ serverUrl: 's', deviceKey: 'k', keyId: 'i' });
		expect(DEFAULT_SETTINGS.pendingRevocations).toEqual([]);
	});

	it('keeps every key left to revoke, once each, including one stored the old way', () => {
		const key = (serverUrl: string, keyId: string) => ({ serverUrl, deviceKey: `${keyId}-secret`, keyId });
		const settings = parseSettings({
			pendingRevocations: [key('https://a.test', 'key-1'), key('https://b.test', 'key-1'), 'junk', { keyId: 3 }],
			pendingRevocation: key('https://a.test', 'key-2'),
		});
		expect(settings.pendingRevocations).toEqual([
			key('https://a.test', 'key-1'),
			key('https://b.test', 'key-1'),
			key('https://a.test', 'key-2'),
		]);
		expect(parseSettings({ pendingRevocation: key('https://a.test', 'key-1'), pendingRevocations: [key('https://a.test', 'key-1')] }).pendingRevocations).toHaveLength(1);
	});
});

class FakeHost {
	settings: StoasisSettings = parseSettings(null);
	vaultFolders = ['Journal', 'Work'];
	calls: string[] = [];
	pairResult = true;

	status(): SyncSnapshot {
		return {
			paired: getPairingState(this.settings) === 'paired',
			configured: this.settings.folder !== '' && this.settings.syncEnabled,
			connection: null,
			pending: 0,
			refused: 0,
			ready: false,
		};
	}
	defaultDeviceLabel(): string {
		return 'Obsidian on Linux';
	}
	folders(): string[] {
		return this.vaultFolders;
	}
	pair(server: string, code: string, label: string): Promise<boolean> {
		this.calls.push(`pair ${server} ${code} ${label}`);
		if (this.pairResult) {
			Object.assign(this.settings, {
				serverUrl: server,
				deviceKey: 'k',
				deviceLabel: label,
				personName: 'Ada',
			});
		}
		return Promise.resolve(this.pairResult);
	}
	unpair(): Promise<void> {
		this.calls.push('unpair');
		this.settings = parseSettings(null);
		return Promise.resolve();
	}
	retryRevocation(): Promise<boolean> {
		this.calls.push('retry revocation');
		return Promise.resolve(false);
	}
	setFolder(folder: string, create: boolean): Promise<void> {
		this.calls.push(`folder ${folder} ${create}`);
		this.settings.folder = folder;
		return Promise.resolve();
	}
	setSyncEnabled(enabled: boolean): Promise<void> {
		this.calls.push(`sync ${enabled}`);
		this.settings.syncEnabled = enabled;
		return Promise.resolve();
	}
}

function render(host: FakeHost) {
	const tab = new StoasisSettingTab({} as never, host as unknown as SettingsHost);
	tab.display();
	const items = () => (tab.containerEl as unknown as ContainerEl).items;
	const setting = (name: string): RenderedItem => {
		const item = items().find((i) => i.kind === 'setting' && i.name === name);
		if (item === undefined) {
			throw new Error(`No setting named ${name}`);
		}
		return item;
	};
	const control = (name: string, index = 0): Control => {
		const found = setting(name).controls?.[index];
		if (found === undefined) {
			throw new Error(`No control on ${name}`);
		}
		return found;
	};
	const button = (label: string): Control => {
		const found = items()
			.flatMap((i) => i.controls ?? [])
			.find((c) => c.kind === 'button' && c.label === label);
		if (found === undefined) {
			throw new Error(`No button ${label}`);
		}
		return found;
	};
	return { tab, items, setting, control, button };
}

function paired(): FakeHost {
	const host = new FakeHost();
	Object.assign(host.settings, {
		serverUrl: 'https://notes.example.test',
		deviceKey: 'k',
		deviceLabel: 'Desk',
		personName: 'Ada',
		spaceId: 's1',
		spaceName: 'Personal',
	});
	return host;
}

describe('settings tab', () => {
	it('offers to retry revoking the key of a disconnected device', async () => {
		const host = new FakeHost();
		host.settings.pendingRevocations.push({
			serverUrl: 'https://notes.example.test',
			deviceKey: 'old',
			keyId: 'key-1',
		});
		const { setting, button } = render(host);
		expect(setting('Old device key').desc).toContain('still works there');
		await button('Try again').click();
		expect(host.calls).toEqual(['retry revocation']);
	});

	it('says how many keys of disconnected devices are left to revoke', () => {
		const host = new FakeHost();
		for (const keyId of ['key-1', 'key-2']) {
			host.settings.pendingRevocations.push({ serverUrl: 'https://notes.example.test', deviceKey: 'old', keyId });
		}
		const { setting } = render(host);
		expect(setting('Old device keys').desc).toContain('the keys of 2 devices you disconnected');
	});

	it('shows no revocation row when nothing is pending', () => {
		const { setting } = render(new FakeHost());
		expect(() => setting('Old device key')).toThrow();
	});

	it('shows the status first, without a heading above it', () => {
		const { items } = render(new FakeHost());
		expect(items()[0]).toMatchObject({ kind: 'setting', name: 'Status' });
		expect(items()[0]?.desc).toContain('not paired');
	});

	it('offers pairing by hand when not paired', async () => {
		const host = new FakeHost();
		const { control, button, setting } = render(host);
		expect(control('Device name').value).toBe('Obsidian on Linux');
		await control('Server address').change('https://notes.example.test');
		await control('Pairing code').change('abcd-2345');
		await control('Device name').change('x'.repeat(100));
		await button('Pair').click();
		expect(host.calls).toEqual([`pair https://notes.example.test abcd-2345 ${'x'.repeat(80)}`]);
		expect(setting('Server').desc).toContain('https://notes.example.test for Ada');
	});

	it('keeps what was typed when pairing fails', async () => {
		const host = new FakeHost();
		host.pairResult = false;
		const { control, button } = render(host);
		await control('Server address').change('https://notes.example.test');
		await button('Pair').click();
		expect(control('Server address').value).toBe('https://notes.example.test');
	});

	it('shows the pairing and the sync choices once paired', () => {
		const { setting, control, items } = render(paired());
		expect(setting('Server').desc).toBe('Paired with https://notes.example.test for Ada, as "Desk".');
		expect(setting('Space').desc).toBe('Your personal space, "Personal".');
		expect(control('Folder').options).toEqual([
			['', 'Choose a folder'],
			['/new', `New folder: ${SUGGESTED_FOLDER}`],
			['Journal', 'Journal'],
			['Work', 'Work'],
		]);
		expect(control('Sync this folder').disabled).toBe(true);
		expect(items().some((i) => i.name === 'Pairing code')).toBe(false);
	});

	it('maps a folder, creating the suggested one on request, then turns sync on', async () => {
		const host = paired();
		const { control } = render(host);
		await control('Folder').change('/new');
		expect(host.calls).toEqual([`folder ${SUGGESTED_FOLDER} true`]);
		await control('Folder').change('Work');
		await control('Sync this folder').change(true);
		expect(host.calls.slice(1)).toEqual(['folder Work false', 'sync true']);
		expect(control('Sync this folder').disabled).toBe(false);
		expect(control('Sync this folder').value).toBe(true);
	});

	it('disconnects', async () => {
		const host = paired();
		const { button, items } = render(host);
		await button('Disconnect').click();
		expect(host.calls).toEqual(['unpair']);
		expect(items().some((i) => i.name === 'Pairing code')).toBe(true);
	});

	it('shows the network and privacy disclosure under its own heading', () => {
		for (const host of [new FakeHost(), paired()]) {
			const all = render(host).items();
			const heading = all.findIndex((i) => i.kind === 'heading' && i.name === 'Network and privacy');
			expect(heading).toBeGreaterThan(0);
			const text = all[heading + 1]?.text ?? '';
			expect(all[heading + 1]).toMatchObject({ kind: 'element', tag: 'p', cls: 'stoasis-disclosure' });
			expect(text).toContain('needs an account on a compatible server');
			expect(text).toContain('only contacts the server you pair it with');
			expect(text).toContain('no telemetry and no self-update');
		}
	});

	it('renders the same content when shown again', () => {
		const { tab, items } = render(paired());
		const first = items().length;
		tab.display();
		expect(items()).toHaveLength(first);
	});
});
