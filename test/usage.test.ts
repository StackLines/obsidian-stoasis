import { describe, expect, it } from 'vitest';
import type { SpaceUsage } from '../src/api';
import { describeUsage, formatBytes } from '../src/usage';

const GB = 1024 ** 3;
const usage = (totalBytes: number, quotaBytes = 10 * GB): SpaceUsage => ({
	notesBytes: 0,
	versionsBytes: 0,
	attachmentsBytes: 0,
	derivedBytes: 0,
	totalBytes,
	quotaBytes,
});

describe('formatBytes', () => {
	it('writes sizes for people', () => {
		expect(formatBytes(0)).toBe('0 bytes');
		expect(formatBytes(1023)).toBe('1023 bytes');
		expect(formatBytes(1024)).toBe('1 KB');
		expect(formatBytes(482113)).toBe('470.8 KB');
		expect(formatBytes(1.2 * GB)).toBe('1.2 GB');
		expect(formatBytes(10 * GB)).toBe('10 GB');
		expect(formatBytes(2048 * GB)).toBe('2 TB');
	});
});

describe('describeUsage', () => {
	it('says how much of the quota is used and warns only from 90%', () => {
		expect(describeUsage(usage(1.2 * GB))).toEqual({ summary: '1.2 GB of 10 GB', warning: '' });
		expect(describeUsage(usage(9 * GB - 1)).warning).toBe('');
		expect(describeUsage(usage(9 * GB)).warning).toMatch(/90% full/);
		expect(describeUsage(usage(9.5 * GB)).warning).toMatch(/95% full/);
		expect(describeUsage(usage(10 * GB)).warning).toMatch(/is full/);
		expect(describeUsage(usage(11 * GB)).warning).toMatch(/is full/);
	});

	it('does not divide by a quota of zero', () => {
		expect(describeUsage(usage(5, 0))).toEqual({ summary: '5 bytes used', warning: '' });
	});
});
