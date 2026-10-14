import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRelease } from '../scripts/check-release.mjs';
import { readmeVersion } from '../scripts/check-readme-status.mjs';
import { installDev } from '../scripts/install-dev.mjs';
import { extractNotes } from '../scripts/release-notes.mjs';
import { RELEASE_ASSETS, stageRelease } from '../scripts/stage-release.mjs';

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

describe('release assets', () => {
	const dirs: string[] = [];

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), 'stoasis-test-'));
		dirs.push(dir);
		return dir;
	}

	/** A fake build output with the three assets and some unrelated files. */
	function builtRoot(): string {
		const root = tempDir();
		writeFileSync(join(root, 'main.js'), '"use strict";');
		writeFileSync(join(root, 'manifest.json'), JSON.stringify({ id: 'stoasis' }));
		writeFileSync(join(root, 'styles.css'), '.stoasis-status {}');
		writeFileSync(join(root, 'package.json'), '{}');
		writeFileSync(join(root, 'main.js.map'), '{}');
		return root;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('are exactly main.js, manifest.json and styles.css', () => {
		expect(RELEASE_ASSETS).toEqual(['main.js', 'manifest.json', 'styles.css']);
	});

	it('are staged alone into a new directory', () => {
		const out = join(tempDir(), 'assets');
		expect(stageRelease(builtRoot(), out)).toEqual(RELEASE_ASSETS);
	});

	it('are not staged when one is missing or empty', () => {
		const root = builtRoot();
		writeFileSync(join(root, 'styles.css'), '');
		expect(() => stageRelease(root, join(tempDir(), 'assets'))).toThrow('styles.css');
	});

	it('are not staged into a directory that already holds files', () => {
		const out = tempDir();
		writeFileSync(join(out, 'other.txt'), 'x');
		expect(() => stageRelease(builtRoot(), out)).toThrow('not empty');
	});

	it('are installed into the plugin folder of a vault', () => {
		const vault = tempDir();
		mkdirSync(join(vault, '.obsidian'));
		const pluginDir = installDev(builtRoot(), vault);
		expect(pluginDir).toBe(join(vault, '.obsidian', 'plugins', 'stoasis'));
		expect(readdirSync(pluginDir).sort()).toEqual(RELEASE_ASSETS);
	});

	it('are not installed into a folder that is not a vault', () => {
		expect(() => installDev(builtRoot(), tempDir())).toThrow('not a vault');
	});

	it('are installed under another config folder when a vault uses one', () => {
		const vault = tempDir();
		mkdirSync(join(vault, '.config'));
		expect(installDev(builtRoot(), vault, '.config')).toBe(
			join(vault, '.config', 'plugins', 'stoasis'),
		);
	});
});

describe('workflows', () => {
	const workflowDir = new URL('../.github/workflows/', import.meta.url);
	const workflows = readdirSync(workflowDir).map((name) => ({
		name,
		text: readFileSync(new URL(name, workflowDir), 'utf8'),
	}));

	it('pin every action to a full commit SHA with its version noted above', () => {
		for (const { name, text } of workflows) {
			const lines = text.split('\n');
			lines.forEach((line, index) => {
				const uses = /\buses:\s*(\S+)/.exec(line);
				if (!uses) {
					return;
				}
				expect(uses[1], `${name}:${index + 1}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
				const above = lines.slice(Math.max(0, index - 2), index).join('\n');
				expect(above, `${name}:${index + 1}`).toMatch(/# [\w.-]+\/[\w.-]+ v\d+\.\d+\.\d+/);
			});
		}
	});

	it('default to no write access', () => {
		for (const { name, text } of workflows) {
			expect(/^permissions:\s*(?:\{\}|\n\s+contents: read\s*$)/m.test(text), name).toBe(true);
		}
	});
});
