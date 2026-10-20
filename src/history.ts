import type { NoteVersion } from './api';

const REASONS: Record<string, string> = {
	idle: 'Edit',
	manual: 'Edit',
	agent: 'Agent edit',
	scan: 'Scanner edit',
	restore: 'Restored',
};

/** What cut a version, in words; an unknown reason reads as an edit. */
export function reasonLabel(reason: string): string {
	return REASONS[reason] ?? 'Edit';
}

/** A size in bytes for a person: B below a kilobyte, then KB and MB. */
export function sizeLabel(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const kb = bytes / 1024;
	return kb < 1024 ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

/** One line for the list: when, who, what, how big. */
export function describeVersion(version: NoteVersion): string {
	const when = new Date(version.createdAt);
	const at = Number.isNaN(when.getTime()) ? version.createdAt : when.toLocaleString();
	const who = version.actorLabel === '' ? '' : ` by ${version.actorLabel}`;
	const size = version.size > 0 ? `, ${sizeLabel(version.size)}` : '';
	return `${at}: ${reasonLabel(version.reason)}${who}${size}`;
}
