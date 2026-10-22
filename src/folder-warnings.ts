// Warnings about a synced folder that something else may sync or change too:
// iCloud Drive, Dropbox, Obsidian Sync or git, and an attachment folder
// outside it. Each is shown once per folder; the plugin keeps which.
//
// The checks are guesses from names and settings, so the warnings say "may".
// They miss a git working tree whose .git is above the vault, which the
// app's vault paths cannot reach, and cloud folders on a mobile app too old
// to give full paths.

/** Something that also syncs or changes the folder, or keeps its attachments elsewhere. */
export type FolderRisk = 'icloud' | 'dropbox' | 'obsidian-sync' | 'git' | 'attachments';

/** What the checks read, through the app's file system adapter. */
export interface FolderProbe {
	/** The vault's configuration folder, such as ".obsidian". */
	configDir: string;
	/** The absolute path of a vault path on this device, when the app tells it. */
	fullPath(path: string): string | null;
	/** Whether a vault path exists, hidden ones too. */
	exists(path: string): Promise<boolean>;
	/** A vault file's text, or null when it is not there or cannot be read. */
	read(path: string): Promise<string | null>;
}

export interface FolderCheck {
	risks: FolderRisk[];
	/** Where new attachments go, when that is outside the folder. */
	attachments: string | null;
}

/** What else syncs or changes `folder`, a vault path; the empty string is the whole vault. */
export async function checkFolder(probe: FolderProbe, folder: string): Promise<FolderCheck> {
	const risks: FolderRisk[] = [];
	const full = decoded(probe.fullPath(folder));
	if (full !== null && inICloud(full)) {
		risks.push('icloud');
	}
	if (full !== null && inDropbox(full)) {
		risks.push('dropbox');
	}
	if (corePluginOn(await probe.read(`${probe.configDir}/core-plugins.json`), 'sync')) {
		risks.push('obsidian-sync');
	}
	if (await inGitTree(probe, folder)) {
		risks.push('git');
	}
	const attachments = attachmentsOutside(await appSettings(probe), folder);
	if (attachments !== null) {
		risks.push('attachments');
	}
	return { risks, attachments };
}

/**
 * The text of `app.json`; "{}" when there is none, as in a new vault, which
 * has the defaults; null when it is there but cannot be read.
 */
async function appSettings(probe: FolderProbe): Promise<string | null> {
	const path = `${probe.configDir}/app.json`;
	const text = await probe.read(path);
	if (text !== null) {
		return text;
	}
	return (await probe.exists(path)) ? null : '{}';
}

/** iCloud Drive on a Mac, and the Obsidian folder in iCloud on iOS. */
export function inICloud(fullPath: string): boolean {
	const segments = fullPath.split(/[\\/]/);
	return (
		segments.includes('Mobile Documents') ||
		segments.includes('com~apple~CloudDocs') ||
		segments.includes('iCloud~md~obsidian') ||
		segments.includes('iCloudDrive')
	);
}

/** A folder named "Dropbox", or "Dropbox (Team)", anywhere above. */
export function inDropbox(fullPath: string): boolean {
	return fullPath.split(/[\\/]/).some((segment) => /^Dropbox( \(.+\))?$/.test(segment));
}

/**
 * Whether a core plugin is on, from `core-plugins.json`: a map of plugin ids
 * to switches, or in older versions a list of the plugins that are on.
 */
export function corePluginOn(json: string | null, id: string): boolean {
	const value = parseJson(json);
	if (Array.isArray(value)) {
		return value.includes(id);
	}
	return typeof value === 'object' && value !== null && (value as Record<string, unknown>)[id] === true;
}

/** A `.git` folder in the vault root, or in the folder or any folder around it. */
async function inGitTree(probe: FolderProbe, folder: string): Promise<boolean> {
	const segments = folder === '' ? [] : folder.split('/');
	const candidates = ['.git', ...segments.map((_, i) => `${segments.slice(0, i + 1).join('/')}/.git`)];
	for (const candidate of candidates) {
		if (await probe.exists(candidate)) {
			return true;
		}
	}
	return pluginList(await probe.read(`${probe.configDir}/community-plugins.json`)).includes('obsidian-git');
}

function pluginList(json: string | null): unknown[] {
	const value = parseJson(json);
	return Array.isArray(value) ? value : [];
}

/**
 * Where Obsidian puts new attachments for notes in `folder`, when that is
 * outside it, from `app.json`'s "Default location for new attachments":
 * "/" is the vault root (also the default), "./" or "./sub" next to the note,
 * anything else a vault folder. Settings that could not be read, or are not
 * a JSON object, say nothing.
 */
export function attachmentsOutside(json: string | null, folder: string): string | null {
	const value = parseJson(json);
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null;
	}
	const setting = (value as Record<string, unknown>)['attachmentFolderPath'];
	const path = typeof setting === 'string' ? setting : '/';
	if (path === '.' || path.startsWith('./')) {
		return null;
	}
	const where = path.replace(/^\/+|\/+$/g, '');
	// Everything in the vault is inside the whole vault.
	if (folder === '' || where === folder || where.startsWith(`${folder}/`)) {
		return null;
	}
	return where === '' ? '/' : where;
}

/** A full path as a file URL, which the mobile app may give, made plain. */
function decoded(path: string | null): string | null {
	if (path === null || !path.startsWith('file:')) {
		return path;
	}
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

function parseJson(json: string | null): unknown {
	if (json === null) {
		return null;
	}
	try {
		return JSON.parse(json) as unknown;
	} catch {
		return null;
	}
}

/** The warning for one risk, for a notice. `folder` is empty for the whole vault. */
export function describeRisk(risk: FolderRisk, folder: string, attachments: string | null): string {
	const vault = folder === '';
	const subject = vault ? 'This vault' : `"${folder}"`;
	switch (risk) {
		case 'icloud':
			return (
				`${subject} seems to be in iCloud Drive, which may sync it too. The two can undo each ` +
				"other's changes or make duplicates; keep the vault out of iCloud Drive to sync it with Stoasis."
			);
		case 'dropbox':
			return (
				`${subject} seems to be in Dropbox, which may sync it too. The two can undo each other's ` +
				'changes or make duplicates; keep the vault out of Dropbox to sync it with Stoasis.'
			);
		case 'obsidian-sync':
			return vault
				? 'Obsidian Sync is turned on in this vault and syncs its notes too. The two can undo each ' +
						"other's changes or make duplicates; turn Obsidian Sync off for this vault, or sync only a " +
						'folder with Stoasis and exclude that folder in Obsidian Sync.'
				: `Obsidian Sync is turned on in this vault and may sync "${folder}" too. If it does, ` +
						"exclude the folder in Obsidian Sync's settings so that only Stoasis syncs it.";
		case 'git':
			return (
				`${subject} may be in a git working tree. A pull or checkout would change its notes, and ` +
				'Stoasis syncs those changes to your other devices like any edit.'
			);
		case 'attachments':
			return (
				`New attachments go to "${attachments ?? '/'}", outside "${folder}". Stoasis does not sync ` +
				'attachments yet; when it does, it will sync only those inside the folder. To keep them ' +
				'with the notes, set "Default location for new attachments" in Files and links to the ' +
				'folder or next to the note.'
			);
	}
}

/** The key that records a warning was shown for a folder. */
export function warningKey(folder: string, risk: FolderRisk): string {
	// The whole vault has an empty folder; no real folder has an empty name.
	return `${folder}\n${risk}`;
}
