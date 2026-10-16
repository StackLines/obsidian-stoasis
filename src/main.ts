import { Notice, Platform, Plugin, TAbstractFile, TFile, TFolder, type Editor } from 'obsidian';
import { ApiError, NotesApi } from './api';
import { syncedEditors } from './editor';
import { obsidianHttp } from './http';
import { PairModal } from './pair-modal';
import { folderNameFor, freeFolderName } from './folder-name';
import { describeApiError, pairDevice, personalSpace, PairingError } from './pairing';
import { DownloadProgress } from './progress';
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
	SUGGESTED_FOLDER,
	addPendingRevocation,
	getPairingState,
	parseSettings,
	sameKey,
	type PendingRevocation,
	type SettingsHost,
	type StoasisSettings,
} from './settings';
import { describeRefused, describeStatus, explainStatus, type SyncSnapshot } from './status';
import { EditorSync } from './sync/binding';
import { spaceDocName, type ConnectionState } from './sync/docs';
import { emptyEngineState, SyncEngine } from './sync/engine';
import { HocuspocusDocSource, SyncAccessError, type SyncAccess } from './sync/hocuspocus';
import { indexedDbStores } from './sync/idb';
import { checkCompatibility, describeIncompatibility } from './version';
import { obsidianVault } from './vault';
import { TagModal } from './tag-modal';
import { applyToFrontmatter, propose, stampDate, tooLongToTag } from './tagging';
import type { PropertyPatch } from './frontmatter-patch';
import { conflictOriginal, diffLines, keepTheServer, keepThisDevice } from './conflict';
import { ConflictModal } from './conflict-modal';

/** How long to wait before saving after the sync state changed. */
const SAVE_DELAY_MS = 2000;
/** How long to wait before checking a folder after folders were moved or deleted. */
const RESCAN_DELAY_MS = 2000;
/** How long to wait before retrying when the space could not be loaded. */
const SPACE_RETRY_MS = 30_000;
/** How often to ask again for the key of a disconnected device to be revoked. */
const REVOKE_RETRY_MS = 10 * 60_000;
/** How long to wait before showing how far a download has come. */
const DOWNLOAD_UPDATE_MS = 250;

interface Session {
	source: HocuspocusDocSource;
	engine: SyncEngine;
	/** Progress of the folder's first sync; null when it had one before. */
	download: DownloadProgress | null;
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
	private downloadTimer: number | null = null;
	private revokeTimer: number | null = null;
	private revoking: Promise<boolean> | null = null;
	private lastConnection: ConnectionState | null = null;
	private lastRefused = 0;
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

		this.addCommand({
			id: 'tag-note-now',
			name: 'Tag this note now',
			editorCheckCallback: (checking, editor, info) => {
				const file = info.file;
				if (file === null || file.extension !== 'md') {
					return false;
				}
				if (!checking) {
					void this.tagNote(file, editor);
				}
				return true;
			},
		});
		this.addCommand({
			id: 'compare-conflict-copy',
			name: 'Compare with the synced note',
			editorCheckCallback: (checking, _editor, info) => {
				const file = info.file;
				if (file === null || !this.isConflictCopy(file)) {
					return false;
				}
				if (!checking) {
					void this.compareConflict(file);
				}
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, info) => {
				const file = info.file;
				if (file === null || file.extension !== 'md') {
					return;
				}
				menu.addItem((item) =>
					item
						.setTitle('Tag this note now')
						.setIcon('tags')
						.onClick(() => void this.tagNote(file, editor)),
				);
				if (this.isConflictCopy(file)) {
					menu.addItem((item) =>
						item
							.setTitle('Compare with the synced note')
							.setIcon('diff')
							.onClick(() => void this.compareConflict(file)),
					);
				}
			}),
		);

		this.app.workspace.onLayoutReady(() => {
			if (this.unloaded) {
				return;
			}
			this.registerVaultEvents();
			this.restartSync();
			void this.retryRevocation();
		});
		this.revokeTimer = window.setInterval(() => void this.retryRevocation(), REVOKE_RETRY_MS);
	}

	onunload() {
		this.unloaded = true;
		for (const timer of [this.saveTimer, this.rescanTimer, this.retryTimer, this.downloadTimer]) {
			if (timer !== null) {
				window.clearTimeout(timer);
			}
		}
		if (this.revokeTimer !== null) {
			window.clearInterval(this.revokeTimer);
		}
		// Stop the running session now, and any session a start still in
		// progress creates once it finishes.
		void this.stopSession();
		void this.stopSync().then(() => this.saveSettings());
	}

	// Settings tab host.

	status(): SyncSnapshot {
		const session = this.session;
		let download = null;
		if (session?.download?.showing === true) {
			const counts = session.engine.progress();
			download = counts.present < counts.listed ? counts : null;
		}
		return {
			paired: getPairingState(this.settings) === 'paired',
			configured: this.settings.folder !== '' && this.settings.syncEnabled,
			connection: session === null ? null : session.source.state,
			pending: session === null ? 0 : session.source.pending,
			refused: session === null ? 0 : session.source.refused,
			ready: session !== null && session.engine.ready,
			download,
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
		let revoked = true;
		if (serverUrl !== '' && deviceKey !== '' && keyId !== '') {
			revoked = await revoke({ serverUrl, deviceKey, keyId });
			if (!revoked) {
				// Forgotten here, but still valid on the server: keep asking.
				addPendingRevocation(this.settings.pendingRevocations, { serverUrl, deviceKey, keyId });
			}
		}
		this.forgetPairing();
		await this.saveSettings();
		this.updateStatus();
		new Notice(
			revoked
				? 'This device is no longer paired.'
				: 'This device is no longer paired, but the server could not be reached to revoke its key, ' +
						'so the key still works there. Stoasis will keep trying; you can also remove the ' +
						'device from your list of devices on the server.',
		);
	}

	/**
	 * Asks the server again to revoke the keys of disconnected devices. True
	 * when none is left to revoke. Calls made while one runs share it.
	 */
	retryRevocation(): Promise<boolean> {
		this.revoking ??= this.revokePending().finally(() => {
			this.revoking = null;
		});
		return this.revoking;
	}

	private async revokePending(): Promise<boolean> {
		const revoked: PendingRevocation[] = [];
		for (const pending of [...this.settings.pendingRevocations]) {
			if (await revoke(pending)) {
				revoked.push(pending);
			}
		}
		if (revoked.length > 0) {
			// Keys added meanwhile stay.
			this.settings.pendingRevocations = this.settings.pendingRevocations.filter(
				(key) => !revoked.some((done) => sameKey(done, key)),
			);
			await this.saveSettings();
			new Notice(
				revoked.length === 1
					? 'The server revoked the key of the device you disconnected.'
					: `The server revoked the keys of ${revoked.length} devices you disconnected.`,
			);
		}
		return this.settings.pendingRevocations.length === 0;
	}

	async setFolder(folder: string, create: boolean): Promise<void> {
		if (folder === this.settings.folder) {
			return;
		}
		await this.mapFolder(folder, create, this.settings.syncEnabled);
	}

	brainApi(): NotesApi | null {
		if (getPairingState(this.settings) !== 'paired') {
			return null;
		}
		return new NotesApi(obsidianHttp, this.settings.serverUrl, this.settings.deviceKey);
	}

	downloadFolder(): string {
		const name = folderNameFor(this.settings.spaceName, SUGGESTED_FOLDER);
		return freeFolderName(name, (path) => this.canDownloadInto(path));
	}

	async downloadToDevice(): Promise<void> {
		await this.mapFolder(this.downloadFolder(), true, true);
	}

	/** Whether a new folder can be made at `path`, or it is an empty folder. */
	private canDownloadInto(path: string): boolean {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing !== null) {
			return existing instanceof TFolder && existing.children.length === 0;
		}
		// Folder names differ only in case on some systems; avoid those too.
		const lower = path.toLowerCase();
		return !this.folders().some((folder) => folder.toLowerCase() === lower);
	}

	/** Syncs the space with `folder`, creating it when asked, in one restart. */
	private async mapFolder(folder: string, create: boolean, enabled: boolean): Promise<void> {
		await this.stopSync();
		if (create && this.app.vault.getAbstractFileByPath(folder) === null) {
			await this.app.vault.createFolder(folder);
		}
		if (folder !== this.settings.folder) {
			this.settings.folder = folder;
			// What the engine knew was about the old folder.
			this.settings.sync = emptyEngineState();
		}
		this.settings.syncEnabled = enabled;
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

	// Tag now.

	/** Whether `file` is a copy kept in a conflict, with its note still next to it. */
	private isConflictCopy(file: TFile): boolean {
		const original = conflictOriginal(file.path);
		return original !== null && this.app.vault.getAbstractFileByPath(original) instanceof TFile;
	}

	/** Shows a conflict copy against its note, to keep one of the two. */
	async compareConflict(copy: TFile): Promise<void> {
		const original = conflictOriginal(copy.path);
		const vault = obsidianVault(this.app);
		const noteName = original?.split('/').pop() ?? '';
		if (original === null || !vault.exists(original)) {
			new Notice(`The note this copy was kept for is not next to it any more.`);
			return;
		}
		let device: string;
		let server: string;
		try {
			device = await vault.read(copy.path);
			server = await vault.read(original);
		} catch (error) {
			new Notice(`Stoasis could not read the two notes: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		new ConflictModal(this.app, copy.name, noteName, diffLines(device, server), async (which) => {
			try {
				if (which === 'device') {
					await keepThisDevice(vault, copy.path, original);
				} else {
					await keepTheServer(vault, copy.path);
				}
			} catch (error) {
				new Notice(`Stoasis could not keep it: ${error instanceof Error ? error.message : String(error)}`);
				return false;
			}
			new Notice(
				which === 'device'
					? `"${noteName}" now has this device's text; the copy is in the trash.`
					: `Kept "${noteName}" as the server has it; the copy is in the trash.`,
			);
			return true;
		}).open();
	}

	/**
	 * Asks the server for properties for the note's text and shows what would
	 * change. Any note can be tagged, synced or not, once the device is paired.
	 */
	async tagNote(file: TFile, editor: Pick<Editor, 'getValue'>): Promise<void> {
		if (getPairingState(this.settings) !== 'paired') {
			new Notice('Pair this device with a server first, in the plugin settings.');
			return;
		}
		const markdown = editor.getValue();
		if (tooLongToTag(markdown)) {
			new Notice('This note is too long to tag.');
			return;
		}
		const asking = new Notice('Asking the server for properties…', 0);
		let suggestion;
		try {
			suggestion = await new NotesApi(obsidianHttp, this.settings.serverUrl, this.settings.deviceKey).suggestProperties(
				markdown,
			);
		} catch (error) {
			new Notice(
				error instanceof ApiError && error.kind === 'network'
					? "Couldn't reach the server."
					: describeApiError(error),
			);
			return;
		} finally {
			asking.hide();
		}
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const proposal = propose(frontmatter, suggestion, stampDate(new Date()));
		const patch = proposal.patch;
		new TagModal(this.app, file.basename, proposal, () =>
			patch === null ? Promise.resolve(false) : this.applyTags(file, patch),
		).open();
	}

	/** Writes the patch into the note's frontmatter as it is now. */
	private async applyTags(file: TFile, patch: PropertyPatch): Promise<boolean> {
		let changed = false;
		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				changed = applyToFrontmatter(frontmatter, patch, stampDate(new Date()));
			});
		} catch (error) {
			new Notice(`Stoasis could not write the properties: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
		new Notice(changed ? `Tagged "${file.basename}".` : 'Nothing to add: the note already has these properties.');
		return true;
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
				? `Paired${who}. To get your notes on this device, open the Stoasis settings and choose "Download to this device".`
				: `Paired${who}.`,
		);
		this.settingTab?.refresh();
		this.restartSync();
		return true;
	}

	private forgetPairing(): void {
		const { installId, folder, pendingRevocations } = this.settings;
		this.settings = { ...DEFAULT_SETTINGS, sync: emptyEngineState(), installId, folder, pendingRevocations };
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
			saveState: () => {
				this.saveSoon();
				if (session.download?.active === true) {
					this.updateStatus();
				}
			},
			onProblem: (message) => new Notice(message),
			onTracked: () => this.editors.refresh(),
			onRelink: (path) => this.editors.relink(path),
		});
		const session: Session = {
			source,
			engine,
			// Only a folder that never finished a first sync downloads the space.
			download: settings.sync.seeded
				? null
				: new DownloadProgress(
						(message) => new Notice(message, 0),
						(message) => new Notice(message),
					),
		};
		this.session = session;
		source.onChange(() => this.updateStatus());
		source.start();
		this.updateStatus();
		// Not awaited: the first start can wait for the server indefinitely, and
		// stopping, disconnecting or choosing another folder must not wait for it.
		void engine
			.start()
			.then(() => {
				if (this.session === session && engine.ready) {
					this.editors.setLinker(engine);
					this.updateStatus();
				}
			})
			.catch((error: unknown) => {
				new Notice(`Stoasis could not start sync: ${error instanceof Error ? error.message : String(error)}`);
			});
	}

	private async stopSession(): Promise<void> {
		if (this.retryTimer !== null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.downloadTimer !== null) {
			window.clearTimeout(this.downloadTimer);
			this.downloadTimer = null;
		}
		const session = this.session;
		if (session === null) {
			return;
		}
		this.session = null;
		session.download?.stop();
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
			this.settingTab?.refresh();
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
		if (this.session?.download?.active === true) {
			this.followDownloadSoon();
		}
		this.showStatus();
	}

	/**
	 * Updates the download progress shortly, and at most a few times a second.
	 * Waiting also skips the moment a note made here is listed in the space but
	 * not yet recorded as a file, which is no download.
	 */
	private followDownloadSoon(): void {
		if (this.downloadTimer !== null) {
			return;
		}
		this.downloadTimer = window.setTimeout(() => {
			this.downloadTimer = null;
			const session = this.session;
			const download = session?.download;
			if (session === null || download?.active !== true) {
				return;
			}
			const snapshot = this.status();
			download.update({
				counts: session.engine.progress(),
				connection: snapshot.connection,
				ready: snapshot.ready,
				pending: snapshot.pending,
				refused: snapshot.refused,
			});
			this.showStatus();
		}, DOWNLOAD_UPDATE_MS);
	}

	private showStatus(): void {
		const snapshot = this.status();
		if (snapshot.refused > this.lastRefused) {
			new Notice(describeRefused(snapshot.refused));
		}
		this.lastRefused = snapshot.refused;
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
		this.settingTab?.refreshStatus();
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

/**
 * Asks the server to revoke a device key. True when the key no longer works,
 * including when the server had already removed it.
 */
async function revoke(key: { serverUrl: string; deviceKey: string; keyId: string }): Promise<boolean> {
	try {
		await new NotesApi(obsidianHttp, key.serverUrl, key.deviceKey).revokeDevice(key.keyId);
		return true;
	} catch (error) {
		return error instanceof ApiError && (error.kind === 'unauthenticated' || error.kind === 'not-found');
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
