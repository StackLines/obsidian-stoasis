import type { ConnectionState } from './sync/docs';

export interface SyncSnapshot {
	paired: boolean;
	/** A space is mapped to a folder and sync is switched on. */
	configured: boolean;
	/** Connection to the server, while syncing. */
	connection: ConnectionState | null;
	/** Documents not yet confirmed by the server. */
	pending: number;
	/** The first pass over the folder has finished. */
	ready: boolean;
}

/** The status bar text: short, lower case after the name, as Obsidian's own items. */
export function describeStatus(snapshot: SyncSnapshot): string {
	return `Stoasis: ${statusWords(snapshot)}`;
}

function statusWords(s: SyncSnapshot): string {
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
			return !s.ready || s.pending > 0 ? 'syncing' : 'synced';
	}
}

/** A longer explanation for the settings tab and the status bar tooltip. */
export function explainStatus(snapshot: SyncSnapshot): string {
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
