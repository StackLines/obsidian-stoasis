import type { DownloadCounts } from './status';
import type { ConnectionState } from './sync/docs';

/** The part of an Obsidian notice the download progress uses. */
export interface ProgressNotice {
	setMessage(message: string): unknown;
	hide(): void;
}

/** Where the first sync of a folder is, as the plugin sees it. */
export interface DownloadState {
	counts: DownloadCounts;
	connection: ConnectionState | null;
	/** The engine's first pass over the folder has finished. */
	ready: boolean;
	/** Documents the server has not synced or confirmed yet. */
	pending: number;
	/** Notes the server refused; they will not arrive this session. */
	refused: number;
}

/** The text of the download notice. */
export function describeDownload(counts: DownloadCounts, connection: ConnectionState | null): string {
	const { present, listed } = counts;
	return connection === 'offline'
		? `Stoasis: offline. ${present} of ${listed} notes are on this device so far.`
		: `Stoasis: downloading notes, ${present} of ${listed}.`;
}

/**
 * Shows the first sync of a folder as one notice that updates in place, since
 * Obsidian has no status bar on mobile. The notice appears once notes listed
 * in the space are missing from the device, and closes once they are all
 * there (or the server has nothing more to send). It is shown at most once.
 */
export class DownloadProgress {
	private notice: ProgressNotice | null = null;
	private message = '';
	private finished = false;

	constructor(
		/** Shows a notice that stays until it is hidden. */
		private readonly show: (message: string) => ProgressNotice,
		/** Shows a short notice that closes on its own. */
		private readonly announce: (message: string) => void,
	) {}

	/** False once the download has finished or stopped. */
	get active(): boolean {
		return !this.finished;
	}

	/** True while the notice is shown. */
	get showing(): boolean {
		return this.notice !== null;
	}

	update(state: DownloadState): void {
		if (this.finished) {
			return;
		}
		if (state.connection === 'refused' || state.connection === 'outdated') {
			// Nothing more arrives, and the plugin says why in a notice of its own.
			this.stop();
			return;
		}
		const { counts } = state;
		const done =
			state.ready && (counts.present + state.refused >= counts.listed || state.pending === 0);
		if (done) {
			this.finished = true;
			if (this.notice !== null) {
				this.notice.hide();
				this.notice = null;
				this.announce('Stoasis: your notes are on this device.');
			}
			return;
		}
		if (counts.present >= counts.listed) {
			return;
		}
		const message = describeDownload(counts, state.connection);
		if (this.notice === null) {
			this.notice = this.show(message);
		} else if (message !== this.message) {
			this.notice.setMessage(message);
		}
		this.message = message;
	}

	/** Closes the notice without announcing anything, as when sync stops. */
	stop(): void {
		this.finished = true;
		this.notice?.hide();
		this.notice = null;
	}
}
