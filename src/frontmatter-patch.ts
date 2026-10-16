// Applying a frontmatter patch from the server, following the tagging
// contract `stoasis/2` (section 3 of the server's tagging contract). The
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

const SCAN_ACTOR = /^scan:[a-z0-9._-]{1,64}$/;

/** A patch exactly as the contract shapes it. */
export interface PropertyPatch {
	tagsAdd: string[];
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
	if (!isRecord(value) || !sameKeys(value, ['tags_add', 'set', 'actor'])) {
		return null;
	}
	const { tags_add: tagsAdd, set, actor } = value;
	if (typeof actor !== 'string' || (actor !== 'agent' && !isScanActor(actor))) {
		return null;
	}
	if (!isStringList(tagsAdd) || !isRecord(set)) {
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
	return { tagsAdd: [...tagsAdd], set: result, actor };
}

/** True when applying the patch would change nothing in any note: no tags and no keys. */
export function isEmptyPatch(patch: PropertyPatch): boolean {
	return patch.tagsAdd.length === 0 && Object.keys(patch.set).length === 0;
}

/**
 * Applies a patch to a note's frontmatter. Pure: `date` is the day for the
 * stamp, `YYYY-MM-DD`. Returns a new mapping with existing keys in their
 * places and new ones appended in the contract's order, or the input itself
 * when nothing would change.
 */
export function applyPatch(
	frontmatter: Readonly<Record<string, unknown>>,
	patch: PropertyPatch,
	date: string,
): Readonly<Record<string, unknown>> {
	const updates = new Map<string, unknown>();

	const tags = mergeTags(frontmatter, patch.tagsAdd);
	if (tags !== null) {
		updates.set('tags', tags);
	}
	for (const [key, value] of Object.entries(patch.set)) {
		const present = Object.prototype.hasOwnProperty.call(frontmatter, key);
		const existing = present ? frontmatter[key] : undefined;
		if (BASE_KEYS.has(key)) {
			// Fill-only: a present value of any kind, even "" or false, is kept.
			if (!present || existing === null) {
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

/** The tag list after appending, or null when `tags` stays as written. */
function mergeTags(frontmatter: Readonly<Record<string, unknown>>, add: readonly string[]): unknown[] | null {
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
	return appended.length > 0 ? [...current, ...appended] : null;
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
