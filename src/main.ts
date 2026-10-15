import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import { ApiError, NotesApi } from './api';
import { syncedEditors } from './editor';
import { obsidianHttp } from './http';
import { PairModal } from './pair-modal';
import { describeApiError, pairDevice, personalSpace, PairingError } from './pairing';
import {
	PROTOCOL_ACTION,
	parseManualPairing,
	parsePairingParams,
	syncSocketUrl,
	type PairingRejection,
	type PairingRequest,
} from './protocol';
import {
	DEFAULT_SETTINGS,
	StoasisSettingTab,
	getPairingState,
	parseSettings,
	type SettingsHost,
	type StoasisSettings,
} from './settings';
import { describeStatus, explainStatus, type SyncSnapshot } from './status';
import { EditorSync } from './sync/binding';
import { spaceDocName, type ConnectionState } from './sync/docs';
import { emptyEngineState, SyncEngine } from './sync/engine';
import { HocuspocusDocSource, SyncAccessError, type SyncAccess } from './sync/hocuspocus';
import { indexedDbStores } from './sync/idb';
import { checkCompatibility, describeIncompatibility } from './version';
import { obsidianVault } from './vault';

/** How long to wait before saving after the sync state changed. */
const SAVE_DELAY_MS = 2000;
/** How long to wait before checking a folder after folders were moved or deleted. */
const RESCAN_DELAY_MS = 2000;
/** How long to wait before retrying when the space could not be loaded. */
const SPACE_RETRY_MS = 30_000;

interface Session {
	source: HocuspocusDocSource;
	engine: SyncEngine;
}

export default class StoasisPlugin extends Plugin implements SettingsHost {
	settings: StoasisSettings = parseSettings(null);

	private session: Session | null = null;
	private readonly editors = new EditorSync();
	private statusEl: HTMLElement | null = null;
	private settingTab: StoasisSettingTab | null = null;
	/** Starts and stops run one at a time, in order. */
	private lifecycle: Promise<void> = Promise.resolve();
	private saveTimer: number | null = null;
	private rescanTimer: number | null = null;
	private retryTimer: number | null = null;
	private lastConnection: ConnectionState | null = null;
	private incompatibility = '';
	private unloaded = false;

	async onload() {
		await this.loadSettings();
		if (this.settings.installId === '') {
			this.settings.installId = crypto.randomUUID();
			await this.saveSettings();
		}

		this.settingTab = new StoasisSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('stoasis-status');
		this.updateStatus();

		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
			this.handlePairingLink(params);
		});
		this.registerEditorExtension(syncedEditors(this.editors));

		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) {
				return;
			}
			this.registerVaultEvents();
			this.restartSync();
		});
	}

	onunload() {
		this.unloaded = true;
		for (const timer of [this.saveTimer, this.rescanTimer, this.retryTimer]) {
			if (timer !== null) {
				window.clearTimeout(timer);
			}
		}
		// Stop the running session now, and any session a start still in
		// progress creates once it finishes.
		void this.stopSession();
		void this.stopSync().then(() => this.saveSettings());
	}

	// Settings tab host.

	status(): SyncSnapshot {
		const session = this.session;
		return {
			paired: getPairingState(this.settings) === 'paired',
			configured: this.settings.folder !== '' && this.settings.syncEnabled,
			connection: session === null ? null : session.source.state,
			pending: session === null ? 0 : session.source.pending,
			ready: session !== null && session.engine.ready,
		};
	}

	defaultDeviceLabel(): string {
		if (Platform.isIosApp) {
			return 'Obsidian on iPhone or iPad';
		}
		if (Platform.isAndroidApp) {
			return 'Obsidian on Android';
		}
		if (Platform.isMacOS) {
			return 'Obsidian on Mac';
		}
		if (Platform.isWin) {
			return 'Obsidian on Windows';
		}
		return 'Obsidian on Linux';
	}

	folders(): string[] {
		const configDir = this.app.vault.configDir;
		return this.app.vault
			.getAllFolders(false)
			.map((folder) => folder.path)
			.filter((path) => path !== configDir && !path.startsWith(`${configDir}/`))
			.sort((a, b) => a.localeCompare(b));
	}

	async pair(server: string, code: string, deviceLabel: string): Promise<boolean> {
		const parsed = parseManualPairing(server, code);
		if (!parsed.ok) {
			new Notice(describeRejection(parsed.reason));
			return false;
		}
		return this.pairWith(parsed.request, deviceLabel);
	}

	async unpair(): Promise<void> {
		await this.stopSync();
		const { serverUrl, deviceKey, keyId } = this.settings;
		if (serverUrl !== '' && deviceKey !== '' && keyId !== '') {
			try {
				await new NotesApi(obsidianHttp, serverUrl, deviceKey).revokeDevice(keyId);
			} catch {
				// The key is forgotten here either way; the server lists it until removed there.
			}
		}
		this.forgetPairing();
		await this.saveSettings();
		this.updateStatus();
		new Notice('This device is no longer paired.');
	}

	async setFolder(folder: string, create: boolean): Promise<void> {
		if (folder === this.settings.folder) {
			return;
		}
		await this.stopSync();
		if (create && this.app.vault.getAbstractFileByPath(folder) === null) {
			await this.app.vault.createFolder(folder);
		}
		this.settings.folder = folder;
		// What the engine knew was about the old folder.
		this.settings.sync = emptyEngineState();
		await this.saveSettings();
		this.restartSync();
	}

	async setSyncEnabled(enabled: boolean): Promise<void> {
		this.settings.syncEnabled = enabled;
		await this.saveSettings();
		if (enabled) {
			this.restartSync();
		} else {
			await this.stopSync();
		}
	}

	// Pairing.

	private handlePairingLink(params: Record<string, string | undefined>) {
		const result = parsePairingParams(params);
		if (!result.ok) {
			new Notice('This pairing link is not valid.');
			return;
		}
		const current = getPairingState(this.settings) === 'paired' ? this.settings.serverUrl : '';
		new PairModal(this.app, result.request, this.defaultDeviceLabel(), current, (label) =>
			this.pairWith(result.request, label),
		).open();
	}

	private async pairWith(request: PairingRequest, deviceLabel: string): Promise<boolean> {
		const api = new NotesApi(obsidianHttp, request.server);
		let pairing;
		try {
			pairing = await pairDevice(api, request, deviceLabel, this.manifest.version);
		} catch (error) {
			new Notice(error instanceof PairingError ? error.message : describeApiError(error));
			return false;
		}

		await this.stopSync();
		const sameServer = pairing.serverUrl === this.settings.serverUrl;
		if (!sameServer) {
			this.forgetPairing();
		}
		Object.assign(this.settings, pairing);
		await this.loadSpace();
		await this.saveSettings();

		const who = pairing.personName === '' ? '' : ` as ${pairing.personName}`;
		new Notice(
			this.settings.folder === ''
				? `Paired${who}. Choose a folder to sync in the Stoasis settings.`
				: `Paired${who}.`,
		);
		this.settingTab?.display();
		this.restartSync();
		return true;
	}

	private forgetPairing(): void {
		const { installId, folder } = this.settings;
		this.settings = { ...DEFAULT_SETTINGS, sync: emptyEngineState(), installId, folder };
		this.incompatibility = '';
	}

	/** Finds the personal space. Returns false when the server could not tell. */
	private async loadSpace(): Promise<boolean> {
		const api = new NotesApi(obsidianHttp, this.settings.serverUrl, this.settings.deviceKey);
		try {
			const space = await personalSpace(api);
			if (space.id !== this.settings.spaceId) {
				this.settings.spaceId = space.id;
				this.settings.sync = emptyEngineState();
			}
			this.settings.spaceName = space.name;
			return true;
		} catch (error) {
			if (error instanceof ApiError && error.kind === 'unauthenticated') {
				this.incompatibility = '';
				new Notice(describeApiError(error));
			}
			return false;
		}
	}

	// Sync.

	private restartSync(): void {
		void this.inLifecycle(async () => {
			await this.stopSession();
			await this.startSession();
		});
	}

	private stopSync(): Promise<void> {
		return this.inLifecycle(() => this.stopSession());
	}

	/** Runs session changes one after another; one failing does not stop the next. */
	private inLifecycle(step: () => Promise<void>): Promise<void> {
		this.lifecycle = this.lifecycle.then(step).catch((error: unknown) => {
			new Notice(`Stoasis could not start sync: ${error instanceof Error ? error.message : String(error)}`);
		});
		return this.lifecycle;
	}

	private async startSession(): Promise<void> {
		const settings = this.settings;
		if (this.unloaded || getPairingState(settings) !== 'paired' || settings.folder === '' || !settings.syncEnabled) {
			this.updateStatus();
			return;
		}
		if (!(this.app.vault.getAbstractFileByPath(settings.folder) instanceof TFolder)) {
			new Notice(`The folder "${settings.folder}" no longer exists, so sync is paused. Choose a folder in the Stoasis settings.`);
			settings.syncEnabled = false;
			await this.saveSettings();
			this.updateStatus();
			return;
		}
		if (settings.spaceId === '') {
			if (!(await this.loadSpace())) {
				this.retryTimer = window.setTimeout(() => {
					this.retryTimer = null;
					this.restartSync();
				}, SPACE_RETRY_MS);
				this.updateStatus();
				return;
			}
			await this.saveSettings();
		}
		if (this.unloaded) {
			return;
		}

		const source = new HocuspocusDocSource({
			url: syncSocketUrl(settings.serverUrl),
			access: this.syncAccess(settings),
			stores: indexedDbStores(`stoasis-${settings.installId}`),
			primary: spaceDocName(settings.spaceId),
		});
		const engine = new SyncEngine({
			vault: obsidianVault(this.app),
			source,
			spaceId: settings.spaceId,
			folder: settings.folder,
			state: settings.sync,
			saveState: () => this.saveSoon(),
			onProblem: (message) => new Notice(message),
			onTracked: () => this.editors.refresh(),
		});
		const session: Session = { source, engine };
		this.session = session;
		source.onChange(() => this.updateStatus());
		source.start();
		this.updateStatus();
		await engine.start();
		if (this.session === session) {
			this.editors.setLinker(engine);
			this.updateStatus();
		}
	}

	private async stopSession(): Promise<void> {
		if (this.retryTimer !== null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		const session = this.session;
		if (session === null) {
			return;
		}
		this.session = null;
		this.editors.setLinker(null);
		await session.engine.stop();
		await session.source.destroy();
		this.lastConnection = null;
		this.updateStatus();
	}

	/** Checks the server still accepts this plugin, then gets a fresh sync token. */
	private syncAccess(settings: StoasisSettings): SyncAccess {
		const api = new NotesApi(obsidianHttp, settings.serverUrl, settings.deviceKey);
		return async () => {
			try {
				const compatibility = checkCompatibility(await api.version(), this.manifest.version);
				if (!compatibility.ok) {
					this.incompatibility = describeIncompatibility(compatibility);
					throw new SyncAccessError('outdated');
				}
				return (await api.syncToken()).token;
			} catch (error) {
				if (error instanceof SyncAccessError) {
					throw error;
				}
				if (error instanceof ApiError && (error.kind === 'unauthenticated' || error.kind === 'forbidden')) {
					throw new SyncAccessError('refused');
				}
				throw new SyncAccessError('network');
			}
		};
	}

	private registerVaultEvents(): void {
		const vault = this.app.vault;
		this.registerEvent(
			vault.on('create', (file) => {
				if (file instanceof TFile) {
					this.session?.engine.fileCreated(file.path);
				}
			}),
		);
		this.registerEvent(
			vault.on('modify', (file) => {
				if (file instanceof TFile) {
					this.session?.engine.fileModified(file.path);
				}
			}),
		);
		this.registerEvent(
			vault.on('delete', (file) => {
				if (file instanceof TFile) {
					this.session?.engine.fileDeleted(file.path);
				} else {
					this.folderDeleted(file);
				}
			}),
		);
		this.registerEvent(
			vault.on('rename', (file, oldPath) => {
				if (file instanceof TFile) {
					this.session?.engine.fileRenamed(file.path, oldPath);
				} else {
					this.folderRenamed(file, oldPath);
				}
			}),
		);
	}

	private folderRenamed(folder: TAbstractFile, oldPath: string): void {
		const mapped = this.settings.folder;
		if (mapped === '') {
			return;
		}
		if (mapped === oldPath || mapped.startsWith(`${oldPath}/`)) {
			// The synced folder itself moved: follow it.
			const moved = folder.path + mapped.slice(oldPath.length);
			this.settings.folder = moved;
			this.session?.engine.folderMoved(moved);
			this.saveSoon();
			this.settingTab?.display();
		} else if (oldPath.startsWith(`${mapped}/`) || folder.path.startsWith(`${mapped}/`)) {
			this.rescanSoon();
		}
	}

	private folderDeleted(folder: TAbstractFile): void {
		const mapped = this.settings.folder;
		if (mapped === '') {
			return;
		}
		if (mapped === folder.path || mapped.startsWith(`${folder.path}/`)) {
			// Deleting the synced folder must not delete the notes on every
			// device: stop before the engine handles the files inside it.
			void this.session?.engine.stop();
			this.restartSync();
		} else if (folder.path.startsWith(`${mapped}/`)) {
			this.rescanSoon();
		}
	}

	private rescanSoon(): void {
		if (this.rescanTimer !== null) {
			window.clearTimeout(this.rescanTimer);
		}
		this.rescanTimer = window.setTimeout(() => {
			this.rescanTimer = null;
			this.session?.engine.rescan();
		}, RESCAN_DELAY_MS);
	}

	// Status.

	private updateStatus(): void {
		const snapshot = this.status();
		if (snapshot.connection !== this.lastConnection) {
			this.lastConnection = snapshot.connection;
			if (snapshot.connection === 'outdated') {
				new Notice(this.incompatibility || explainStatus(snapshot));
			} else if (snapshot.connection === 'refused') {
				new Notice('The server no longer accepts this device. Pair it again in the plugin settings.');
			}
		}
		if (this.statusEl !== null) {
			this.statusEl.setText(describeStatus(snapshot));
			this.statusEl.setAttribute(
				'aria-label',
				snapshot.connection === 'outdated' && this.incompatibility !== ''
					? this.incompatibility
					: explainStatus(snapshot),
			);
		}
	}

	// Storage.

	async loadSettings() {
		this.settings = parseSettings(await this.loadData());
	}

	async saveSettings() {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		await this.saveData(this.settings);
	}

	private saveSoon(): void {
		if (this.saveTimer === null) {
			this.saveTimer = window.setTimeout(() => {
				this.saveTimer = null;
				void this.saveSettings();
			}, SAVE_DELAY_MS);
		}
	}
}

function describeRejection(reason: PairingRejection): string {
	switch (reason) {
		case 'missing-server':
			return 'Enter the server address.';
		case 'missing-code':
			return 'Enter the pairing code.';
		case 'invalid-server':
			return 'The server address is not valid.';
		case 'insecure-server':
			return 'The server address must start with https://.';
		case 'invalid-code':
			return 'This pairing code is not valid. Check it and try again.';
	}
}
