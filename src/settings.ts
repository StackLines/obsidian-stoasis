import { describeUsage } from './usage';
import { describeScanStatus } from './scan-status';
import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import type { ScanMode } from './api';
import { Brain, describeScanModes, type BrainApi } from './brain';
import { MAX_DEVICE_LABEL } from './pairing';
import { emptyActivity, parseActivity, type ActivityData } from './activity';
import { explainStatus, type SyncSnapshot } from './status';
import { emptyEngineState, parseEngineState, type EngineState } from './sync/engine';
import { folderMapping, WHOLE_VAULT, type Mapping } from './sync/paths';

export interface StoasisSettings {
	/** Server address once paired; empty while the device is not paired. */
	serverUrl: string;
	/** Device key from pairing. It can reach the notes API and nothing else. */
	deviceKey: string;
	keyId: string;
	deviceLabel: string;
	/** Name of the person the device was paired for, as the server reported it. */
	personName: string;
	/** The personal space synced with `mapping`. */
	spaceId: string;
	spaceName: string;
	/** What the space is synced with, a folder or the whole vault; null until chosen. */
	mapping: Mapping | null;
	syncEnabled: boolean;
	/** Random id naming this vault's local sync storage on the device. */
	installId: string;
	/** What the sync engine remembers between sessions. */
	sync: EngineState;
	/** Keys the server could not be told to revoke on disconnecting; retried. */
	pendingRevocations: PendingRevocation[];
	/** Folder warnings already shown, as `warningKey` makes them. */
	folderWarnings: string[];
	/** What synced lately and when the server was last reached; names and paths only. */
	activity: ActivityData;
}

export interface PendingRevocation {
	serverUrl: string;
	deviceKey: string;
	keyId: string;
}

export const DEFAULT_SETTINGS: Readonly<StoasisSettings> = {
	serverUrl: '',
	deviceKey: '',
	keyId: '',
	deviceLabel: '',
	personName: '',
	spaceId: '',
	spaceName: '',
	mapping: null,
	syncEnabled: false,
	installId: '',
	sync: emptyEngineState(),
	pendingRevocations: [],
	folderWarnings: [],
	activity: emptyActivity(),
};

const STRING_FIELDS = [
	'serverUrl',
	'deviceKey',
	'keyId',
	'deviceLabel',
	'personName',
	'spaceId',
	'spaceName',
	'installId',
] as const;

/**
 * Builds settings from the plugin's stored data, keeping only known fields of
 * the expected type, so a damaged or hand-edited data file cannot break the
 * plugin.
 */
export function parseSettings(data: unknown): StoasisSettings {
	const settings: StoasisSettings = {
		...DEFAULT_SETTINGS,
		sync: emptyEngineState(),
		pendingRevocations: [],
		folderWarnings: [],
		activity: emptyActivity(),
	};
	if (typeof data !== 'object' || data === null) {
		return settings;
	}
	const stored = data as Record<string, unknown>;
	for (const field of STRING_FIELDS) {
		const value = stored[field];
		if (typeof value === 'string') {
			settings[field] = value;
		}
	}
	settings.mapping = parseMapping(stored['mapping'], stored['folder']);
	settings.activity = parseActivity(stored['activity']);
	settings.syncEnabled = stored['syncEnabled'] === true;
	settings.sync = parseEngineState(stored['sync']);
	const warnings = stored['folderWarnings'];
	if (Array.isArray(warnings)) {
		settings.folderWarnings = [...new Set((warnings as unknown[]).filter((w): w is string => typeof w === 'string'))];
	}
	const list = stored['pendingRevocations'];
	// Version 0.1.0 before its release kept one key, as `pendingRevocation`.
	const values: unknown[] = Array.isArray(list) ? [...(list as unknown[])] : [];
	for (const value of [...values, stored['pendingRevocation']]) {
		const pending = parsePendingRevocation(value);
		if (pending !== null) {
			addPendingRevocation(settings.pendingRevocations, pending);
		}
	}
	return settings;
}

/**
 * The stored mapping. Before 0.3 a folder path was kept as `folder`, empty
 * for none, and it stays what it was; an unusable value maps nothing.
 */
function parseMapping(mapping: unknown, legacyFolder: unknown): Mapping | null {
	if (typeof mapping === 'object' && mapping !== null) {
		const { kind, path } = mapping as Record<string, unknown>;
		if (kind === 'vault') {
			return WHOLE_VAULT;
		}
		if (kind === 'folder' && typeof path === 'string' && path !== '') {
			return folderMapping(path);
		}
		return null;
	}
	return typeof legacyFolder === 'string' && legacyFolder !== '' ? folderMapping(legacyFolder) : null;
}

/** Whether two pending revocations are for the same key. */
export function sameKey(a: PendingRevocation, b: PendingRevocation): boolean {
	return a.serverUrl === b.serverUrl && a.keyId === b.keyId;
}

/** Adds a key to revoke to `list`, unless it is there already. */
export function addPendingRevocation(list: PendingRevocation[], pending: PendingRevocation): void {
	if (!list.some((other) => sameKey(other, pending))) {
		list.push(pending);
	}
}

function parsePendingRevocation(value: unknown): PendingRevocation | null {
	if (typeof value !== 'object' || value === null) {
		return null;
	}
	const { serverUrl, deviceKey, keyId } = value as Record<string, unknown>;
	if (typeof serverUrl !== 'string' || typeof deviceKey !== 'string' || typeof keyId !== 'string') {
		return null;
	}
	if (serverUrl === '' || deviceKey === '' || keyId === '') {
		return null;
	}
	return { serverUrl, deviceKey, keyId };
}

export type PairingState = 'not-paired' | 'paired';

export function getPairingState(settings: StoasisSettings): PairingState {
	return settings.serverUrl !== '' && settings.deviceKey !== '' ? 'paired' : 'not-paired';
}

export function describePairingState(state: PairingState): string {
	switch (state) {
		case 'not-paired':
			return 'Not paired';
		case 'paired':
			return 'Paired';
	}
}

/** Shown by the settings and the plugin where a mapping needs a name. */
export function describeMapping(mapping: Mapping): string {
	return mapping.kind === 'vault' ? 'the whole vault' : `the folder "${mapping.path}"`;
}

/** Name of the folder offered when the vault has none to choose yet. */
export const SUGGESTED_FOLDER = 'Stoasis';
// No real folder path starts with a slash.
const NEW_FOLDER = '/new';
const WHOLE_VAULT_OPTION = '/vault';

/** What the settings tab needs from the plugin. */
export interface SettingsHost extends Plugin {
	settings: StoasisSettings;
	status(): SyncSnapshot;
	defaultDeviceLabel(): string;
	/** Folders of the vault, outside the configuration folder, sorted. */
	folders(): string[];
	pair(server: string, code: string, deviceLabel: string): Promise<boolean>;
	unpair(): Promise<void>;
	/** Asks the server again to revoke the key of a disconnected device. */
	retryRevocation(): Promise<boolean>;
	setFolder(folder: string, create: boolean): Promise<void>;
	/**
	 * Maps the space to the whole vault after checking that the space can take
	 * it and asking the user to confirm; false when that did not happen.
	 */
	chooseWholeVault(): Promise<boolean>;
	setSyncEnabled(enabled: boolean): Promise<void>;
	/** The folder `downloadToDevice` would sync: a new or empty one named after the space. */
	downloadFolder(): string;
	/** Creates that folder, syncs the space with it and turns sync on. */
	downloadToDevice(): Promise<void>;
	/** The server's Brain calls with this device's key; null while not paired. */
	brainApi(): BrainApi | null;
	/** Opens the window with the last contact with the server and what synced lately. */
	showActivity(): void;
}

const SCAN_MODE_NAMES: ReadonlyArray<[ScanMode, string]> = [
	['off', 'Off'],
	['suggest', 'Suggest'],
	['auto', 'Auto'],
];

export class StoasisSettingTab extends PluginSettingTab {
	plugin: SettingsHost;
	private draft = { server: '', code: '', label: '' };
	private statusSetting: Setting | null = null;
	/** What the server said for the Brain section, asked again each time the tab opens. */
	private readonly brain = new Brain(() => this.refresh());
	/** Whether the tab is open: the app calls `display` to open it and `hide` to close it. */
	private open = false;

	constructor(app: App, plugin: SettingsHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.open = true;
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;
		const paired = getPairingState(settings) === 'paired';

		this.statusSetting = new Setting(containerEl).setName('Status').setDesc(explainStatus(this.plugin.status()));
		if (paired) {
			this.statusSetting.addButton((button) =>
				button.setButtonText('Sync history').onClick(() => this.plugin.showActivity()),
			);
		}
		if (settings.pendingRevocations.length > 0) {
			this.showPendingRevocations(settings.pendingRevocations);
		}

		if (paired) {
			this.showPaired();
			this.showSync();
			this.showBrain();
		} else {
			this.brain.reset();
			this.showPairing();
		}

		new Setting(containerEl).setName('Network and privacy').setHeading();
		containerEl.createEl('p', {
			cls: 'stoasis-disclosure',
			text:
				'This plugin needs an account on a compatible server. ' +
				'It only contacts the server you pair it with, and sends note ' +
				'content only for the folder (or the whole vault) you choose to sync, ' +
				'and for a note you tag with "Tag this note now", which the server ' +
				'does not keep. Note history asks the server for earlier versions of ' +
				'a synced note; Restore writes one back as an edit. Your space\'s ' +
				'storage and scan progress are read from the server as counts and times. ' +
				'The device key from pairing is kept in this vault\'s plugin data; ' +
				'it can reach your notes and nothing else on the server. ' +
				'There is no telemetry and no self-update.',
		});
	}

	hide(): void {
		this.open = false;
		// Ask the server again next time, for changes made on another device.
		this.brain.reset();
		super.hide();
	}

	/** Draws the tab again if it is open, for when the plugin's settings changed. */
	refresh(): void {
		if (this.open) {
			this.display();
		}
	}

	/** Shows the current sync status again, for when it changed while the tab is open. */
	refreshStatus(): void {
		this.statusSetting?.setDesc(explainStatus(this.plugin.status()));
	}

	private showPendingRevocations(pending: readonly PendingRevocation[]): void {
		const servers = [...new Set(pending.map((key) => key.serverUrl))].join(', ');
		const what =
			pending.length === 1
				? `${servers} could not be told to revoke the key of the device you disconnected, so it still works there.`
				: `${servers} could not be told to revoke the keys of ${pending.length} devices you ` +
					'disconnected, so they still work there.';
		new Setting(this.containerEl)
			.setName(pending.length === 1 ? 'Old device key' : 'Old device keys')
			.setDesc(
				`${what} Stoasis keeps trying; you can also remove ` +
					`${pending.length === 1 ? 'the device' : 'them'} from your list of devices on the server.`,
			)
			.addButton((button) =>
				button.setButtonText('Try again').onClick(async () => {
					button.setDisabled(true);
					await this.plugin.retryRevocation();
					this.display();
				}),
			);
	}

	private showPairing(): void {
		const { containerEl } = this;
		const draft = this.draft;
		if (draft.label === '') {
			draft.label = this.plugin.defaultDeviceLabel();
		}
		new Setting(containerEl)
			.setName('Pair this device')
			.setHeading();
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Open the pairing link your server shows on this device, ' +
				'or enter the server address and pairing code here.',
		});
		new Setting(containerEl)
			.setName('Server address')
			.addText((text) =>
				text
					.setPlaceholder('https://notes.example.com')
					.setValue(draft.server)
					.onChange((value) => {
						draft.server = value;
					}),
			);
		new Setting(containerEl)
			.setName('Pairing code')
			.addText((text) =>
				text.setValue(draft.code).onChange((value) => {
					draft.code = value;
				}),
			);
		new Setting(containerEl)
			.setName('Device name')
			.setDesc('Shown in your list of devices on the server.')
			.addText((text) =>
				text.setValue(draft.label).onChange((value) => {
					draft.label = value.slice(0, MAX_DEVICE_LABEL);
				}),
			);
		new Setting(containerEl).addButton((button) =>
			button
				.setButtonText('Pair')
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					const ok = await this.plugin.pair(draft.server, draft.code, draft.label);
					button.setDisabled(false);
					if (ok) {
						this.draft = { server: '', code: '', label: '' };
					}
					this.display();
				}),
		);
	}

	private showPaired(): void {
		const settings = this.plugin.settings;
		const who = settings.personName === '' ? '' : ` for ${settings.personName}`;
		new Setting(this.containerEl)
			.setName('Server')
			.setDesc(`Paired with ${settings.serverUrl}${who}, as "${settings.deviceLabel}".`)
			.addButton((button) =>
				button
					.setButtonText('Disconnect')
					.setWarning()
					.onClick(async () => {
						button.setDisabled(true);
						await this.plugin.unpair();
						this.display();
					}),
			);
	}

	private showSync(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		new Setting(containerEl).setName('Sync').setHeading();
		const mapping = settings.mapping;
		const mapped = mapping !== null;

		if (mapped) {
			new Setting(containerEl)
				.setName('Space')
				.setDesc(
					settings.spaceId === ''
						? 'Your personal space is loaded when the server can be reached.'
						: `Your personal space${settings.spaceName === '' ? '' : `, "${settings.spaceName}"`}.`,
				);
		} else {
			this.showDownload();
		}

		const folders = this.plugin.folders();
		const wholeVault = mapping?.kind === 'vault';
		new Setting(containerEl)
			.setName(mapped ? 'Folder' : 'Or sync an existing folder')
			.setDesc(
				(wholeVault
					? 'Choosing a folder downloads the space\'s notes into it and uploads the notes already there as new notes. '
					: mapped
						? 'Notes in this folder and its subfolders sync with the space. ' +
							'Choosing another folder merges its notes into the space. '
						: 'Notes in the folder you choose and its subfolders sync with the space. ' +
							'Notes already in that folder are added to the space and appear on your other devices. ') +
					'Whole vault: every Markdown note in this vault syncs, except Obsidian\'s own settings and hidden folders.',
			)
			.addDropdown((dropdown) => {
				dropdown.addOption('', 'Choose a folder');
				dropdown.addOption(WHOLE_VAULT_OPTION, 'Whole vault');
				if (mapped && !folders.includes(SUGGESTED_FOLDER)) {
					dropdown.addOption(NEW_FOLDER, `New folder: ${SUGGESTED_FOLDER}`);
				}
				for (const folder of folders) {
					dropdown.addOption(folder, folder);
				}
				dropdown
					.setValue(mapping === null ? '' : mapping.kind === 'vault' ? WHOLE_VAULT_OPTION : mapping.path)
					.onChange(async (value) => {
						if (value === WHOLE_VAULT_OPTION) {
							await this.plugin.chooseWholeVault();
						} else if (value === NEW_FOLDER) {
							await this.plugin.setFolder(SUGGESTED_FOLDER, true);
						} else if (value !== '') {
							await this.plugin.setFolder(value, false);
						}
						this.display();
					});
			});

		if (!mapped) {
			// Nothing to switch on yet; either choice above leads here.
			return;
		}
		new Setting(containerEl)
			.setName(wholeVault ? 'Sync this vault' : 'Sync this folder')
			.setDesc(
				wholeVault
					? 'Keep the vault in step with the space on all your devices.'
					: 'Keep the folder in step with the space on all your devices.',
			)
			.addToggle((toggle) =>
				toggle.setValue(settings.syncEnabled).onChange(async (value) => {
					await this.plugin.setSyncEnabled(value);
					this.display();
				}),
			);
	}

	/**
	 * The scanner's switches. The section is not shown by a server without
	 * them, and the space's controls only to its owner.
	 */
	private showBrain(): void {
		const { containerEl } = this;
		const settings = this.plugin.settings;
		const api = this.plugin.brainApi();
		const server = `${settings.serverUrl}\n${settings.deviceKey}`;
		void this.brain.load(api, server, settings.spaceId);
		const view = this.brain.view;
		if (api === null || view.kind === 'hidden' || view.kind === 'idle') {
			return;
		}
		new Setting(containerEl).setName('Brain').setHeading();
		if (view.kind === 'loading') {
			containerEl.createEl('p', { cls: 'setting-item-description', text: 'Asking the server…' });
			return;
		}
		if (view.kind === 'failed') {
			new Setting(containerEl)
				.setName('Not loaded')
				.setDesc(view.message)
				.addButton((button) =>
					button.setButtonText('Try again').onClick(async () => {
						button.setDisabled(true);
						await this.brain.load(api, server, settings.spaceId, true);
					}),
				);
			return;
		}
		if (view.message !== '') {
			containerEl.createEl('p', { cls: 'stoasis-error', text: view.message });
		}
		const operatorOff = view.scan.operatorEnabled
			? ''
			: ' Scanning is turned off on this server for now, whatever this says.';
		new Setting(containerEl)
			.setName('Scan my notes automatically')
			.setDesc(
				'Let the server read the notes in your spaces and add properties to them, ' +
					`as each space's scan mode allows.${operatorOff}`,
			)
			.addToggle((toggle) =>
				toggle.setValue(view.scan.scanEnabled).onChange(async (value) => {
					await this.brain.setScanEnabled(api, value);
				}),
			);

		const progress =
			this.brain.status === null ? [] : describeScanStatus(this.brain.status, settings.spaceId, new Date());
		if (progress.length > 0) {
			new Setting(containerEl).setName('Scan progress').setDesc(progress.join(' '));
		}

		const space = view.space;
		// Any role may read the space's usage; a server that does not report it shows nothing.
		if (space?.usage != null) {
			const { summary, warning } = describeUsage(space.usage);
			new Setting(containerEl)
				.setName('Space storage')
				.setDesc(
					`${summary}. Notes, saved versions and files.` +
						(warning === '' ? '' : ` ${warning}`),
				);
		}
		if (space === null || !view.owner) {
			return;
		}
		new Setting(containerEl)
			.setName('Scan mode for your space')
			.setDesc(describeScanModes())
			.addDropdown((dropdown) => {
				for (const [mode, name] of SCAN_MODE_NAMES) {
					dropdown.addOption(mode, name);
				}
				dropdown.setValue(space.scanMode).onChange(async (value) => {
					await this.brain.setScanMode(api, value as ScanMode);
				});
			});

		if (!view.baseMetadata) {
			return;
		}
		new Setting(containerEl)
			.setName('Base metadata')
			.setDesc(
				'Add brain-id, brain-created and brain-schema to notes created in your space ' +
					'from when this is turned on. Values already in a note are kept.',
			)
			.addToggle((toggle) =>
				toggle.setValue(space.baseMetadata === true).onChange(async (value) => {
					await this.brain.setBaseMetadata(api, value);
				}),
			);
		if (space.baseMetadata !== true) {
			return;
		}
		if (space.baseBackfillRequested) {
			new Setting(containerEl)
				.setName('Existing notes')
				.setDesc('Base metadata is being added to the notes from before, a batch at a time.');
			return;
		}
		new Setting(containerEl)
			.setName('Existing notes')
			.setDesc('Notes from before base metadata was turned on get it only when you ask.')
			.addButton((button) =>
				button.setButtonText('Add base metadata to existing notes').onClick(async () => {
					button.setDisabled(true);
					await this.brain.requestBaseBackfill(api);
				}),
			);
	}

	/** The main choice on a device that syncs no folder yet: bring the space here. */
	private showDownload(): void {
		const settings = this.plugin.settings;
		const space = settings.spaceName === '' ? 'Your space' : `Your space "${settings.spaceName}"`;
		const folder = this.plugin.downloadFolder();
		new Setting(this.containerEl)
			.setName(`${space} is on your server`)
			.setDesc(
				`Download its notes into a new folder, "${folder}", on this device ` +
					'and keep them in step with your other devices.',
			)
			.addButton((button) =>
				button
					.setButtonText('Download to this device')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						await this.plugin.downloadToDevice();
						this.display();
					}),
			);
	}
}
