// The scanner's progress in the words of the Brain section.

import type { ScanRun, ScanStatus } from './api';

/** How long ago `iso` was, for people; empty when it is not a time. */
export function ago(iso: string | null, now: Date): string {
	const time = iso === null ? NaN : Date.parse(iso);
	if (Number.isNaN(time)) {
		return '';
	}
	const minutes = Math.max(0, Math.floor((now.getTime() - time) / 60_000));
	if (minutes < 1) {
		return 'just now';
	}
	const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'} ago`;
	if (minutes < 60) {
		return unit(minutes, 'minute');
	}
	return minutes < 60 * 24 ? unit(Math.floor(minutes / 60), 'hour') : unit(Math.floor(minutes / (60 * 24)), 'day');
}

/**
 * Lines on what the scanner has done and has yet to do for `spaceId`. Empty
 * when scanning is off, which the section already says.
 */
export function describeScanStatus(status: ScanStatus, spaceId: string, now: Date): string[] {
	if (!status.scanEnabled || !status.operatorEnabled) {
		return [];
	}
	const lines: string[] = [];
	const space = status.spaces.find((s) => s.spaceId === spaceId);
	const pending = space === undefined ? status.llm.pending : space.llmPending;
	lines.push(
		pending === 0
			? 'No notes are waiting to be read.'
			: `${pending} ${pending === 1 ? 'note is' : 'notes are'} waiting to be read.`,
	);
	if (status.llm.paused) {
		const since = ago(status.llm.pausedSince, now);
		lines.push(
			`The scanner is paused${status.llm.pausedReason === 'rate_limited' ? ' while the server is being rate limited' : ''}` +
				`${since === '' ? '' : `, for ${since.replace(/ ago$/, '')}`}.`,
		);
	}
	const last = describeRun(status.lastRuns.llm ?? status.lastRuns.deterministic ?? status.lastRuns.base, now);
	if (last !== '') {
		lines.push(last);
	}
	return lines;
}

function describeRun(run: ScanRun | null, now: Date): string {
	if (run === null) {
		return 'The scanner has not run yet.';
	}
	if (run.outcome === null) {
		return 'A scan is running now.';
	}
	const when = ago(run.finishedAt, now);
	const outcome = { ok: 'finished', partial: 'finished in part', failed: 'failed', skipped: 'was skipped' }[run.outcome];
	return `The last scan ${outcome}${when === '' ? '' : ` ${when}`}.`;
}
