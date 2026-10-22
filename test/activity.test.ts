import { describe, expect, it } from 'vitest';
import {
	ACTIVITY_LIMIT,
	ActivityLog,
	describeContact,
	describeEntry,
	emptyActivity,
	formatWhen,
	MERGE_WINDOW_MS,
	parseActivity,
	splitPath,
} from '../src/activity';

const T0 = new Date(2026, 9, 23, 14, 5).getTime();
const NOW = new Date(2026, 9, 23, 15, 5);

describe('ActivityLog', () => {
	it('keeps the newest change first', () => {
		const log = new ActivityLog(emptyActivity());
		log.record({ direction: 'upload', action: 'new', path: 'A/a.md' }, T0);
		log.record({ direction: 'download', action: 'new', path: 'A/b.md' }, T0 + 1000);
		expect(log.entries.map((e) => e.path)).toEqual(['A/b.md', 'A/a.md']);
	});

	it('merges a burst of edits to one note into one entry', () => {
		const log = new ActivityLog(emptyActivity());
		log.record({ direction: 'upload', action: 'edit', path: 'A/a.md' }, T0);
		log.record({ direction: 'upload', action: 'edit', path: 'A/a.md' }, T0 + 5_000);
		log.record({ direction: 'upload', action: 'edit', path: 'A/a.md' }, T0 + 5_000 + MERGE_WINDOW_MS);
		expect(log.entries).toHaveLength(1);
		expect(log.entries[0]?.at).toBe(T0 + 5_000 + MERGE_WINDOW_MS);
		log.record({ direction: 'upload', action: 'edit', path: 'A/a.md' }, T0 + 5_000 + MERGE_WINDOW_MS * 3);
		expect(log.entries).toHaveLength(2);
	});

	it('does not merge edits in different directions, other notes, or other actions', () => {
		const log = new ActivityLog(emptyActivity());
		log.record({ direction: 'upload', action: 'edit', path: 'A/a.md' }, T0);
		log.record({ direction: 'download', action: 'edit', path: 'A/a.md' }, T0 + 1);
		log.record({ direction: 'upload', action: 'edit', path: 'A/b.md' }, T0 + 2);
		log.record({ direction: 'upload', action: 'delete', path: 'A/a.md' }, T0 + 3);
		expect(log.entries).toHaveLength(4);
	});

	it('keeps the last entries only', () => {
		const log = new ActivityLog(emptyActivity());
		for (let i = 0; i < ACTIVITY_LIMIT + 10; i++) {
			log.record({ direction: 'download', action: 'new', path: `n${i}.md` }, T0 + i);
		}
		expect(log.entries).toHaveLength(ACTIVITY_LIMIT);
		expect(log.entries[0]?.path).toBe(`n${ACTIVITY_LIMIT + 9}.md`);
	});

	it('remembers when the server was last reached', () => {
		const log = new ActivityLog(emptyActivity());
		expect(log.contactAt).toBeNull();
		log.touchContact(T0);
		expect(log.contactAt).toBe(T0);
	});
});

describe('parseActivity', () => {
	it('keeps well-formed entries, newest first, and drops the rest', () => {
		const parsed = parseActivity({
			contactAt: T0,
			entries: [
				{ at: 1, direction: 'upload', action: 'edit', path: 'a.md' },
				{ at: 3, direction: 'download', action: 'rename', path: 'c.md', from: 'b.md' },
				{ at: 2, direction: 'sideways', action: 'edit', path: 'a.md' },
				{ at: 'x', direction: 'upload', action: 'edit', path: 'a.md' },
				{ at: 4, direction: 'upload', action: 'edit', path: '' },
				null,
			],
		});
		expect(parsed.contactAt).toBe(T0);
		expect(parsed.entries.map((e) => e.at)).toEqual([3, 1]);
		expect(parsed.entries[0]?.from).toBe('b.md');
	});

	it('survives damaged data', () => {
		expect(parseActivity(null)).toEqual(emptyActivity());
		expect(parseActivity({ entries: 'no', contactAt: 'no' })).toEqual(emptyActivity());
	});
});

describe('describing', () => {
	it('formats the local time and splits a path', () => {
		expect(formatWhen(T0)).toBe('2026-10-23 14:05');
		expect(splitPath('Notes/Work/Plan.md')).toEqual({ name: 'Plan.md', folder: 'Notes/Work' });
		expect(splitPath('Plan.md')).toEqual({ name: 'Plan.md', folder: '' });
	});

	it('says what happened', () => {
		expect(describeEntry({ at: T0, direction: 'upload', action: 'edit', path: 'a.md' })).toBe('Uploaded, edited');
		expect(describeEntry({ at: T0, direction: 'download', action: 'delete', path: 'a.md' })).toBe('Downloaded, deleted');
	});

	it('says when the server was last reached and what synced last', () => {
		const last = { at: T0, direction: 'upload', action: 'edit', path: 'Notes/Plan.md' } as const;
		expect(describeContact(T0, true, last, NOW)).toEqual([
			'Last server contact: now.',
			'Last note synced: Plan.md, 1 hour ago.',
		]);
		expect(describeContact(T0, false, undefined, NOW)).toEqual([
			'Last server contact: 2026-10-23 14:05, 1 hour ago.',
			'No note has synced since this was switched on.',
		]);
		expect(describeContact(null, false, undefined, NOW)[0]).toBe('This device has not reached the server yet.');
	});
});
