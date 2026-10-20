import { describe, expect, it } from 'vitest';
import type { ScanStatus } from '../src/api';
import { ago, describeScanStatus } from '../src/scan-status';

const NOW = new Date('2026-10-16T12:00:00+00:00');
const status = (change: Partial<ScanStatus> = {}): ScanStatus => ({
	scanEnabled: true,
	operatorEnabled: true,
	lastRuns: { base: null, deterministic: null, llm: null },
	llm: { pending: 0, paused: false, pausedReason: null, pausedSince: null },
	spaces: [],
	...change,
});

describe('ago', () => {
	it('says how long ago, in the largest whole unit', () => {
		expect(ago('2026-10-16T11:59:40+00:00', NOW)).toBe('just now');
		expect(ago('2026-10-16T11:59:00+00:00', NOW)).toBe('1 minute ago');
		expect(ago('2026-10-16T11:15:00+00:00', NOW)).toBe('45 minutes ago');
		expect(ago('2026-10-16T09:00:00+00:00', NOW)).toBe('3 hours ago');
		expect(ago('2026-10-13T12:00:00+00:00', NOW)).toBe('3 days ago');
		expect(ago('2026-10-17T12:00:00+00:00', NOW)).toBe('just now');
		expect(ago(null, NOW)).toBe('');
		expect(ago('not a time', NOW)).toBe('');
	});
});

describe('describeScanStatus', () => {
	it('says nothing while scanning is off, whoever switched it', () => {
		expect(describeScanStatus(status({ scanEnabled: false }), 's1', NOW)).toEqual([]);
		expect(describeScanStatus(status({ operatorEnabled: false }), 's1', NOW)).toEqual([]);
	});

	it('counts the notes of the space shown, and the last scan', () => {
		const lines = describeScanStatus(
			status({
				llm: { pending: 757, paused: false, pausedReason: null, pausedSince: null },
				spaces: [{ spaceId: 's1', scanMode: 'auto', llmPending: 1 }],
				lastRuns: {
					base: null,
					deterministic: null,
					llm: { outcome: 'partial', startedAt: null, finishedAt: '2026-10-16T11:30:00+00:00' },
				},
			}),
			's1',
			NOW,
		);
		expect(lines).toEqual(['1 note is waiting to be read.', 'The last scan finished in part 30 minutes ago.']);
	});

	it('falls back to the total for a space the server did not list', () => {
		const lines = describeScanStatus(status({ llm: { pending: 4, paused: false, pausedReason: null, pausedSince: null } }), 'other', NOW);
		expect(lines[0]).toBe('4 notes are waiting to be read.');
		expect(lines[1]).toBe('The scanner has not run yet.');
	});

	it('says when the scanner is paused, and when a scan is running', () => {
		const lines = describeScanStatus(
			status({
				llm: { pending: 3, paused: true, pausedReason: 'rate_limited', pausedSince: '2026-10-16T11:55:00+00:00' },
				lastRuns: { base: null, deterministic: null, llm: { outcome: null, startedAt: null, finishedAt: null } },
			}),
			's1',
			NOW,
		);
		expect(lines).toEqual([
			'3 notes are waiting to be read.',
			'The scanner is paused while the server is being rate limited, for 5 minutes.',
			'A scan is running now.',
		]);
	});
});
