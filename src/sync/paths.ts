// Paths in a space's index are relative to the folder the space is mapped
// to: POSIX separators, no leading slash, no "." or ".." segments.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isNoteId(value: unknown): value is string {
	return typeof value === 'string' && UUID.test(value);
}

/** Whether a relative path is safe to use and names a markdown note. */
export function isSyncablePath(rel: string): boolean {
	if (rel === '' || rel.length > 1024 || rel.startsWith('/') || rel.includes('\\')) {
		return false;
	}
	// Control characters never belong in a note path.
	// eslint-disable-next-line no-control-regex -- matching control characters is the point
	if (/[\u0000-\u001f\u007f]/.test(rel)) {
		return false;
	}
	const segments = rel.split('/');
	if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) {
		return false;
	}
	return rel.toLowerCase().endsWith('.md');
}

/** The path of a vault file relative to `folder`, or null when it is outside. */
export function toRelative(folder: string, vaultPath: string): string | null {
	const prefix = `${folder}/`;
	if (!vaultPath.startsWith(prefix)) {
		return null;
	}
	const rel = vaultPath.slice(prefix.length);
	return isSyncablePath(rel) ? rel : null;
}

export function toVaultPath(folder: string, rel: string): string {
	return `${folder}/${rel}`;
}

/** Parent folders of a relative path, outermost first. */
export function parentFolders(path: string): string[] {
	const segments = path.split('/').slice(0, -1);
	return segments.map((_, i) => segments.slice(0, i + 1).join('/'));
}

/**
 * A free path next to `rel` for a copy kept because of a conflict, such as
 * "Ideas (conflict 2026-10-15).md", then "Ideas (conflict 2026-10-15 2).md".
 */
export function conflictPath(rel: string, date: Date, taken: (rel: string) => boolean): string {
	return sparePath(rel, `conflict ${date.toISOString().slice(0, 10)}`, taken);
}

/** A free path next to `rel` with `label` in parentheses, such as "Ideas (moving).md". */
export function sparePath(rel: string, label: string, taken: (rel: string) => boolean): string {
	const stem = rel.slice(0, -'.md'.length);
	for (let n = 1; ; n++) {
		const candidate = `${stem} (${label}${n > 1 ? ` ${n}` : ''}).md`;
		if (!taken(candidate)) {
			return candidate;
		}
	}
}

/** A short fingerprint of a text, to tell whether a file changed. */
export function fingerprint(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/** A random version 4 UUID, as the index expects for new notes. */
export function newNoteId(): string {
	return crypto.randomUUID();
}
