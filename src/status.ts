import type { ConnectionState } from './sync/docs';

export interface SyncSnapshot {
	paired: boolean;
	/** A space is mapped to a folder and sync is switched on. */
	configured: boolean;
	/** Connection to the server, while syncing. */
	connection: ConnectionState | null;
	/** Documents not yet confirmed by the server. */
	pending: number;
	/** Notes the server refused; their changes stay on this device. */
	refused: number;
	/** The first pass over the folder has finished. */
	ready: boolean;
	/** While the first sync of the folder brings notes to this device. */
	download?: DownloadCounts | null;
}

/** Notes the space lists, and how many of them are files on this device. */
export interface DownloadCounts {
	listed: number;
	present: number;
}

/** The status bar text: short, lower case after the name, as Obsidian's own items. */
export function describeStatus(snapshot: SyncSnapshot): string {
	return `Stoasis: ${statusWords(snapshot)}`;
}

function statusWords(s: SyncSnapshot): string {
	const words = connectionWords(s);
	return s.refused > 0 && (s.connection === 'online' || s.connection === 'offline')
		? `${words}, ${s.refused} refused`
		: words;
}

function connectionWords(s: SyncSnapshot): string {
	if (!s.paired) {
		return 'not paired';
	}
	if (!s.configured || s.connection === null) {
		return 'sync off';
	}
	switch (s.connection) {
		case 'refused':
			return 'access refused';
		case 'outdated':
			return 'update needed';
		case 'offline':
			return s.pending > 0 ? `offline, ${s.pending} waiting` : 'offline';
		case 'connecting':
			return 'connecting';
		case 'online':
			if (s.download) {
				return `downloading ${s.download.present}/${s.download.listed}`;
			}
			return !s.ready || s.pending > 0 ? 'syncing' : 'synced';
	}
}

/** A longer explanation for the settings tab and the status bar tooltip. */
export function explainStatus(snapshot: SyncSnapshot): string {
	let text = explainConnection(snapshot);
	const download = snapshot.download;
	if (download && (snapshot.connection === 'online' || snapshot.connection === 'offline')) {
		const counts = `${download.present} of ${download.listed} notes are on this device`;
		text =
			snapshot.connection === 'online'
				? `Downloading your notes: ${counts}.`
				: `${text} ${counts} so far.`;
	}
	if (snapshot.refused > 0 && (snapshot.connection === 'online' || snapshot.connection === 'offline')) {
		return `${text} ${describeRefused(snapshot.refused)}`;
	}
	return text;
}

/** Says that the server refused some notes, and what happens to them. */
export function describeRefused(count: number): string {
	const notes = count === 1 ? '1 note' : `${count} notes`;
	const them = count === 1 ? 'it' : 'them';
	return `The server refused ${notes} in this folder. Changes to ${them} stay on this device; Stoasis asks again the next time sync starts.`;
}

function explainConnection(snapshot: SyncSnapshot): string {
	if (!snapshot.paired) {
		return 'This device is not paired with a server.';
	}
	if (!snapshot.configured || snapshot.connection === null) {
		return 'Choose a folder and turn on sync to start.';
	}
	switch (snapshot.connection) {
		case 'refused':
			return 'The server no longer accepts this device. Pair it again.';
		case 'outdated':
			return 'The server needs a newer version of this plugin. Update it to keep syncing.';
		case 'offline':
			return snapshot.pending > 0
				? 'The server cannot be reached. Changes are kept on this device and sent when it is back.'
				: 'The server cannot be reached. Changes made now are sent when it is back.';
		case 'connecting':
			return 'Connecting to the server.';
		case 'online':
			return !snapshot.ready || snapshot.pending > 0
				? 'Sending and receiving changes.'
				: 'All changes are synced.';
	}
}
