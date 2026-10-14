import { describe, expect, it } from 'vitest';
import {
	checkSubject,
	parseDenylist,
	scanLine,
	scanMessage,
	scanPath,
} from '../scripts/leak-check.mjs';

// Fixtures are assembled at run time so this file does not itself trip the
// check it tests. Values are invented.
const dot = (...parts: Array<string | number>) => parts.join('.');
const dash = (...parts: Array<string | number>) => parts.join('-');

const rulesFor = (line: string) => scanLine(line).map((f) => f.rule);

describe('addresses', () => {
	it('flags private and special ranges', () => {
		for (const ip of [
			dot(10, 1, 2, 3),
			dot(172, 16, 0, 9),
			dot(172, 31, 255, 1),
			dot(192, 168, 1, 20),
			dot(100, 64, 0, 1),
			dot(169, 254, 1, 1),
			dot(127, 0, 0, 2),
		]) {
			expect(rulesFor(`host ${ip} here`)).toContain('private-ip');
		}
	});

	it('allows documentation ranges, public addresses and the loopback literal', () => {
		for (const ip of [
			dot(192, 0, 2, 7),
			dot(198, 51, 100, 7),
			dot(203, 0, 113, 7),
			dot(172, 32, 0, 1),
			dot(8, 8, 8, 8),
			dot(127, 0, 0, 1),
		]) {
			expect(rulesFor(`host ${ip} here`)).toEqual([]);
		}
	});

	it('does not read version numbers as addresses', () => {
		expect(rulesFor('version 10.2.0 and 1.2.3.4.5')).toEqual([]);
	});
});

describe('hostnames', () => {
	it('flags internal suffixes and single-label hosts in URLs', () => {
		expect(rulesFor(`https://${dot('wiki', 'corp')}/x`)).toContain('internal-hostname');
		expect(rulesFor(`https://${dot('box', 'internal')}`)).toContain('internal-hostname');
		expect(rulesFor(`http://${'buildhost'}:8080/`)).toContain('internal-hostname');
		expect(rulesFor(`ssh to ${dot('nas', 'lan')} now`)).toContain('internal-hostname');
	});

	it('sees the host behind user info', () => {
		expect(rulesFor(`https://alice:pw@${dot('example', 'test')}/`)).toEqual([]);
		expect(rulesFor(`https://alice:pw@${'buildhost'}/`)).toContain('internal-hostname');
	});

	it('allows public, example and placeholder hosts', () => {
		for (const line of [
			'https://example.test/path',
			'https://notes.example.test',
			'http://localhost:8080',
			'https://github.com/StackLines/obsidian-stoa',
			'obsidian://stoa?server=<url>&code=<code>',
			'ignore *.local and .local/ here',
		]) {
			expect(rulesFor(line)).toEqual([]);
		}
	});
});

describe('task keys', () => {
	it('flags the key shape', () => {
		expect(rulesFor(`see ${dash('ABC', 123)} for details`)).toContain('task-id');
	});

	it('allows standard identifiers', () => {
		for (const token of ['UTF-8', 'SHA-256', 'ISO-8601', 'RFC-7230', 'CVE-2024-1234']) {
			expect(rulesFor(`uses ${token}`)).toEqual([]);
		}
	});
});

describe('secrets', () => {
	it('flags credential shapes', () => {
		const samples: Array<[string, string]> = [
			['private-key', `-----BEGIN ${'RSA '}PRIVATE KEY-----`],
			['github-token', `ghp${'_'}${'a'.repeat(36)}`],
			['aws-key', `AKIA${'A'.repeat(16)}`],
			['slack-token', `xoxb${'-'}${'1'.repeat(12)}`],
			['url-credential', `https://example.test/?token=${'a1'.repeat(10)}`],
			['bearer-token', `Authorization: Bearer ${'a1'.repeat(15)}`],
		];
		for (const [rule, text] of samples) {
			expect(rulesFor(text)).toContain(rule);
		}
	});

	it('allows documented placeholders', () => {
		expect(rulesFor('obsidian://stoa?server=<url>&code=<code>')).toEqual([]);
		expect(rulesFor('Authorization: Bearer ${key}')).toEqual([]);
	});

	it('never echoes the match in an excerpt', () => {
		const token = `ghp${'_'}${'b'.repeat(36)}`;
		const [finding] = scanLine(token);
		expect(finding?.excerpt).not.toContain(token);
		expect(finding?.excerpt.length).toBeLessThan(token.length);
	});
});

describe('denylist', () => {
	it('parses patterns, comments and literal fallbacks', () => {
		const list = parseDenylist('# comment\n\nfoo+bar\n(unclosed\n');
		expect(list.map((e) => e.rule)).toEqual(['denylist#1', 'denylist#2']);
		expect(scanLine('a FOOOBAR b', { denylist: list })[0]?.rule).toBe('denylist#1');
		expect(scanLine('x (unclosed y', { denylist: list })[0]?.rule).toBe('denylist#2');
	});

	it('reports the rule number and a masked excerpt only', () => {
		const list = parseDenylist('sensitive-word');
		const [finding] = scanLine('text with Sensitive-Word inside', { denylist: list });
		expect(finding?.rule).toBe('denylist#1');
		expect(finding?.excerpt).not.toContain('nsitive');
	});

	it('applies to tracked paths', () => {
		const list = parseDenylist('secret-name');
		expect(scanPath('docs/secret-name.md', list).map((f) => f.rule)).toContain('denylist#1');
	});
});

describe('messages', () => {
	it('flags trailers, footers and session references', () => {
		const samples: Array<[string, string]> = [
			['commit-trailer', `feat: x\n\nCo-Authored-${'By'}: Someone <a@example.test>`],
			['generated-footer', `feat: x\n\n${'Generated'} with a tool`],
			['ai-generated', 'chore: AI-generated cleanup'],
			['session-reference', 'chore: x\n\nsession id 1234'],
			['session-reference', `chore: x\n\nhttps://example.test/chat/${'a1b2c3d4'}`],
		];
		for (const [rule, message] of samples) {
			expect(scanMessage(message).map((f) => f.rule)).toContain(rule);
		}
	});

	it('accepts an ordinary message', () => {
		expect(scanMessage('fix: handle empty code\n\nThe parser accepted blanks.')).toEqual([]);
	});

	it('checks the subject format and length', () => {
		expect(checkSubject('feat: add thing')).toEqual([]);
		expect(checkSubject('feat(scope): add thing')).toEqual([]);
		expect(checkSubject('Merge branch main')).toEqual([]);
		expect(checkSubject('Added a thing').map((f) => f.rule)).toEqual([
			'commit-subject-format',
		]);
		expect(checkSubject(`feat: ${'x'.repeat(80)}`).map((f) => f.rule)).toEqual([
			'commit-subject-length',
		]);
	});
});

describe('paths', () => {
	it('allows the expected layout', () => {
		for (const path of [
			'README.md',
			'src/main.ts',
			'.github/workflows/ci.yml',
			'.github/pull_request_template.md',
			'.githooks/commit-msg',
			'scripts/leak-check.mjs',
		]) {
			expect(scanPath(path)).toEqual([]);
		}
	});

	it('flags unexpected top-level entries without naming tools', () => {
		expect(scanPath('NOTES.md').map((f) => f.rule)).toContain('unexpected-root-entry');
		expect(scanPath('.somedir/config.json').map((f) => f.rule)).toContain(
			'unexpected-root-entry',
		);
		expect(scanPath('.github/instructions.md').map((f) => f.rule)).toContain(
			'unexpected-github-file',
		);
	});
});
