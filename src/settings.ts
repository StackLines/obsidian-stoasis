import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { MAX_DEVICE_LABEL } from './pairing';
import { explainStatus, type SyncSnapshot } from './status';
import { emptyEngineState, parseEngineState, type EngineState } from './sync/engine';

export interface StoasisSettings {
	/** Server address once paired; empty while the device is not paired. */
	serverUrl: string;
	/** Device key from pairing. It can reach the notes API and nothing else. */
	deviceKey: string;
	keyId: string;
	deviceLabel: string;
	/** Name of the person the device was paired for, as the server reported it. */
	personName: string;
	/** The personal space synced with `folder`. */
	spaceId: string;
	spaceName: string;
	/** Vault folder the space is synced with; empty until chosen. */
	folder: string;
	syncEnabled: boolean;
	/** Random id naming this vault's local sync storage on the device. */
	installId: string;
	/** What the sync engine remembers between sessions. */
	sync: EngineState;
}

export const DEFAULT_SETTINGS: Readonly<StoasisSettings> = {
	serverUrl: '',
	deviceKey: '',
	keyId: '',
	deviceLabel: '',
	personName: '',
	spaceId: '',
	spaceName: '',
	folder: '',
	syncEnabled: false,
	installId: '',
	sync: emptyEngineState(),
};

const STRING_FIELDS = [
	'serverUrl',
	'deviceKey',
	'keyId',
	'deviceLabel',
	'personName',
	'spaceId',
	'spaceName',
	'folder',
	'installId',
] as const;

/**
 * Builds settings from the plugin's stored data, keeping only known fields of
 * the expected type, so a damaged or hand-edited data file cannot break the
 * plugin.
 */
export function parseSettings(data: unknown): StoasisSettings {
	const settings: StoasisSettings = { ...DEFAULT_SETTINGS, sync: emptyEngineState() };
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
	settings.syncEnabled = stored['syncEnabled'] === true;
	settings.sync = parseEngineState(stored['sync']);
	return settings;
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

/** Name of the folder offered when the vault has none to choose yet. */
export const SUGGESTED_FOLDER = 'Stoasis';
// No real folder path starts with a slash.
const NEW_FOLDER = '/new';

/** What the settings tab needs from the plugin. */
export interface SettingsHost extends Plugin {
	settings: StoasisSettings;
	status(): SyncSnapshot;
	defaultDeviceLabel(): string;
	/** Folders of the vault, outside the configuration folder, sorted. */
	folders(): string[];
	pair(server: string, code: string, deviceLabel: string): Promise<boolean>;
	unpair(): Promise<void>;
	setFolder(folder: string, create: boolean): Promise<void>;
	setSyncEnabled(enabled: boolean): Promise<void>;
}

export class StoasisSettingTab extends PluginSettingTab {
	plugin: SettingsHost;
	private draft = { server: '', code: '', label: '' };

	constructor(app: App, plugin: SettingsHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;
		const paired = getPairingState(settings) === 'paired';

		new Setting(containerEl).setName('Status').setDesc(explainStatus(this.plugin.status()));

		if (paired) {
			this.showPaired();
			this.showSync();
		} else {
			this.showPairing();
		}

		new Setting(containerEl).setName('Network and privacy').setHeading();
		containerEl.createEl('p', {
			cls: 'stoasis-disclosure',
			text:
				'This plugin needs an account on a compatible server. ' +
				'It only contacts the server you pair it with, and sends note ' +
				'content only for the folder you choose to sync. ' +
				'The device key from pairing is kept in this vault\'s plugin data; ' +
				'it can reach your notes and nothing else on the server. ' +
				'There is no telemetry and no self-update.',
		});
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

		new Setting(containerEl)
			.setName('Space')
			.setDesc(
				settings.spaceId === ''
					? 'Your personal space is loaded when the server can be reached.'
					: `Your personal space${settings.spaceName === '' ? '' : `, "${settings.spaceName}"`}.`,
			);

		const folders = this.plugin.folders();
		new Setting(containerEl)
			.setName('Folder')
			.setDesc(
				'Notes in this folder and its subfolders sync with the space. ' +
					'Choosing another folder merges its notes into the space.',
			)
			.addDropdown((dropdown) => {
				dropdown.addOption('', 'Choose a folder');
				if (!folders.includes(SUGGESTED_FOLDER)) {
					dropdown.addOption(NEW_FOLDER, `New folder: ${SUGGESTED_FOLDER}`);
				}
				for (const folder of folders) {
					dropdown.addOption(folder, folder);
				}
				dropdown.setValue(settings.folder).onChange(async (value) => {
					if (value === NEW_FOLDER) {
						await this.plugin.setFolder(SUGGESTED_FOLDER, true);
					} else if (value !== '') {
						await this.plugin.setFolder(value, false);
					}
					this.display();
				});
			});

		new Setting(containerEl)
			.setName('Sync this folder')
			.setDesc('Keep the folder in step with the space on all your devices.')
			.addToggle((toggle) =>
				toggle
					.setValue(settings.syncEnabled)
					.setDisabled(settings.folder === '')
					.onChange(async (value) => {
						await this.plugin.setSyncEnabled(value);
						this.display();
					}),
			);
	}
}
