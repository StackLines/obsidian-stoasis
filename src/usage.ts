// How much of its quota a space uses, in the words of the settings tab.

import type { SpaceUsage } from './api';

/** The share of the quota from which the person is warned. */
export const WARN_AT = 0.9;

const UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const;

/** A size for people: 1024 steps, at most one decimal, none for whole numbers. */
export function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < UNITS.length - 1) {
		value /= 1024;
		unit++;
	}
	if (unit === 0) {
		return `${value} bytes`;
	}
	const rounded = Math.round(value * 10) / 10;
	return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} ${UNITS[unit]}`;
}

export interface UsageText {
	/** For example "1.2 GB of 10 GB". */
	summary: string;
	/** Set from 90% of the quota. */
	warning: string;
}

export function describeUsage(usage: SpaceUsage): UsageText {
	if (usage.quotaBytes <= 0) {
		return { summary: `${formatBytes(usage.totalBytes)} used`, warning: '' };
	}
	const summary = `${formatBytes(usage.totalBytes)} of ${formatBytes(usage.quotaBytes)}`;
	if (usage.totalBytes < usage.quotaBytes * WARN_AT) {
		return { summary, warning: '' };
	}
	const percent = Math.floor((usage.totalBytes / usage.quotaBytes) * 100);
	return {
		summary,
		warning:
			usage.totalBytes >= usage.quotaBytes
				? 'This space is full: new attachments are refused, and notes still sync.'
				: `This space is ${percent}% full. At the limit new attachments are refused; notes still sync.`,
	};
}
