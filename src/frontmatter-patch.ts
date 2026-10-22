// Applying a frontmatter patch from the server, following the tagging
// contract `stoasis/3` (section 3 of the server's tagging contract). The
// server normalises a patch; this side checks its shape, then merges it into
// a note's frontmatter without touching any key the user owns.

/** The `set` keys, in the order the server sends them. */
const SET_KEYS = [
	'brain-id',
	'brain-created',
	'brain-schema',
	'brain-type',
	'brain-summary',
	'brain-people',
	'brain-topics',
	'brain-tasks',
	'brain-open-points',
] as const;

/** The base keys: the note's identity, written only by the server's scanner, and only once. */
const BASE_KEYS: ReadonlySet<string> = new Set(['brain-id', 'brain-created', 'brain-schema']);
const LIST_KEYS: ReadonlySet<string> = new Set(['brain-people', 'brain-topics', 'brain-tasks', 'brain-open-points']);
const STAMP = 'brain-tagged';

/** New keys are appended in this order. */
const APPEND_ORDER: readonly string[] = ['tags', ...SET_KEYS, STAMP];

/** Most tags a patch may remove. */
const MAX_REMOVALS = 5;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SCAN_ACTOR = /^scan:[a-z0-9._-]{1,64}$/;

/** A patch exactly as the contract shapes it. */
export interface PropertyPatch {
	tagsAdd: string[];
	/** Tags to drop from the note, from the scanner only; absent when the patch removes none. */
	tagsRemove?: string[];
	/** Only `brain-*` keys of the contract, never `tags` or `brain-tagged`. */
	set: Record<string, string | string[]>;
	/** `agent`, or `scan:<alias>` for the server's scanner. */
	actor: string;
}

export function isScanActor(actor: string): boolean {
	return SCAN_ACTOR.test(actor);
}

/**
 * Reads a patch from the server's JSON. Anything not shaped exactly as the
 * contract says is refused (null) rather than guessed at.
 */
export function readPatch(value: unknown): PropertyPatch | null {
	if (!isRecord(value)) {
		return null;
	}
	const removes = Object.prototype.hasOwnProperty.call(value, 'tags_remove');
	if (!sameKeys(value, removes ? ['tags_add', 'tags_remove', 'set', 'actor'] : ['tags_add', 'set', 'actor'])) {
		return null;
	}
	const { tags_add: tagsAdd, tags_remove: tagsRemove, set, actor } = value;
	if (typeof actor !== 'string' || (actor !== 'agent' && !isScanActor(actor))) {
		return null;
	}
	if (!isStringList(tagsAdd) || !isRecord(set)) {
		return null;
	}
	if (removes && !validRemovals(tagsRemove, tagsAdd, actor)) {
		return null;
	}
	const result: Record<string, string | string[]> = {};
	for (const [key, item] of Object.entries(set)) {
		if (!(SET_KEYS as readonly string[]).includes(key)) {
			return null;
		}
		if (BASE_KEYS.has(key) && !isScanActor(actor)) {
			return null;
		}
		if (LIST_KEYS.has(key) ? !isStringList(item) : typeof item !== 'string') {
			return null;
		}
		result[key] = item as string | string[];
	}
	return removes
		? { tagsAdd: [...tagsAdd], tagsRemove: [...(tagsRemove as string[])], set: result, actor }
		: { tagsAdd: [...tagsAdd], set: result, actor };
}

/** The `tags_remove` rules of the contract (section 2.5): scanner only, 1 to 5 tags, none also added. */
function validRemovals(remove: unknown, add: readonly string[], actor: string): boolean {
	if (!isScanActor(actor) || !isStringList(remove) || remove.length === 0 || remove.length > MAX_REMOVALS) {
		return false;
	}
	const added = new Set(add.map(normaliseTag));
	return !remove.some((tag) => {
		const normalised = normaliseTag(tag);
		return normalised !== null && added.has(normalised);
	});
}

/** True when applying the patch would change nothing in any note: no tags and no keys. */
export function isEmptyPatch(patch: PropertyPatch): boolean {
	return patch.tagsAdd.length === 0 && (patch.tagsRemove?.length ?? 0) === 0 && Object.keys(patch.set).length === 0;
}

/**
 * Applies a patch to a note's frontmatter. Pure: `date` is the day for the
 * stamp, `YYYY-MM-DD`. Returns a new mapping with existing keys in their
 * places and new ones appended in the contract's order, or the input itself
 * when nothing would change.
 *
 * `noteId` is the note's own id from the plugin's index of server ids, never
 * read from the note: it lets a scanner patch replace the id of a copy
 * (section 3.4). Without it base keys are fill-only.
 */
export function applyPatch(
	frontmatter: Readonly<Record<string, unknown>>,
	patch: PropertyPatch,
	date: string,
	noteId?: string,
): Readonly<Record<string, unknown>> {
	const updates = new Map<string, unknown>();

	const tags = mergeTags(frontmatter, patch.tagsAdd, patch.tagsRemove ?? []);
	if (tags !== null) {
		updates.set('tags', tags);
	}
	const copied = isCopy(frontmatter, patch, noteId);
	for (const [key, value] of Object.entries(patch.set)) {
		const present = Object.prototype.hasOwnProperty.call(frontmatter, key);
		const existing = present ? frontmatter[key] : undefined;
		if (BASE_KEYS.has(key)) {
			// Fill-only: a present value of any kind, even "" or false, is kept,
			// except the id and date of a copy, which are replaced (section 3.4).
			if (!present || existing === null || (copied && (key === 'brain-id' || key === 'brain-created'))) {
				updates.set(key, value);
			}
		} else if (!present || !sameValue(existing, value)) {
			updates.set(key, copy(value));
		}
	}
	if (updates.size === 0) {
		return frontmatter;
	}
	updates.set(STAMP, `${date} by ${patch.actor}`);

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		result[key] = updates.has(key) ? updates.get(key) : value;
		updates.delete(key);
	}
	for (const key of APPEND_ORDER) {
		if (updates.has(key)) {
			result[key] = updates.get(key);
		}
	}
	return result;
}

/**
 * Whether a scanner patch gives the note its own id in place of another
 * note's: the patch's id is exactly `noteId`, and the one present is a
 * lowercase canonical UUID that is not.
 */
function isCopy(frontmatter: Readonly<Record<string, unknown>>, patch: PropertyPatch, noteId: string | undefined): boolean {
	const present = frontmatter['brain-id'];
	return (
		noteId !== undefined &&
		isScanActor(patch.actor) &&
		patch.set['brain-id'] === noteId &&
		typeof present === 'string' &&
		CANONICAL_UUID.test(present) &&
		present !== noteId
	);
}

/** The tag list after removing and appending, or null when `tags` stays as written. */
function mergeTags(
	frontmatter: Readonly<Record<string, unknown>>,
	add: readonly string[],
	remove: readonly string[],
): unknown[] | null {
	const existing = frontmatter['tags'];
	let current: unknown[];
	if (Array.isArray(existing)) {
		current = existing;
	} else if (typeof existing === 'string') {
		current = splitTags(existing);
	} else if (existing === null || existing === undefined) {
		current = [];
	} else {
		// A number, a mapping: not ours to interpret.
		return null;
	}
	// Removals first, by normalised value, every occurrence; other items keep their order.
	const dropped = new Set(remove.map(normaliseTag).filter((tag): tag is string => tag !== null));
	const kept = current.filter((tag) => {
		const normalised = typeof tag === 'string' ? normaliseTag(tag) : null;
		return normalised === null || !dropped.has(normalised);
	});
	const removed = kept.length !== current.length;
	current = kept;
	const seen = new Set<string>();
	for (const tag of current) {
		const normalised = typeof tag === 'string' ? normaliseTag(tag) : null;
		if (normalised !== null) {
			seen.add(normalised);
		}
	}
	const appended: string[] = [];
	for (const tag of add) {
		const normalised = normaliseTag(tag);
		if (normalised !== null && !seen.has(normalised)) {
			seen.add(normalised);
			appended.push(tag);
		}
	}
	return appended.length > 0 || removed ? [...current, ...appended] : null;
}

/** Tags written as one string: split on commas and whitespace. */
export function splitTags(text: string): string[] {
	return text.split(/[,\p{White_Space}]+/u).filter((tag) => tag !== '');
}

/**
 * A tag in the form the contract compares (section 2.2), or null when it
 * normalises away: empty, or only digits.
 */
export function normaliseTag(raw: string): string | null {
	let tag = raw
		.normalize('NFC')
		.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
		.replace(/^#+/, '')
		.toLowerCase()
		.replace(/[\p{White_Space}_]+/gu, '-')
		.replace(/[^\p{L}\p{M}\p{N}/-]/gu, '')
		.replace(/[-/]+/g, (run) => (run.includes('/') ? '/' : '-'));
	tag = tag.replace(/^[-/]+|[-/]+$/g, '');
	return tag === '' || /^\p{Nd}+$/u.test(tag) ? null : tag;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => own.includes(key));
}

function sameValue(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
	}
	return a === b;
}

function copy<T>(value: T): T {
	return Array.isArray(value) ? ([...value] as T) : value;
}
