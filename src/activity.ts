import { ago } from './scan-status';

export type ActivityDirection = 'upload' | 'download';
export type ActivityAction = 'edit' | 'new' | 'rename' | 'delete';

/** One change that crossed between this device and the space. */
export interface ActivityEntry {
	/** Milliseconds since the epoch. */
	at: number;
	direction: ActivityDirection;
	action: ActivityAction;
	/** The note's path in the vault; for a rename, the new path. */
	path: string;
	/** For a rename, the path it had. */
	from?: string;
}

/** What the engine reports, before the log stamps it. */
export type ActivityEvent = Omit<ActivityEntry, 'at'>;

/** What the plugin keeps between sessions: the log and the last contact with the server. */
export interface ActivityData {
	entries: ActivityEntry[];
	/** When the server was last reachable, in milliseconds since the epoch; null if never. */
	contactAt: number | null;
}

export const ACTIVITY_LIMIT = 500;
/** Edits to one note closer together than this make one entry. */
export const MERGE_WINDOW_MS = 60_000;
/** How many of the newest entries are looked through for one to merge with. */
const MERGE_LOOKBACK = 20;

export function emptyActivity(): ActivityData {
	return { entries: [], contactAt: null };
}

/**
 * The history of what synced, newest first, kept to the last `ACTIVITY_LIMIT`
 * changes. It records names and paths only, never note text, and stays on this
 * device.
 */
export class ActivityLog {
	constructor(private readonly data: ActivityData) {}

	get entries(): readonly ActivityEntry[] {
		return this.data.entries;
	}

	get contactAt(): number | null {
		return this.data.contactAt;
	}

	/** Notes that the server was reached at `at`. */
	touchContact(at: number): void {
		this.data.contactAt = at;
	}

	record(event: ActivityEvent, at: number): void {
		const entries = this.data.entries;
		if (event.action === 'edit') {
			// Typing is one change per keystroke; a burst of edits is one entry.
			const same = entries
				.slice(0, MERGE_LOOKBACK)
				.find((e) => e.path === event.path && e.direction === event.direction && e.action === 'edit');
			if (same !== undefined && at - same.at <= MERGE_WINDOW_MS) {
				same.at = at;
				entries.sort((a, b) => b.at - a.at);
				return;
			}
		}
		entries.unshift({ ...event, at });
		if (entries.length > ACTIVITY_LIMIT) {
			entries.length = ACTIVITY_LIMIT;
		}
	}
}

/** The stored activity, keeping only well-formed entries. */
export function parseActivity(data: unknown): ActivityData {
	const result = emptyActivity();
	if (typeof data !== 'object' || data === null) {
		return result;
	}
	const stored = data as Record<string, unknown>;
	if (typeof stored['contactAt'] === 'number' && Number.isFinite(stored['contactAt'])) {
		result.contactAt = stored['contactAt'];
	}
	const list = stored['entries'];
	if (Array.isArray(list)) {
		for (const value of list as unknown[]) {
			const entry = parseEntry(value);
			if (entry !== null) {
				result.entries.push(entry);
			}
		}
		result.entries.sort((a, b) => b.at - a.at);
		result.entries.length = Math.min(result.entries.length, ACTIVITY_LIMIT);
	}
	return result;
}

function parseEntry(value: unknown): ActivityEntry | null {
	if (typeof value !== 'object' || value === null) {
		return null;
	}
	const { at, direction, action, path, from } = value as Record<string, unknown>;
	if (typeof at !== 'number' || !Number.isFinite(at) || typeof path !== 'string' || path === '') {
		return null;
	}
	if (direction !== 'upload' && direction !== 'download') {
		return null;
	}
	if (action !== 'edit' && action !== 'new' && action !== 'rename' && action !== 'delete') {
		return null;
	}
	return typeof from === 'string' && from !== '' ? { at, direction, action, path, from } : { at, direction, action, path };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local date and time, as 2026-10-23 14:05. */
export function formatWhen(at: number): string {
	const d = new Date(at);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The file name of a vault path, and the folder it is in ('' at the root). */
export function splitPath(path: string): { name: string; folder: string } {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? { name: path, folder: '' } : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

const ACTION_WORDS: Record<ActivityAction, string> = {
	edit: 'edited',
	new: 'new',
	rename: 'renamed',
	delete: 'deleted',
};

/** What happened, as "Uploaded, edited". */
export function describeEntry(entry: ActivityEntry): string {
	const direction = entry.direction === 'upload' ? 'Uploaded' : 'Downloaded';
	return `${direction}, ${ACTION_WORDS[entry.action]}`;
}

/** Lines for the top of the sync window, beyond the connection state. */
export function describeContact(
	contactAt: number | null,
	online: boolean,
	last: ActivityEntry | undefined,
	now: Date,
): string[] {
	const lines: string[] = [];
	if (online) {
		lines.push('Last server contact: now.');
	} else if (contactAt !== null) {
		lines.push(`Last server contact: ${formatWhen(contactAt)}, ${ago(new Date(contactAt).toISOString(), now)}.`);
	} else {
		lines.push('This device has not reached the server yet.');
	}
	if (last !== undefined) {
		const { name } = splitPath(last.path);
		lines.push(`Last note synced: ${name}, ${ago(new Date(last.at).toISOString(), now)}.`);
	} else {
		lines.push('No note has synced since this was switched on.');
	}
	return lines;
}
