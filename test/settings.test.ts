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
import { folderMapping, WHOLE_VAULT } from '../src/sync/paths';
import type { SyncSnapshot } from '../src/status';
import { ApiError, type ScanMode, type ScanSettings, type Space } from '../src/api';
import { Brain, type BrainApi } from '../src/brain';

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
			mapping: { kind: 'folder', path: 'Notes' },
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

type BrainCall = keyof BrainApi;

/** The server's Brain endpoints, answering from what it holds or with the error set for a call. */
class FakeBrainApi implements BrainApi {
	scan: ScanSettings = { scanEnabled: false, operatorEnabled: true };
	spaces: Space[] = [
		{
			id: 's1',
			name: 'Personal',
			kind: 'personal',
			role: 'owner',
			scanMode: 'off',
			archived: false,
			baseMetadata: true,
			baseBackfillRequested: false,
			usage: null,
		},
	];
	fail: Partial<Record<BrainCall, ApiError>> = {};
	calls: string[] = [];

	private answer<T>(call: BrainCall, value: () => T): Promise<T> {
		const error = this.fail[call];
		return error === undefined ? Promise.resolve(value()) : Promise.reject(error);
	}
	private space(id: string): Space {
		const space = this.spaces.find((s) => s.id === id);
		if (space === undefined) {
			throw new ApiError('not-found', 404);
		}
		return space;
	}
	scanSettings(): Promise<ScanSettings> {
		this.calls.push('scan settings');
		return this.answer('scanSettings', () => ({ ...this.scan }));
	}
	setScanEnabled(enabled: boolean): Promise<ScanSettings> {
		this.calls.push(`scan ${enabled}`);
		return this.answer('setScanEnabled', () => {
			this.scan.scanEnabled = enabled;
			return { ...this.scan };
		});
	}
	listSpaces(): Promise<Space[]> {
		this.calls.push('spaces');
		return this.answer('listSpaces', () => this.spaces.map((s) => ({ ...s })));
	}
	setScanMode(spaceId: string, mode: ScanMode): Promise<Space> {
		this.calls.push(`mode ${spaceId} ${mode}`);
		return this.answer('setScanMode', () => ({ ...Object.assign(this.space(spaceId), { scanMode: mode }) }));
	}
	setBaseMetadata(spaceId: string, enabled: boolean): Promise<Space> {
		this.calls.push(`base ${spaceId} ${enabled}`);
		return this.answer('setBaseMetadata', () => ({
			...Object.assign(this.space(spaceId), {
				baseMetadata: enabled,
				baseBackfillRequested: enabled && this.space(spaceId).baseBackfillRequested,
			}),
		}));
	}
	requestBaseBackfill(spaceId: string): Promise<Space | null> {
		this.calls.push(`backfill ${spaceId}`);
		return this.answer('requestBaseBackfill', () => {
			Object.assign(this.space(spaceId), { baseBackfillRequested: true });
			return null;
		});
	}
}

class FakeHost {
	settings: StoasisSettings = parseSettings(null);
	/** The server's Brain calls; null for a server without them. */
	brain: FakeBrainApi | null = null;
	vaultFolders = ['Journal', 'Work'];
	calls: string[] = [];
	pairResult = true;

	status(): SyncSnapshot {
		return {
			paired: getPairingState(this.settings) === 'paired',
			configured: this.settings.mapping !== null && this.settings.syncEnabled,
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
		this.settings.mapping = folderMapping(folder);
		return Promise.resolve();
	}
	chooseWholeVault(): Promise<boolean> {
		this.calls.push('whole vault');
		this.settings.mapping = WHOLE_VAULT;
		return Promise.resolve(true);
	}
	setSyncEnabled(enabled: boolean): Promise<void> {
		this.calls.push(`sync ${enabled}`);
		this.settings.syncEnabled = enabled;
		return Promise.resolve();
	}
	downloadFolder(): string {
		return this.settings.spaceName === '' ? SUGGESTED_FOLDER : `${this.settings.spaceName} 2`;
	}
	brainApi(): BrainApi | null {
		return getPairingState(this.settings) === 'paired' ? this.brain : null;
	}
	downloadToDevice(): Promise<void> {
		this.calls.push('download');
		this.settings.mapping = folderMapping(this.downloadFolder());
		this.settings.syncEnabled = true;
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

	it('offers to download the space first on a device that syncs no folder yet', () => {
		const { setting, control, items, button } = render(paired());
		expect(setting('Server').desc).toBe('Paired with https://notes.example.test for Ada, as "Desk".');
		const download = setting('Your space "Personal" is on your server');
		expect(download.desc).toContain('new folder, "Personal 2", on this device');
		expect(button('Download to this device').disabled).toBe(false);
		// The download comes before the folder choice, which says what it merges.
		const names = items().map((i) => i.name);
		expect(names.indexOf('Your space "Personal" is on your server')).toBeLessThan(
			names.indexOf('Or sync an existing folder'),
		);
		expect(setting('Or sync an existing folder').desc).toContain(
			'Notes already in that folder are added to the space',
		);
		expect(control('Or sync an existing folder').options).toEqual([
			['', 'Choose a folder'],
			['/vault', 'Whole vault'],
			['Journal', 'Journal'],
			['Work', 'Work'],
		]);
		expect(setting('Or sync an existing folder').desc).toContain(
			"Every Markdown note in this vault syncs, except Obsidian's own settings and hidden folders.",
		);
		expect(names).not.toContain('Sync this folder');
		expect(names).not.toContain('Space');
		expect(items().some((i) => i.name === 'Pairing code')).toBe(false);
	});

	it('names the space generically while its name is not known', () => {
		const host = paired();
		host.settings.spaceName = '';
		const { setting } = render(host);
		expect(setting('Your space is on your server').desc).toContain(`"${SUGGESTED_FOLDER}"`);
	});

	it('downloads the space and turns sync on in one step', async () => {
		const host = paired();
		const { button, setting, control } = render(host);
		await button('Download to this device').click();
		expect(host.calls).toEqual(['download']);
		expect(setting('Space').desc).toBe('Your personal space, "Personal".');
		expect(control('Folder').value).toBe('Personal 2');
		expect(control('Sync this folder').value).toBe(true);
		expect(() => button('Download to this device')).toThrow();
	});

	it('syncs an existing folder, then turns sync on, then offers a new folder', async () => {
		const host = paired();
		const { control } = render(host);
		await control('Or sync an existing folder').change('Work');
		expect(host.calls).toEqual(['folder Work false']);
		expect(control('Sync this folder').value).toBe(false);
		await control('Sync this folder').change(true);
		expect(control('Sync this folder').value).toBe(true);
		expect(control('Folder').options).toContainEqual(['/new', `New folder: ${SUGGESTED_FOLDER}`]);
		await control('Folder').change('/new');
		expect(host.calls).toEqual(['folder Work false', 'sync true', `folder ${SUGGESTED_FOLDER} true`]);
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
			expect(text).toContain('a note you tag with "Tag this note now", which the server does not keep');
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

describe('settings tab: Brain', () => {
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	async function brain(prepare: (api: FakeBrainApi, host: FakeHost) => void = () => {}) {
		const host = paired();
		host.settings.mapping = folderMapping('Notes');
		const api = new FakeBrainApi();
		host.brain = api;
		prepare(api, host);
		const view = render(host);
		await flush();
		const names = () => view.items().filter((i) => i.kind !== 'element').map((i) => i.name);
		const texts = () => view.items().filter((i) => i.kind === 'element').map((i) => i.text);
		return { ...view, host, api, names, texts };
	}

	it('asks the server, then shows the switch and the owner controls between sync and privacy', async () => {
		const host = paired();
		host.brain = new FakeBrainApi();
		const { items, setting, control, button } = render(host);
		expect(items().some((i) => i.text === 'Asking the server…')).toBe(true);
		await flush();
		const names = items().filter((i) => i.kind === 'heading').map((i) => i.name);
		expect(names).toEqual(['Sync', 'Brain', 'Network and privacy']);
		expect(control('Scan my notes automatically').value).toBe(false);
		expect(control('Scan mode for your space').value).toBe('off');
		expect(control('Scan mode for your space').options.map(([value]) => value)).toEqual(['off', 'suggest', 'auto']);
		expect(setting('Scan mode for your space').desc).toContain('Suggest holds the scanner\'s changes for review');
		expect(setting('Scan mode for your space').desc).toContain('no screen to review them yet');
		expect(setting('Scan mode for your space').desc).toContain('Auto writes them');
		expect(control('Base metadata').value).toBe(true);
		expect(button('Add base metadata to existing notes')).toBeDefined();
		expect(host.brain.calls).toEqual(['scan settings', 'spaces']);
	});

	it('is not shown by a server without scan settings, nor while not paired', async () => {
		const { names, api } = await brain((api) => {
			api.fail.scanSettings = new ApiError('not-found', 404);
		});
		expect(names()).not.toContain('Brain');
		expect(api.calls).toEqual(['scan settings']);

		const host = new FakeHost();
		host.brain = new FakeBrainApi();
		const view = render(host);
		await flush();
		expect(view.items().some((i) => i.name === 'Brain')).toBe(false);
		expect(host.brain.calls).toEqual([]);
	});

	it('turns the person\'s switch on, and says when the server has scanning off', async () => {
		const { control, setting, api } = await brain((api) => {
			api.scan.operatorEnabled = false;
		});
		expect(setting('Scan my notes automatically').desc).toContain('turned off on this server');
		await control('Scan my notes automatically').change(true);
		expect(api.calls).toContain('scan true');
		expect(control('Scan my notes automatically').value).toBe(true);
	});

	it('changes the scan mode of the synced space', async () => {
		const { control, api } = await brain();
		await control('Scan mode for your space').change('auto');
		expect(api.calls).toContain('mode s1 auto');
		expect(control('Scan mode for your space').value).toBe('auto');
	});

	it('offers a space only its owner can change to nobody else', async () => {
		const { names } = await brain((api) => {
			api.spaces[0]!.role = 'editor';
		});
		expect(names()).toContain('Scan my notes automatically');
		expect(names()).not.toContain('Scan mode for your space');
		expect(names()).not.toContain('Base metadata');
	});

	it('hides the owner controls when the server refuses them', async () => {
		const { control, names, texts, api } = await brain((api) => {
			api.fail.setScanMode = new ApiError('forbidden', 403);
		});
		await control('Scan mode for your space').change('suggest');
		expect(names()).toContain('Scan my notes automatically');
		expect(names()).not.toContain('Scan mode for your space');
		expect(names()).not.toContain('Base metadata');
		expect(texts()).toContain("Only the space's owner can change this.");
		expect(api.spaces[0]?.scanMode).toBe('off');
	});

	it('leaves base metadata out for a server without it', async () => {
		const before = await brain((api) => {
			api.spaces[0]!.baseMetadata = null;
		});
		expect(before.names()).toContain('Scan mode for your space');
		expect(before.names()).not.toContain('Base metadata');

		const after = await brain((api) => {
			api.fail.setBaseMetadata = new ApiError('not-found', 404);
		});
		await after.control('Base metadata').change(false);
		expect(after.names()).toContain('Scan mode for your space');
		expect(after.names()).not.toContain('Base metadata');
		expect(after.names()).not.toContain('Existing notes');
		expect(after.items().filter((i) => i.cls === 'stoasis-error')).toEqual([]);
	});

	it('offers to stamp older notes only while base metadata is on and not asked for yet', async () => {
		const { control, button, setting, names, api } = await brain();
		await button('Add base metadata to existing notes').click();
		expect(api.calls).toContain('backfill s1');
		expect(setting('Existing notes').desc).toContain('being added');
		expect(() => button('Add base metadata to existing notes')).toThrow();

		await control('Base metadata').change(false);
		expect(api.calls).toContain('base s1 false');
		expect(control('Base metadata').value).toBe(false);
		expect(names()).not.toContain('Existing notes');

		await control('Base metadata').change(true);
		expect(button('Add base metadata to existing notes')).toBeDefined();
	});

	it('reads the space again after an empty answer to the backfill, and shows it as asked for', async () => {
		const { button, setting, control, api } = await brain();
		api.spaces[0]!.scanMode = 'auto';
		api.calls = [];
		await button('Add base metadata to existing notes').click();
		expect(api.calls).toEqual(['backfill s1', 'spaces']);
		expect(setting('Existing notes').desc).toContain('being added');
		expect(control('Scan mode for your space').value).toBe('auto');
	});

	it('shows the backfill as asked for when the space cannot be read again after an empty answer', async () => {
		const { button, setting, texts, api } = await brain();
		api.fail.listSpaces = new ApiError('network', 0);
		await button('Add base metadata to existing notes').click();
		expect(setting('Existing notes').desc).toContain('being added');
		expect(texts()).not.toContain("Couldn't reach the server. Nothing was changed.");
	});

	it('shows the switch as off when the server says base metadata was turned off meanwhile', async () => {
		const { button, control, names, texts } = await brain((api) => {
			api.fail.requestBaseBackfill = new ApiError('base-metadata-off', 409);
		});
		await button('Add base metadata to existing notes').click();
		expect(texts()).toContain('Base metadata is turned off for this space.');
		expect(control('Base metadata').value).toBe(false);
		expect(names()).not.toContain('Existing notes');
	});

	it("says it couldn't reach the server and leaves the controls as they were", async () => {
		const { control, texts, api } = await brain((api) => {
			api.fail.setScanEnabled = new ApiError('network', 0);
			api.fail.setScanMode = new ApiError('network', 0);
		});
		await control('Scan my notes automatically').change(true);
		expect(texts()).toContain("Couldn't reach the server. Nothing was changed.");
		expect(control('Scan my notes automatically').value).toBe(false);
		await control('Scan mode for your space').change('auto');
		expect(control('Scan mode for your space').value).toBe('off');
		expect(control('Base metadata').value).toBe(true);
		expect(api.scan.scanEnabled).toBe(false);
	});

	it('tries again after failing to load', async () => {
		const { setting, button, names, api } = await brain((api) => {
			api.fail.scanSettings = new ApiError('network', 0);
		});
		expect(setting('Not loaded').desc).toBe("Couldn't reach the server.");
		delete api.fail.scanSettings;
		await button('Try again').click();
		await flush();
		expect(names()).toContain('Scan my notes automatically');
	});

	it('shows only the switch until a space is known, and asks again each time the tab opens', async () => {
		const { tab, names, api, host } = await brain((_, host) => {
			host.settings.spaceId = '';
		});
		expect(names()).toContain('Scan my notes automatically');
		expect(names()).not.toContain('Scan mode for your space');
		expect(api.calls).toEqual(['scan settings']);

		tab.display();
		await flush();
		expect(api.calls).toEqual(['scan settings']);

		tab.hide();
		host.settings.spaceId = 's1';
		tab.display();
		await flush();
		expect(api.calls).toEqual(['scan settings', 'scan settings', 'spaces']);
		expect(names()).toContain('Scan mode for your space');
	});
});

describe('Brain, with an answer to a change that arrives after a reload', () => {
	/** An API whose owner-only changes answer only when told to. */
	function delayed() {
		const api = new FakeBrainApi();
		api.spaces.push({ ...api.spaces[0]!, id: 's2', name: 'Other' });
		const held: Array<(error: ApiError) => void> = [];
		const hold = () => new Promise<Space>((_, reject) => held.push(reject));
		api.setScanMode = (spaceId, mode) => {
			api.calls.push(`mode ${spaceId} ${mode}`);
			return hold();
		};
		api.setBaseMetadata = (spaceId, enabled) => {
			api.calls.push(`base ${spaceId} ${enabled}`);
			return hold();
		};
		return { api, refuse: (error: ApiError) => held.shift()!(error) };
	}

	for (const [what, error, change] of [
		['403', new ApiError('forbidden', 403), (brain: Brain, api: BrainApi) => brain.setScanMode(api, 'auto')],
		['404', new ApiError('not-found', 404), (brain: Brain, api: BrainApi) => brain.setBaseMetadata(api, false)],
	] as const) {
		it(`keeps the owner controls of the space loaded since, after a late ${what}`, async () => {
			const { api, refuse } = delayed();
			const brain = new Brain(() => {});
			await brain.load(api, 'key', 's1');
			const pending = change(brain, api);
			await brain.load(api, 'key', 's2');
			refuse(error);
			await pending;

			expect(brain.view).toMatchObject({ kind: 'ready', owner: true, baseMetadata: true, message: '' });
			expect(brain.view.kind === 'ready' && brain.view.space?.id).toBe('s2');

			// A change made since is not blocked, and nothing of the late answer is left.
			await brain.setScanEnabled(api, true);
			expect(api.calls).toContain('scan true');
			expect(brain.view).toMatchObject({ kind: 'ready', owner: true, baseMetadata: true });
		});
	}

	it('takes a change on the space loaded since while the earlier one is still waiting', async () => {
		const { api, refuse } = delayed();
		const brain = new Brain(() => {});
		await brain.load(api, 'key', 's1');
		const first = brain.setScanMode(api, 'auto');
		await brain.load(api, 'key', 's1', true);
		const second = brain.setScanMode(api, 'suggest');
		expect(api.calls.filter((c) => c.startsWith('mode'))).toEqual(['mode s1 auto', 'mode s1 suggest']);
		refuse(new ApiError('forbidden', 403));
		await first;
		expect(brain.view).toMatchObject({ kind: 'ready', owner: true });
		refuse(new ApiError('forbidden', 403));
		await second;
		expect(brain.view).toMatchObject({ kind: 'ready', owner: false, message: "Only the space's owner can change this." });
	});
});
