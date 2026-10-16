// Tag now: ask the server to suggest frontmatter properties for a note, show
// what would change and where each value came from, and write it into the
// note when asked. The server keeps nothing. This module only turns a
// suggestion into a proposal and applies it; src/tag-modal.ts shows it.

import type { PropertyMatch, Suggestion } from './api';
import { applyPatch, splitTags, type PropertyPatch } from './frontmatter-patch';

/** The server takes at most 1 MiB of text, counted both in characters and in UTF-8 bytes. */
export const MAX_TAG_TEXT = 1024 * 1024;

export function tooLongToTag(markdown: string): boolean {
	return markdown.length > MAX_TAG_TEXT || new TextEncoder().encode(markdown).length > MAX_TAG_TEXT;
}

/** One key that would change, and what the server matched to suggest it. */
export interface ProposalLine {
	key: string;
	/** What the key would become, or what it gains, for reading. */
	text: string;
	sources: string[];
}

export interface Proposal {
	lines: ProposalLine[];
	/** Matches that explain no line: their values are already in the note. */
	others: string[];
	/** Contract errors, for reading. Any error means nothing is applied. */
	errors: string[];
	/** The patch to apply, or null when there is nothing to apply. */
	patch: PropertyPatch | null;
}

/** The day for the `brain-tagged` stamp: UTC, like `brain-created`. */
export function stampDate(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/**
 * What applying the suggestion to `frontmatter` would change. A proposal with
 * errors or without lines has no patch, so it can never be applied in part.
 */
export function propose(
	frontmatter: Readonly<Record<string, unknown>>,
	suggestion: Suggestion,
	date: string,
): Proposal {
	const errors = suggestion.errors.map(describeContractError);
	const patch = suggestion.patch;
	const result = patch === null ? frontmatter : applyPatch(frontmatter, patch, date);

	const used = new Set<PropertyMatch>();
	const lines: ProposalLine[] = [];
	for (const [key, value] of Object.entries(result)) {
		const had = Object.prototype.hasOwnProperty.call(frontmatter, key);
		if (had && sameValue(frontmatter[key], value)) {
			continue;
		}
		const before = had ? frontmatter[key] : undefined;
		const added = Array.isArray(value) ? value.filter((item) => !listOf(before).includes(item)) : [];
		const sources: string[] = [];
		for (const match of suggestion.matches) {
			if (explains(match, key, added)) {
				sources.push(describeMatch(match));
				used.add(match);
			}
		}
		lines.push({ key, text: describeChange(key, before, value, suggestion.matches), sources });
	}

	const others = suggestion.matches.filter((match) => !used.has(match)).map(describeMatch);
	const applicable = errors.length === 0 && lines.length > 0;
	return { lines, others, errors, patch: applicable ? patch : null };
}

/**
 * The frontmatter a proposal was made for, to tell later whether it is still
 * the same. The server's lists replace the note's, so a proposal made before
 * the frontmatter changed could drop what was added since.
 */
export function reviewedFrontmatter(frontmatter: Record<string, unknown>): string {
	return JSON.stringify(sorted(frontmatter));
}

/** Whether the frontmatter is still the one a proposal was made for. */
export function stillReviewed(frontmatter: Record<string, unknown>, reviewed: string): boolean {
	return reviewedFrontmatter(frontmatter) === reviewed;
}

/** A value with its object keys in order, so key order does not count as a change. */
function sorted(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sorted);
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
		);
	}
	return value;
}

/**
 * Applies the patch inside `processFrontMatter`, which hands over the note's
 * frontmatter as it is now: keys are rewritten in the contract's order. True
 * when anything changed.
 */
export function applyToFrontmatter(frontmatter: Record<string, unknown>, patch: PropertyPatch, date: string): boolean {
	const result = applyPatch(frontmatter, patch, date);
	if (result === frontmatter) {
		return false;
	}
	for (const key of Object.keys(frontmatter)) {
		delete frontmatter[key];
	}
	Object.assign(frontmatter, result);
	return true;
}

/** Whether a match is where one of a key's new values came from. */
function explains(match: PropertyMatch, key: string, added: readonly unknown[]): boolean {
	if (match.kind === 'person' && key === 'brain-people') {
		return added.includes(`[[${match.name}]]`);
	}
	if (match.kind === 'topic' && key === 'brain-topics') {
		return added.includes(match.id);
	}
	return false;
}

/** "Alice Stone: wikilink", or "Topic Garden: name in text (matched "gardens")". */
export function describeMatch(match: PropertyMatch): string {
	const name = match.name !== '' ? match.name : match.matched;
	const label = match.kind === 'topic' ? `Topic ${name}` : name;
	const reason = match.reason.replace(/_/g, ' ');
	let text = reason === '' ? label : `${label}: ${reason}`;
	if (match.matched !== '' && match.matched !== name) {
		text += ` (matched "${match.matched}")`;
	}
	return text;
}

function describeChange(key: string, before: unknown, after: unknown, matches: readonly PropertyMatch[]): string {
	if (!Array.isArray(after)) {
		return typeof before === 'string' && before !== '' ? `${String(after)} (was ${before})` : String(after);
	}
	const shown = (item: unknown) => (key === 'brain-topics' ? topicName(item, matches) : String(item));
	const previous = listOf(before);
	const added = after.filter((item) => !previous.includes(item));
	const removed = previous.filter((item) => !after.includes(item));
	const parts: string[] = [];
	if (added.length > 0) {
		parts.push(`adds ${added.map(shown).join(', ')}`);
	}
	if (removed.length > 0) {
		parts.push(`removes ${removed.map(shown).join(', ')}`);
	}
	return parts.length > 0 ? parts.join('; ') : after.length === 0 ? '(empty)' : after.map(shown).join(', ');
}

/** A topic is stored by id; show its name when the server matched it. */
function topicName(id: unknown, matches: readonly PropertyMatch[]): string {
	const match = matches.find((m) => m.kind === 'topic' && m.id === id && m.name !== '');
	return match === undefined ? String(id) : match.name;
}

function listOf(value: unknown): unknown[] {
	if (Array.isArray(value)) {
		return value;
	}
	return typeof value === 'string' ? splitTags(value) : [];
}

export function describeContractError(error: { key: string | null; code: string }): string {
	if (error.code === 'frontmatter_unparseable') {
		return "The note's frontmatter can't be read. Fix it first, then tag the note again.";
	}
	const code = error.code.replace(/_/g, ' ');
	return error.key === null ? `The suggestion was refused: ${code}.` : `${error.key}: ${code}.`;
}

function sameValue(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
	}
	return a === b;
}
