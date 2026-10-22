import {
	getFrontMatterInfo,
	MarkdownView,
	Notice,
	parseYaml,
	Platform,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
	type Editor,
} from 'obsidian';
import { ApiError, NotesApi } from './api';
import { HistoryModal } from './history-modal';
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
import type * as Y from 'yjs';
import { INDEX_FIELD, spaceDocName, type ConnectionState } from './sync/docs';
import { emptyEngineState, SyncEngine } from './sync/engine';
import { HocuspocusDocSource, SyncAccessError, type SyncAccess } from './sync/hocuspocus';
import { indexedDbStores } from './sync/idb';
import { readRootMeta, rerootIndex, translateKnown, type RootMeta } from './sync/root';
import { checkCompatibility, describeIncompatibility } from './version';
import { folderProbe, obsidianVault } from './vault';
import { checkFolder, describeRisk, warningKey } from './folder-warnings';
import { TagModal } from './tag-modal';
import {
	applyToFrontmatter,
	propose,
	reviewedFrontmatter,
	stampDate,
	stillReviewed,
	tooLongToTag,
} from './tagging';
import type { PropertyPatch } from './frontmatter-patch';
import {
	conflictOriginal,
	diffLines,
	keepSyncedNote,
	useConflictCopy,
	type Compared,
	type ConflictFiles,
	type KeepResult,
} from './conflict';
import { ConflictModal } from './conflict-modal';
import { ConfirmModal } from './confirm-modal';
import {
	folderMapping,
	isWithin,
	mappedFolder,
	sameMapping,
	toRelative,
	WHOLE_VAULT,
	type Mapping,
} from './sync/paths';

/** How long to wait before saving after the sync state changed. */
const SAVE_DELAY_MS = 2000;
/** How long to wait before checking a folder after folders were moved or deleted. */
const RESCAN_DELAY_MS = 2000;
/** How long to wait before retrying when the space could not be loaded. */
const SPACE_RETRY_MS = 30_000;
const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));
/** How long to wait for the server when looking at or changing the space once. */
const SPACE_LOOK_MS = 15_000;
/** How often to ask again for the key of a disconnected device to be revoked. */
const REVOKE_RETRY_MS = 10 * 60_000;
/** Above this many notes, syncing the whole vault asks what is about to be uploaded. */
export const LARGE_FIRST_SYNC = 500;
/** How long to wait before showing how far a download has come. */
const DOWNLOAD_UPDATE_MS = 250;

/** Thrown inside processFrontMatter to write nothing when a tag proposal is out of date. */
class StaleProposal extends Error {}

/** The properties in a note's text, as the app reads them; none when there are none or they cannot be read. */
function propertiesOf(markdown: string): Record<string, unknown> {
	const info = getFrontMatterInfo(markdown);
	if (!info.exists) {
		return {};
	}
	try {
		const value: unknown = parseYaml(info.frontmatter);
		return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

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
		this.addCommand({
			id: 'note-history',
			name: 'Note history',
			editorCheckCallback: (checking, _editor, info) => {
				const file = info.file;
				if (file === null || !this.syncedNote(file)) {
					return false;
				}
				if (!checking) {
					this.showHistory(file);
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
				if (this.syncedNote(file)) {
					menu.addItem((item) =>
						item
							.setTitle('Note history')
							.setIcon('history')
							.onClick(() => this.showHistory(file)),
					);
				}
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
			configured: this.settings.mapping !== null && this.settings.syncEnabled,
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
		const mapping = folderMapping(folder);
		if (sameMapping(mapping, this.settings.mapping)) {
			return;
		}
		if (this.settings.mapping?.kind === 'vault') {
			const confirmed = await new ConfirmModal(
				this.app,
				'Sync a folder instead of the whole vault?',
				`The space's notes will be downloaded into "${folder}", under their paths in the space, ` +
					`and the notes already in "${folder}" will be uploaded as new notes. ` +
					'Notes in the space are not deleted, but you may end up with copies.',
				'Sync the folder',
			).ask();
			if (!confirmed) {
				return;
			}
		}
		await this.applyMapping(mapping, create, this.settings.syncEnabled);
	}

	async chooseWholeVault(): Promise<boolean> {
		if (sameMapping(WHOLE_VAULT, this.settings.mapping)) {
			return true;
		}
		if (this.brainApi() === null) {
			new Notice('Pair this device first.');
			return false;
		}
		// What the space holds is read from its document: the server's byte count
		// can lag behind notes just uploaded.
		// A running session has the space open already: a second copy on the same
		// local storage would compete with it.
		const look =
			this.session?.engine.spaceSummary() ??
			(this.session === null
				? await this.withSpace((doc) => ({ meta: readRootMeta(doc), notes: doc.getMap(INDEX_FIELD).size }))
				: undefined);
		if (look === undefined) {
			new Notice('Could not reach your server to look at the space. Try again when you are online.');
			return false;
		}
		if (look.notes > 0) {
			return this.chooseWholeVaultOfPopulatedSpace(look.meta);
		}
		const count = this.wholeVaultNotes();
		const text =
			count > LARGE_FIRST_SYNC
				? `${count} notes will be uploaded to your server. This can take a while; Obsidian stays usable meanwhile.`
				: `${count} ${count === 1 ? 'note' : 'notes'} will be uploaded to your server.`;
		const confirmed = await new ConfirmModal(
			this.app,
			'Sync the whole vault?',
			`${text} Every Markdown note in this vault syncs, except Obsidian's own settings and hidden folders.`,
			'Sync the whole vault',
		).ask();
		if (!confirmed) {
			return false;
		}
		await this.applyMapping(WHOLE_VAULT, false, true);
		return true;
	}

	/** Many synced notes are missing: delete them everywhere only if asked. */
	private async askAboutDeletes(engine: SyncEngine, count: number): Promise<void> {
		const confirmed = await new ConfirmModal(
			this.app,
			'Delete notes everywhere?',
			`${count} synced notes are missing from this vault. Deleting them here removes them from your server and from your other devices, which keep a copy in their trash. ` +
				'If this was a mistake, cancel, restore the files, then turn sync on again.',
			`Delete ${count} notes`,
		).ask();
		if (confirmed) {
			engine.releaseHeld();
		} else {
			await this.setSyncEnabled(false);
			new Notice('Stoasis: sync is off. Restore the missing notes, then turn sync on.');
		}
	}

	/**
	 * A space that has notes already: join it when it starts at the vault root,
	 * or move it there from the folder this device syncs.
	 */
	private async chooseWholeVaultOfPopulatedSpace(meta: RootMeta | null): Promise<boolean> {
		const mapping = this.settings.mapping;
		const configDir = this.app.vault.configDir;
		const inVault = this.wholeVaultNotes();
		if (meta !== null) {
			const confirmed = await new ConfirmModal(
				this.app,
				'Sync the whole vault?',
				`The space's notes will be downloaded into this vault, under their paths in the space. ` +
					`The ${inVault} ${inVault === 1 ? 'note' : 'notes'} here are uploaded as new notes, ` +
					'or merged by path with notes the space has at the same path.',
				'Sync the whole vault',
			).ask();
			if (!confirmed) {
				return false;
			}
			await this.applyMapping(WHOLE_VAULT, false, true);
			return true;
		}
		if (mapping?.kind !== 'folder') {
			new Notice(
				'This space was synced from a folder, so its paths start at that folder. ' +
					'Sync that folder on this device first, then choose the whole vault to move the space to it.',
				0,
			);
			return false;
		}
		const folder = mapping.path;
		const inside = this.app.vault
			.getMarkdownFiles()
			.filter((file) => toRelative(mapping, file.path, configDir) !== null).length;
		const outside = inVault - inside;
		const confirmed = await new ConfirmModal(
			this.app,
			'Move the space to the whole vault?',
			`The space now starts at "${folder}". It will start at the vault root: the notes in "${folder}" ` +
				`stay where they are and keep their history, and ${outside} ${outside === 1 ? 'note' : 'notes'} ` +
				'in other folders are uploaded as new notes. Your other devices will ask to follow. ' +
				'Update the plugin on all of them first: a device on version 0.2 does not understand this change.',
			'Move the space',
		).ask();
		if (!confirmed) {
			return false;
		}
		return this.inLifecycle(async () => {
			await this.stopSession();
			const moved = await this.withSpace((doc) => rerootIndex(doc, folder), true);
			if (moved === undefined || moved === null) {
				new Notice('The space could not be moved to the whole vault. Nothing was changed.');
				await this.startSession();
				return;
			}
			this.settings.mapping = WHOLE_VAULT;
			this.settings.sync = { ...this.settings.sync, known: translateKnown(this.settings.sync.known, folder) };
			this.settings.syncEnabled = true;
			await this.saveSettings();
			await this.startSession();
		}).then(() => sameMapping(this.settings.mapping, WHOLE_VAULT));
	}

	/**
	 * Opens the space document for a look or one change, then closes it. Gives
	 * undefined when the server's copy could not be had. With `upload`, also
	 * waits a little for the server to confirm the change.
	 */
	private async withSpace<T>(use: (doc: Y.Doc) => T, upload = false): Promise<T | undefined> {
		const settings = this.settings;
		const source = new HocuspocusDocSource({
			url: syncSocketUrl(settings.serverUrl),
			access: this.syncAccess(settings),
			stores: indexedDbStores(`stoasis-${settings.installId}`),
			primary: spaceDocName(settings.spaceId),
		});
		try {
			source.start();
			const space = source.open(spaceDocName(settings.spaceId));
			await Promise.race([space.whenSynced(), wait(SPACE_LOOK_MS)]);
			if (!space.synced) {
				return undefined;
			}
			const result = use(space.doc);
			for (let waited = 0; upload && !space.confirmed && waited < SPACE_LOOK_MS; waited += 200) {
				await wait(200);
			}
			return result;
		} finally {
			await source.destroy();
		}
	}

	/** The space now starts at the vault root, but this device syncs a folder: follow it, or pause. */
	private followRoot(meta: RootMeta): void {
		void this.inLifecycle(async () => {
			await this.stopSession();
			const mapping = this.settings.mapping;
			if (mapping?.kind !== 'folder') {
				return;
			}
			const folder = mapping.path;
			const confirmed = await new ConfirmModal(
				this.app,
				'This space now syncs a whole vault',
				meta.prefix === ''
					? `Another device syncs its whole vault with this space. To follow, this device syncs its whole vault too: the notes in "${folder}" are merged by path with the space's notes.`
					: `Another device moved the space to the vault root. The notes you have in "${folder}" belong in "${meta.prefix}" now` +
							(folder === meta.prefix ? '.' : `, so "${folder}" will be renamed to "${meta.prefix}".`) +
							' Notes in other folders of the space are downloaded next to it.',
				'Sync the whole vault',
			).ask();
			if (!confirmed) {
				this.settings.syncEnabled = false;
				await this.saveSettings();
				this.updateStatus();
				new Notice('Stoasis: sync is paused until you follow the space to the whole vault.', 0);
				return;
			}
			if (meta.prefix !== '' && folder !== meta.prefix && !(await this.renameSyncedFolder(folder, meta.prefix))) {
				this.settings.syncEnabled = false;
				await this.saveSettings();
				this.updateStatus();
				return;
			}
			this.settings.mapping = WHOLE_VAULT;
			this.settings.sync =
				meta.prefix === ''
					? emptyEngineState()
					: { ...this.settings.sync, known: translateKnown(this.settings.sync.known, meta.prefix) };
			this.settings.syncEnabled = true;
			await this.saveSettings();
			await this.startSession();
		});
	}

	/** Renames the synced folder to `to`, as the space expects; false, with a notice, when that cannot be done. */
	private async renameSyncedFolder(from: string, to: string): Promise<boolean> {
		const folder = this.app.vault.getAbstractFileByPath(from);
		const lower = to.toLowerCase();
		if (!(folder instanceof TFolder) || this.folders().some((existing) => existing.toLowerCase() === lower) || isWithin(from, to)) {
			new Notice(
				`The space expects its notes in "${to}", but that folder exists already. Rename or move it, then turn sync on.`,
				0,
			);
			return false;
		}
		const parents = to.split('/').slice(0, -1);
		for (let n = 1; n <= parents.length; n++) {
			const parent = parents.slice(0, n).join('/');
			if (this.app.vault.getAbstractFileByPath(parent) === null) {
				await this.app.vault.createFolder(parent);
			}
		}
		await this.app.vault.rename(folder, to);
		return true;
	}

	/** How many notes the whole vault would upload. */
	wholeVaultNotes(): number {
		const configDir = this.app.vault.configDir;
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => toRelative(WHOLE_VAULT, file.path, configDir) !== null).length;
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
		await this.applyMapping(folderMapping(this.downloadFolder()), true, true);
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

	/** Syncs the space with `mapping`, creating its folder when asked, in one restart. */
	private async applyMapping(mapping: Mapping, create: boolean, enabled: boolean): Promise<void> {
		await this.stopSync();
		if (create && mapping.kind === 'folder' && this.app.vault.getAbstractFileByPath(mapping.path) === null) {
			await this.app.vault.createFolder(mapping.path);
		}
		if (!sameMapping(mapping, this.settings.mapping)) {
			this.settings.mapping = mapping;
			// What the engine knew was about the old mapping.
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
	private syncedNote(file: TFile): boolean {
		return file.extension === 'md' && this.session?.engine.noteAt(file.path) !== undefined;
	}

	/** Opens the history of a synced note, to look at an earlier version or restore it. */
	showHistory(file: TFile): void {
		const engine = this.session?.engine;
		const api = this.brainApi();
		const id = engine?.noteAt(file.path);
		if (engine === undefined || api === null || id === undefined) {
			new Notice('This note is not synced, so it has no history.');
			return;
		}
		const path = file.path;
		const source = {
			versions: (before: number | null) => api.noteVersions(id, before),
			text: async (version: number) => (await api.noteVersion(id, version)).text,
			current: async () => {
				const text = await engine.noteText(path);
				if (text === null || engine.noteAt(path) !== id) {
					throw new Error('The note is not synced here any more.');
				}
				return text;
			},
			restore: (text: string, expected: string) =>
				engine.noteAt(path) === id ? engine.restore(path, text, expected) : Promise.resolve(false),
		};
		new HistoryModal(this.app, file.name, source, (error) =>
			error instanceof ApiError ? describeApiError(error) : error instanceof Error ? error.message : String(error),
		).open();
	}

	private isConflictCopy(file: TFile): boolean {
		const original = conflictOriginal(file.path);
		return original !== null && this.app.vault.getAbstractFileByPath(original) instanceof TFile;
	}

	/**
	 * Shows a conflict copy against its note, to keep one of the two. Both
	 * are read as open editors show them, unsaved typing included, and
	 * checked again when a choice is made and as each is written or trashed:
	 * if either was renamed, replaced or changed meanwhile, nothing is
	 * written and the copy stays.
	 */
	async compareConflict(shown: TFile): Promise<void> {
		const path = conflictOriginal(shown.path);
		const copy = this.app.vault.getAbstractFileByPath(shown.path);
		const note = path === null ? null : this.app.vault.getAbstractFileByPath(path);
		if (!(copy instanceof TFile)) {
			return;
		}
		if (path === null || !(note instanceof TFile)) {
			new Notice(`The note this copy was kept for is not next to it any more.`);
			return;
		}
		const copyName = copy.name;
		const noteName = note.name;
		// The files as compared: the app's object for each, its path, and the synced note there.
		const objects = { copy, original: note };
		const paths = { copy: copy.path, original: path };
		const ids = { copy: this.session?.engine.noteAt(copy.path), original: this.session?.engine.noteAt(path) };
		const files: ConflictFiles = {
			same: (side) => {
				const file = objects[side];
				const at = paths[side];
				return (
					file.path === at &&
					this.app.vault.getAbstractFileByPath(at) === file &&
					(ids[side] === undefined || this.session?.engine.noteAt(at) === ids[side])
				);
			},
			shown: (side) => this.openText(objects[side]),
			read: (side) => this.app.vault.read(objects[side]),
			process: async (side, update) => {
				await this.app.vault.process(objects[side], update);
			},
			trash: (side) => this.app.fileManager.trashFile(objects[side]),
		};
		const compare = async (): Promise<Compared | null> => {
			try {
				return {
					copyText: files.shown('copy') ?? (await files.read('copy')),
					originalText: files.shown('original') ?? (await files.read('original')),
				};
			} catch (error) {
				new Notice(`Stoasis could not read the two notes: ${error instanceof Error ? error.message : String(error)}`);
				return null;
			}
		};
		let compared = await compare();
		if (compared === null) {
			return;
		}
		new ConflictModal(
			this.app,
			copyName,
			noteName,
			diffLines(compared.copyText, compared.originalText),
			async (which) => {
				const shown = compared as Compared;
				let result: KeepResult;
				try {
					result = which === 'copy' ? await useConflictCopy(files, shown) : await keepSyncedNote(files, shown);
				} catch (error) {
					new Notice(`Stoasis could not keep it: ${error instanceof Error ? error.message : String(error)}`);
					return 'stay';
				}
				switch (result) {
					case 'kept':
						new Notice(
							which === 'copy'
								? `"${noteName}" now has the text of "${copyName}", which is in the trash.`
								: `Kept "${noteName}" as it is; "${copyName}" is in the trash.`,
						);
						return 'close';
					case 'copy-changed':
						new Notice(
							`"${noteName}" now has the text of "${copyName}" as compared. One of the two changed ` +
								`or was moved meanwhile, so "${copyName}" was kept.`,
						);
						return 'close';
					case 'gone':
						new Notice(
							`"${copyName}" or "${noteName}" was moved, deleted or replaced while this was open. ` +
								'Nothing was changed.',
						);
						return 'close';
					case 'changed': {
						const again = await compare();
						if (again === null) {
							return 'close';
						}
						compared = again;
						return { lines: diffLines(again.copyText, again.originalText) };
					}
				}
			},
		).open();
	}

	/** The text of `file` as an open editor shows it, saved or not, or null when it is not open. */
	private openText(file: TFile): string | null {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file === file) {
				return view.editor.getValue();
			}
		}
		return null;
	}

	/**
	 * Asks the server for properties for the note's text and shows what would
	 * change. Any note can be tagged, synced or not, once the device is paired.
	 */
	async tagNote(file: TFile, editor: Pick<Editor, 'getValue'>, again = false): Promise<void> {
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
		// The proposal is for the properties in the text that was sent.
		const frontmatter = propertiesOf(markdown);
		const reviewed = reviewedFrontmatter(frontmatter);
		const proposal = propose(frontmatter, suggestion, stampDate(new Date()));
		const patch = proposal.patch;
		new TagModal(this.app, file.basename, proposal, async () => {
			if (patch === null) {
				return false;
			}
			// The open editor may have properties not saved yet, which the file does not show.
			const result = stillReviewed(propertiesOf(editor.getValue()), reviewed)
				? await this.applyTags(file, patch, reviewed)
				: 'stale';
			if (result === 'stale') {
				// The proposal was for other properties: ask again for the note as it is now, once.
				new Notice(
					`The properties of "${file.basename}" changed since the suggestion, so nothing was written.` +
						(again ? ' Run "Tag this note now" again.' : ' Asking for a new suggestion.'),
				);
				if (!again) {
					void this.tagNote(file, editor, true);
				}
			}
			return result !== 'failed';
		}).open();
	}

	/**
	 * Writes the patch into the note's frontmatter, only if it is still the
	 * frontmatter the proposal was made for: checked inside processFrontMatter,
	 * so nothing written meanwhile is lost.
	 */
	private async applyTags(
		file: TFile,
		patch: PropertyPatch,
		reviewed: string,
	): Promise<'tagged' | 'unchanged' | 'stale' | 'failed'> {
		let changed = false;
		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				if (!stillReviewed(frontmatter, reviewed)) {
					throw new StaleProposal();
				}
				changed = applyToFrontmatter(frontmatter, patch, stampDate(new Date()));
			});
		} catch (error) {
			if (error instanceof StaleProposal) {
				return 'stale';
			}
			new Notice(`Stoasis could not write the properties: ${error instanceof Error ? error.message : String(error)}`);
			return 'failed';
		}
		new Notice(changed ? `Tagged "${file.basename}".` : 'Nothing to add: the note already has these properties.');
		return changed ? 'tagged' : 'unchanged';
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
			this.settings.mapping === null
				? `Paired${who}. To get your notes on this device, open the Stoasis settings and choose "Download to this device".`
				: `Paired${who}.`,
		);
		this.settingTab?.refresh();
		this.restartSync();
		return true;
	}

	private forgetPairing(): void {
		// Which folder warnings were shown is about this device, not the pairing.
		const { installId, pendingRevocations, folderWarnings } = this.settings;
		// A folder stays; the whole vault is chosen per space, after its check and window.
		const mapping = this.settings.mapping?.kind === 'folder' ? this.settings.mapping : null;
		this.settings = { ...DEFAULT_SETTINGS, sync: emptyEngineState(), installId, mapping, pendingRevocations, folderWarnings };
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
		const mapping = settings.mapping;
		if (this.unloaded || getPairingState(settings) !== 'paired' || mapping === null || !settings.syncEnabled) {
			this.updateStatus();
			return;
		}
		if (mapping.kind === 'folder' && !(this.app.vault.getAbstractFileByPath(mapping.path) instanceof TFolder)) {
			new Notice(`The folder "${mapping.path}" no longer exists, so sync is paused. Choose a folder in the Stoasis settings.`);
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
			mapping,
			configDir: this.app.vault.configDir,
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
			onMassDelete: (count) => void this.askAboutDeletes(engine, count),
			onRootMoved: (meta) => this.followRoot(meta),
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
		void this.warnAboutFolder(mappedFolder(mapping) ?? '');
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

	/**
	 * Warns, once for each folder, when something else also syncs or changes
	 * the synced folder, or keeps new attachments outside it. The empty string
	 * is the whole vault.
	 */
	async warnAboutFolder(folder: string): Promise<void> {
		let check;
		try {
			check = await checkFolder(folderProbe(this.app), folder);
		} catch {
			// A warning is a nicety; sync goes on without it.
			return;
		}
		const fresh = check.risks.filter((risk) => !this.settings.folderWarnings.includes(warningKey(folder, risk)));
		if (fresh.length === 0 || this.unloaded || this.mappedFolderPath() !== folder) {
			return;
		}
		for (const risk of fresh) {
			new Notice(describeRisk(risk, folder, check.attachments), 0);
			this.settings.folderWarnings.push(warningKey(folder, risk));
		}
		await this.saveSettings();
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
		const mapping = this.settings.mapping;
		if (mapping === null) {
			return;
		}
		if (mapping.kind === 'vault') {
			// The vault root cannot be renamed; a folder in it moved with its notes.
			this.rescanSoon();
			return;
		}
		const mapped = mapping.path;
		if (isWithin(oldPath, mapped)) {
			// The synced folder itself moved: follow it.
			const moved = folder.path + mapped.slice(oldPath.length);
			this.settings.mapping = folderMapping(moved);
			this.session?.engine.folderMoved(moved);
			this.saveSoon();
			this.settingTab?.refresh();
		} else if (oldPath.startsWith(`${mapped}/`) || folder.path.startsWith(`${mapped}/`)) {
			this.rescanSoon();
		}
	}

	private folderDeleted(folder: TAbstractFile): void {
		const mapping = this.settings.mapping;
		if (mapping === null) {
			return;
		}
		if (mapping.kind === 'vault') {
			// The vault root cannot be deleted, so this is a folder of notes: its
			// files were deleted like any others and the engine handles each.
			this.rescanSoon();
			return;
		}
		const mapped = mapping.path;
		if (isWithin(folder.path, mapped)) {
			// Deleting the synced folder must not delete the notes on every
			// device: stop before the engine handles the files inside it.
			void this.session?.engine.stop();
			this.restartSync();
		} else if (folder.path.startsWith(`${mapped}/`)) {
			this.rescanSoon();
		}
	}

	/** The mapped folder's path, empty for the whole vault, null when nothing is mapped. */
	private mappedFolderPath(): string | null {
		const mapping = this.settings.mapping;
		return mapping === null ? null : (mappedFolder(mapping) ?? '');
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
