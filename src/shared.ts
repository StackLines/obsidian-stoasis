import { isNoteId } from './sync/paths';

/** What a person may do in something shared with them. */
export type ShareRole = 'viewer' | 'editor';

/**
 * Something another person shared, kept in this vault: a whole space under
 * `folder`, or one note at `path`. Both are vault paths below the shared root.
 */
export type SharedMapping =
	| { kind: 'space'; spaceId: string; folder: string; role: ShareRole }
	| { kind: 'note'; noteId: string; path: string; role: ShareRole };

export const DEFAULT_SHARED_ROOT = 'Shared with me';

/** Whether `path` is a plain vault path: no leading slash, no empty, "." or ".." segments. */
function isPlainPath(path: string): boolean {
	if (path === '' || path.length > 1024 || path.startsWith('/') || path.includes('\\')) {
		return false;
	}
	// eslint-disable-next-line no-control-regex -- matching control characters is the point
	if (/[\u0000-\u001f\u007f]/.test(path)) {
		return false;
	}
	return !path.split('/').some((s) => s === '' || s === '.' || s === '..');
}

/** The folder shared items go in; the default when the stored one is unusable. */
export function parseSharedRoot(value: unknown): string {
	return typeof value === 'string' && isPlainPath(value) && !value.startsWith('.') ? value : DEFAULT_SHARED_ROOT;
}

function isRole(value: unknown): value is ShareRole {
	return value === 'viewer' || value === 'editor';
}

/** The stored shared mappings, keeping only well-formed ones, each space or note once. */
export function parseShared(data: unknown): SharedMapping[] {
	const result: SharedMapping[] = [];
	if (!Array.isArray(data)) {
		return result;
	}
	for (const value of data as unknown[]) {
		if (typeof value !== 'object' || value === null) {
			continue;
		}
		const stored = value as Record<string, unknown>;
		const role = stored['role'];
		if (!isRole(role)) {
			continue;
		}
		if (stored['kind'] === 'space') {
			const { spaceId, folder } = stored;
			if (isNoteId(spaceId) && typeof folder === 'string' && isPlainPath(folder)) {
				if (!result.some((m) => m.kind === 'space' && m.spaceId === spaceId)) {
					result.push({ kind: 'space', spaceId, folder, role });
				}
			}
		} else if (stored['kind'] === 'note') {
			const { noteId, path } = stored;
			if (isNoteId(noteId) && typeof path === 'string' && isPlainPath(path)) {
				if (!result.some((m) => m.kind === 'note' && m.noteId === noteId)) {
					result.push({ kind: 'note', noteId, path, role });
				}
			}
		}
	}
	return result;
}
