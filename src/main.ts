import { Notice, Plugin } from 'obsidian';
import {
	PROTOCOL_ACTION,
	parsePairingParams,
	type PairingRequest,
} from './protocol';
import {
	DEFAULT_SETTINGS,
	StoasisSettingTab,
	describePairingState,
	getPairingState,
	parseSettings,
	type StoasisSettings,
} from './settings';

export default class StoasisPlugin extends Plugin {
	settings: StoasisSettings = { ...DEFAULT_SETTINGS };

	/** A received pairing link, kept in memory only until pairing exists. */
	pendingPairing: PairingRequest | null = null;

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new StoasisSettingTab(this.app, this));

		const statusEl = this.addStatusBarItem();
		statusEl.addClass('stoasis-status');
		statusEl.setText(
			`Stoasis: ${describePairingState(getPairingState(this.settings)).toLowerCase()}`,
		);

		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
			this.handlePairingLink(params);
		});
	}

	private handlePairingLink(params: Record<string, string | undefined>) {
		const result = parsePairingParams(params);
		if (!result.ok) {
			new Notice('This pairing link is not valid.');
			return;
		}
		this.pendingPairing = result.request;
		new Notice('Pairing is not available in this version yet.');
	}

	async loadSettings() {
		this.settings = parseSettings(await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
