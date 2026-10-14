import { describe, expect, it } from 'vitest';
import { checkRelease } from '../scripts/check-release.mjs';
import { readmeVersion } from '../scripts/check-readme-status.mjs';
import { extractNotes } from '../scripts/release-notes.mjs';

const ok = {
	tag: '1.2.3',
	manifest: { version: '1.2.3', minAppVersion: '1.5.0' },
	pkg: { version: '1.2.3' },
	versions: { '1.2.3': '1.5.0' },
};

describe('checkRelease', () => {
	it('accepts a consistent release', () => {
		expect(checkRelease(ok)).toEqual([]);
	});

	it('accepts a pre-release tag', () => {
		const tag = '1.2.3-beta.1';
		expect(
			checkRelease({
				tag,
				manifest: { version: tag, minAppVersion: '1.5.0' },
				pkg: { version: tag },
				versions: { [tag]: '1.5.0' },
			}),
		).toEqual([]);
	});

	it('rejects a prefixed tag', () => {
		const problems = checkRelease({ ...ok, tag: 'v1.2.3' });
		expect(problems.join('\n')).toContain('bare version');
	});

	it('rejects mismatched versions', () => {
		expect(
			checkRelease({ ...ok, manifest: { ...ok.manifest, version: '1.2.4' } }),
		).toHaveLength(1);
		expect(checkRelease({ ...ok, pkg: { version: '1.2.4' } })).toHaveLength(1);
	});

	it('rejects a missing or wrong versions.json entry', () => {
		expect(checkRelease({ ...ok, versions: {} })[0]).toContain('no entry');
		expect(checkRelease({ ...ok, versions: { '1.2.3': '1.0.0' } })[0]).toContain(
			'minAppVersion',
		);
	});
});

describe('extractNotes', () => {
	const changelog = [
		'# Changelog',
		'',
		'## [Unreleased]',
		'',
		'## [1.2.3] - 2026-01-02',
		'',
		'### Added',
		'- A thing.',
		'',
		'## [1.2.2] - 2026-01-01',
		'- Older.',
	].join('\n');

	it('returns the section for a version', () => {
		expect(extractNotes(changelog, '1.2.3')).toBe('### Added\n- A thing.');
	});

	it('returns an empty string for an unknown version', () => {
		expect(extractNotes(changelog, '9.9.9')).toBe('');
	});

	it('does not match a version that only shares a prefix', () => {
		expect(extractNotes(changelog, '1.2')).toBe('');
	});
});

describe('readmeVersion', () => {
	it('reads the version from the status line', () => {
		expect(readmeVersion('x\n**Current version:** `0.0.1`\ny')).toBe('0.0.1');
	});

	it('returns null when the line is absent', () => {
		expect(readmeVersion('no status here')).toBeNull();
	});
});
