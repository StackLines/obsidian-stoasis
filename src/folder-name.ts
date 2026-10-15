/** Longest folder name derived from a space name. */
const MAX_NAME = 100;
/**
 * Characters that are not allowed in file names on some systems, or that
 * break links in Obsidian.
 */
const UNSAFE = /[\\/:*?"<>|#^[\]]/g;

/**
 * A folder name for a space: its name without characters that cannot be used
 * in a vault path, or `fallback` when nothing usable is left.
 */
export function folderNameFor(spaceName: string, fallback: string): string {
	const name = spaceName
		.replace(UNSAFE, ' ')
		// Also turns tabs, line breaks and other white space into one space.
		.replace(/\s+/g, ' ')
		.trim()
		// A leading dot hides the folder; a trailing dot or space is dropped by some systems.
		.replace(/^\.+/, '')
		.replace(/[. ]+$/, '')
		.slice(0, MAX_NAME)
		.trim();
	return name === '' ? fallback : name;
}

/**
 * The first of `name`, `name 2`, `name 3`, … that `usable` accepts: one that
 * does not exist yet, or an empty folder.
 */
export function freeFolderName(name: string, usable: (path: string) => boolean): string {
	if (usable(name)) {
		return name;
	}
	for (let n = 2; ; n++) {
		const candidate = `${name} ${n}`;
		if (usable(candidate)) {
			return candidate;
		}
	}
}
