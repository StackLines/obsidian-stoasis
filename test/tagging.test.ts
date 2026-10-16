import { describe, expect, it } from 'vitest';
import type { PropertyMatch, Suggestion } from '../src/api';
import { readPatch } from '../src/frontmatter-patch';
import {
	MAX_TAG_TEXT,
	applyToFrontmatter,
	describeContractError,
	describeMatch,
	propose,
	stampDate,
	tooLongToTag,
} from '../src/tagging';

const TOPIC = '0b6c1f7e-2d4a-4e8b-9c3f-5a7d1e2b4c6f';
const DATE = '2026-10-16';

const person: PropertyMatch = { kind: 'person', id: 'p1', name: 'Alice Stone', reason: 'wikilink', matched: 'Alice Stone' };
const topic: PropertyMatch = { kind: 'topic', id: TOPIC, name: 'Garden', reason: 'name_in_text', matched: 'gardens' };

function suggestion(patch: unknown, matches: PropertyMatch[] = [], errors: Suggestion['errors'] = []): Suggestion {
	return { patch: patch === null ? null : readPatch(patch), matches, errors };
}

describe('propose', () => {
	it('shows one line per key that changes, with where each value came from', () => {
		const proposal = propose(
			{ title: 'Plans', 'brain-people': ['[[Bob Moss]]'] },
			suggestion(
				{
					tags_add: ['garden'],
					set: { 'brain-people': ['[[Bob Moss]]', '[[Alice Stone]]'], 'brain-topics': [TOPIC] },
					actor: 'agent',
				},
				[person, topic],
			),
			DATE,
		);
		expect(proposal.lines).toEqual([
			{ key: 'brain-people', text: 'adds [[Alice Stone]]', sources: ['Alice Stone: wikilink'] },
			{ key: 'tags', text: 'adds garden', sources: [] },
			{ key: 'brain-topics', text: 'adds Garden', sources: ['Topic Garden: name in text (matched "gardens")'] },
			{ key: 'brain-tagged', text: `${DATE} by agent`, sources: [] },
		]);
		expect(proposal.others).toEqual([]);
		expect(proposal.errors).toEqual([]);
		expect(proposal.patch).not.toBeNull();
	});

	it('says what a replaced value was', () => {
		const proposal = propose(
			{ 'brain-type': 'meeting' },
			suggestion({ tags_add: [], set: { 'brain-type': 'idea' }, actor: 'agent' }),
			DATE,
		);
		expect(proposal.lines[0]).toEqual({ key: 'brain-type', text: 'idea (was meeting)', sources: [] });
	});

	it('has nothing to apply when the note already has everything', () => {
		const proposal = propose(
			{ 'brain-people': ['[[Alice Stone]]'] },
			suggestion({ tags_add: [], set: { 'brain-people': ['[[Alice Stone]]'] }, actor: 'agent' }, [person]),
			DATE,
		);
		expect(proposal.lines).toEqual([]);
		expect(proposal.patch).toBeNull();
		expect(proposal.others).toEqual(['Alice Stone: wikilink']);
	});

	it('has nothing to apply without a patch', () => {
		const proposal = propose({}, suggestion(null), DATE);
		expect(proposal).toEqual({ lines: [], others: [], errors: [], patch: null });
	});

	it('never applies part of a patch that came with errors', () => {
		const proposal = propose(
			{},
			suggestion({ tags_add: ['a'], set: {}, actor: 'agent' }, [], [{ key: 'brain-topics', code: 'invalid_item' }]),
			DATE,
		);
		expect(proposal.errors).toEqual(['brain-topics: invalid item.']);
		expect(proposal.patch).toBeNull();
	});

	it('asks to fix frontmatter the server cannot read', () => {
		const proposal = propose({}, suggestion(null, [], [{ key: null, code: 'frontmatter_unparseable' }]), DATE);
		expect(proposal.errors).toEqual(["The note's frontmatter can't be read. Fix it first, then tag the note again."]);
		expect(proposal.patch).toBeNull();
	});
});

describe('describing', () => {
	it('names people and topics with the reason and what matched', () => {
		expect(describeMatch(person)).toBe('Alice Stone: wikilink');
		expect(describeMatch(topic)).toBe('Topic Garden: name in text (matched "gardens")');
		expect(describeMatch({ kind: 'topic', id: TOPIC, name: '', reason: '', matched: 'gardens' })).toBe('Topic gardens');
	});

	it('explains contract errors in words', () => {
		expect(describeContractError({ key: null, code: 'invalid_actor' })).toBe('The suggestion was refused: invalid actor.');
		expect(describeContractError({ key: 'brain-type', code: 'too_long' })).toBe('brain-type: too long.');
	});
});

describe('applyToFrontmatter', () => {
	const patch = readPatch({ tags_add: ['garden'], set: { 'brain-type': 'idea' }, actor: 'agent' })!;

	it('rewrites the frontmatter in the contract order and keeps other keys', () => {
		const frontmatter: Record<string, unknown> = { title: 'Plans', 'brain-type': 'meeting', aliases: ['p'] };
		expect(applyToFrontmatter(frontmatter, patch, DATE)).toBe(true);
		expect(Object.entries(frontmatter)).toEqual([
			['title', 'Plans'],
			['brain-type', 'idea'],
			['aliases', ['p']],
			['tags', ['garden']],
			['brain-tagged', `${DATE} by agent`],
		]);
	});

	it('changes nothing, not even the stamp, when there is nothing to add', () => {
		const frontmatter: Record<string, unknown> = { tags: ['Garden'], 'brain-type': 'idea', 'brain-tagged': 'old' };
		expect(applyToFrontmatter(frontmatter, patch, DATE)).toBe(false);
		expect(frontmatter).toEqual({ tags: ['Garden'], 'brain-type': 'idea', 'brain-tagged': 'old' });
	});
});

describe('limits', () => {
	it('dates the stamp in UTC', () => {
		expect(stampDate(new Date('2026-10-16T23:30:00-05:00'))).toBe('2026-10-17');
	});

	it('refuses text over 1 MiB in characters or in UTF-8 bytes', () => {
		expect(tooLongToTag('a'.repeat(MAX_TAG_TEXT))).toBe(false);
		expect(tooLongToTag('a'.repeat(MAX_TAG_TEXT + 1))).toBe(true);
		expect(tooLongToTag('é'.repeat(MAX_TAG_TEXT / 2 + 1))).toBe(true);
	});
});
