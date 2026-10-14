import { App, PluginSettingTab, Setting } from 'obsidian';
import type StoaPlugin from './main';

export interface StoaSettings {
	/** Server address once paired; empty while the device is not paired. */
	serverUrl: string;
}

export const DEFAULT_SETTINGS: StoaSettings = {
	serverUrl: '',
};

/**
 * Builds settings from the plugin's stored data, keeping only known fields of
 * the expected type, so a damaged or hand-edited data file cannot break the
 * plugin.
 */
export function parseSettings(data: unknown): StoaSettings {
	const settings: StoaSettings = { ...DEFAULT_SETTINGS };
	if (typeof data !== 'object' || data === null) {
		return settings;
	}
	const stored = data as Record<string, unknown>;
	if (typeof stored['serverUrl'] === 'string') {
		settings.serverUrl = stored['serverUrl'];
	}
	return settings;
}

export type PairingState = 'not-paired';

/** Pairing is not implemented yet, so a device is never paired. */
export function getPairingState(_settings: StoaSettings): PairingState {
	return 'not-paired';
}

export function describePairingState(state: PairingState): string {
	switch (state) {
		case 'not-paired':
			return 'Not paired';
	}
}

export class StoaSettingTab extends PluginSettingTab {
	plugin: StoaPlugin;

	constructor(app: App, plugin: StoaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const state = getPairingState(this.plugin.settings);
		new Setting(containerEl)
			.setName('Status')
			.setDesc(describePairingState(state));

		new Setting(containerEl).setName('Network and privacy').setHeading();
		containerEl.createEl('p', {
			cls: 'stoa-disclosure',
			text:
				'This plugin needs an account on a compatible server. ' +
				'It only contacts the server you pair it with, and sends note ' +
				'content only for the notes you choose to sync or tag. ' +
				'There is no telemetry and no self-update. ' +
				'Pairing and syncing are not available in this version yet.',
		});
	}
}
