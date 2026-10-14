#!/usr/bin/env node
// Leak check: keeps internal names, private addresses, credentials and
// tooling traces out of tracked files, commit messages, tags and the bundle.
//
// Dev tool only: Node standard library, no network access.
//
// Rule sources
//   1. Built-in generic rules in this file (safe to commit).
//   2. A local denylist with repository-specific strings, one case-insensitive
//      regular expression per line (blank lines and lines starting with "#"
//      are ignored). It is read from, and merged between:
//        - the file .local/leak-denylist.txt (ignored by git), or --denylist <file>
//        - the LEAKCHECK_DENYLIST environment variable (newline separated)
//      The denylist is applied to file contents, tracked paths, commit
//      messages, ref names and the bundle.
//
// Output lists "<where>:<line>: <rule-id> <masked excerpt>" and never prints
// the matched text itself, so a CI log cannot become a leak.
//
// Usage
//   node scripts/leak-check.mjs [--history] [--range <rev-range>]
//                               [--denylist <file>] [--require-denylist]
//                               [--message-file <file>]
//   --history           also scan every reachable commit message and tag message
//   --range <range>     scan commit messages in a revision range instead
//   --require-denylist  fail when no denylist is available
//   --message-file      check one commit message file (used by the commit-msg hook)
//
// Exit codes: 0 clean, 1 findings, 2 usage error.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_DENYLIST = join('.local', 'leak-denylist.txt');
const DENYLIST_ENV = 'LEAKCHECK_DENYLIST';

// --- masking -----------------------------------------------------------------

/** Shows at most the first two characters of a match. */
export function mask(text) {
	if (text.length <= 4) {
		return '****';
	}
	return text.slice(0, 2) + '*'.repeat(Math.min(text.length - 2, 8));
}

// --- built-in text rules -------------------------------------------------------

/** @typedef {{ rule: string, excerpt: string }} Finding */
/** @typedef {Finding & { line: number }} LineFinding */

/** @returns {Finding[]} */
function ipv4Findings(line) {
	/** @type {Finding[]} */
	const found = [];
	const pattern = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g;
	for (const match of line.matchAll(pattern)) {
		const [a, b, c, d] = match.slice(1).map(Number);
		if ([a, b, c, d].some((n) => n > 255)) {
			continue;
		}
		const privateRange =
			a === 10 ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254);
		// 127.0.0.1 is the one loopback address expected, for local development.
		const loopback = a === 127 && match[0] !== '127.0.0.1';
		if (privateRange || loopback) {
			found.push({ rule: 'private-ip', excerpt: mask(match[0]) });
		}
	}
	return found;
}

const INTERNAL_SUFFIXES = [
	'internal',
	'corp',
	'lan',
	'local',
	'intranet',
	'home.arpa',
];

/** @returns {Finding[]} */
function hostFindings(line) {
	/** @type {Finding[]} */
	const found = [];
	for (const match of line.matchAll(/\bhttps?:\/\/([^\s/?#'"`<>()[\]{}\\]+)/gi)) {
		// Drop any user info and port from the authority.
		const authority = match[1] ?? '';
		const host = (authority.split('@').pop() ?? '')
			.split(':')[0]
			.toLowerCase()
			.replace(/\.$/, '');
		if (host === '' || host === 'localhost' || host.includes('$')) {
			continue;
		}
		const singleLabel = !host.includes('.');
		const internal = INTERNAL_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`));
		if (singleLabel || internal) {
			found.push({ rule: 'internal-hostname', excerpt: mask(match[0]) });
		}
	}
	const suffixes = INTERNAL_SUFFIXES.map((s) => s.replace('.', '\\.')).join('|');
	const bare = new RegExp(`(?<![\\w./*-])[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${suffixes})(?![\\w-])`, 'gi');
	for (const match of line.matchAll(bare)) {
		// Already reported as part of a URL above.
		if (found.some((f) => f.excerpt === mask(match[0]))) {
			continue;
		}
		found.push({ rule: 'internal-hostname', excerpt: mask(match[0]) });
	}
	return found;
}

// Prefixes that look like a task key but are well-known standards or formats.
// Matching tokens such as UTF-8, SHA-256, ISO-8601, RFC-7230 or CVE-2024-1234
// are not task keys.
const STANDARD_PREFIXES = new Set([
	'AES', 'BCP', 'CVE', 'ECMA', 'ES', 'HS', 'IEEE', 'ISO', 'MD', 'PEP', 'RFC',
	'RS', 'RSA', 'SHA', 'STD', 'TLS', 'UTF', 'WCAG', 'X',
]);

/** @returns {Finding[]} */
function taskIdFindings(line) {
	/** @type {Finding[]} */
	const found = [];
	for (const match of line.matchAll(/\b([A-Z][0-9A-Z]{1,9})-\d{1,6}\b/g)) {
		if (!STANDARD_PREFIXES.has(match[1] ?? '')) {
			found.push({ rule: 'task-id', excerpt: mask(match[0]) });
		}
	}
	return found;
}

const SECRET_RULES = [
	['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	['github-token', /\bgh[pousr]_[A-Za-z0-9]{36}\b/],
	['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
	['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
	['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
	['url-credential', /[?&](?:token|key|code|password|secret)=[A-Za-z0-9._~-]{16,}/i],
	['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
];

/** @returns {Finding[]} */
function secretFindings(line) {
	/** @type {Finding[]} */
	const found = [];
	for (const [rule, pattern] of SECRET_RULES) {
		const match = pattern.exec(line);
		if (match) {
			found.push({ rule, excerpt: mask(match[0]) });
		}
	}
	return found;
}

/**
 * Parses denylist text into compiled patterns.
 * A line that is not a valid regular expression is matched literally.
 */
export function parseDenylist(text) {
	/** @type {Array<{ rule: string, pattern: RegExp }>} */
	const entries = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) {
			continue;
		}
		let pattern;
		try {
			pattern = new RegExp(line, 'i');
		} catch {
			pattern = new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
		}
		entries.push({ rule: `denylist#${entries.length + 1}`, pattern });
	}
	return entries;
}

/**
 * @param {string} text
 * @param {ReturnType<typeof parseDenylist>} denylist
 * @returns {Finding[]}
 */
function denylistFindings(text, denylist) {
	/** @type {Finding[]} */
	const found = [];
	for (const { rule, pattern } of denylist) {
		const match = pattern.exec(text);
		if (match && match[0] !== '') {
			found.push({ rule, excerpt: mask(match[0]) });
		}
	}
	return found;
}

/**
 * Scans one line of text with every content rule.
 * @param {string} line
 * @param {{ denylist?: ReturnType<typeof parseDenylist>, skip?: string[] }} [options]
 *   skip: rule families to leave out ("task-id", "ip")
 * @returns {Finding[]}
 */
export function scanLine(line, options = {}) {
	const { denylist = [], skip = [] } = options;
	return [
		...(skip.includes('ip') ? [] : ipv4Findings(line)),
		...hostFindings(line),
		...(skip.includes('task-id') ? [] : taskIdFindings(line)),
		...secretFindings(line),
		...denylistFindings(line, denylist),
	];
}

// --- commit and tag message rules ---------------------------------------------

const MESSAGE_RULES = [
	['commit-trailer', /^\s*co-authored-by:/im],
	['signoff-trailer', /^\s*signed-off-by:/im],
	['generated-footer', /\bgenerated\s+(?:with|by|using)\b/i],
	['generated-footer', /\u{1F916}/u],
	['ai-generated', /\bai[- ]generated\b/i],
	['session-reference', /\b(?:session|conversation)[-_ ]?(?:id|url|link)\b/i],
	[
		'session-reference',
		/https?:\/\/\S*\/(?:sessions?|conversations?|chats?|share)\/[A-Za-z0-9_-]{6,}/i,
	],
];

const CONVENTIONAL_SUBJECT =
	/^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9._/-]+\))?!?: \S.*$/;
// Merge, revert and autosquash subjects, and the bare version that
// `npm version` writes, are exempt from the Conventional Commits format.
const SUBJECT_EXEMPT =
	/^(?:Merge |Revert "|fixup! |squash! |\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$)/;
const MAX_SUBJECT_LENGTH = 72;

/**
 * Scans a commit or tag message: message rules plus every content rule.
 * Returns findings with a 1-based line number.
 * @param {string} message
 * @param {{ denylist?: ReturnType<typeof parseDenylist> }} [options]
 * @returns {LineFinding[]}
 */
export function scanMessage(message, options = {}) {
	/** @type {LineFinding[]} */
	const findings = [];
	const lines = message.split(/\r?\n/);
	lines.forEach((line, index) => {
		for (const [rule, pattern] of MESSAGE_RULES) {
			const match = pattern.exec(line);
			if (match) {
				findings.push({ rule, excerpt: mask(match[0].trim()), line: index + 1 });
			}
		}
		for (const finding of scanLine(line, options)) {
			findings.push({ ...finding, line: index + 1 });
		}
	});
	return findings;
}

/**
 * Checks the subject line of a commit message (commit-msg hook only).
 * @param {string} message
 * @returns {LineFinding[]}
 */
export function checkSubject(message) {
	const subject = (message.split(/\r?\n/).find((l) => !l.startsWith('#')) ?? '').trim();
	if (SUBJECT_EXEMPT.test(subject)) {
		return [];
	}
	/** @type {LineFinding[]} */
	const findings = [];
	if (!CONVENTIONAL_SUBJECT.test(subject)) {
		findings.push({ rule: 'commit-subject-format', excerpt: '', line: 1 });
	}
	if (subject.length > MAX_SUBJECT_LENGTH) {
		findings.push({ rule: 'commit-subject-length', excerpt: '', line: 1 });
	}
	return findings;
}

// --- path rules ---------------------------------------------------------------

// Allow-list of top-level entries. Anything else that is tracked is flagged,
// which catches tool and agent files without having to name them.
const ROOT_FILES = new Set([
	'.editorconfig',
	'.gitattributes',
	'.gitignore',
	'.npmrc',
	'CHANGELOG.md',
	'CONTRIBUTING.md',
	'LICENSE',
	'README.md',
	'RELEASE-CHECKLIST.md',
	'SECURITY.md',
	'THIRD_PARTY_NOTICES.md',
	'esbuild.config.mjs',
	'eslint.config.mts',
	'manifest.json',
	'package-lock.json',
	'package.json',
	'styles.css',
	'tsconfig.eslint.json',
	'tsconfig.json',
	'version-bump.mjs',
	'versions.json',
	'vitest.config.ts',
]);
const ROOT_DIRS = new Set(['.github', '.githooks', 'docs', 'scripts', 'src', 'test']);
const GITHUB_ALLOWED = [
	/^\.github\/workflows\/[^/]+\.ya?ml$/,
	/^\.github\/ISSUE_TEMPLATE\/[^/]+$/,
	/^\.github\/pull_request_template\.md$/,
	/^\.github\/CODEOWNERS$/,
	/^\.github\/dependabot\.ya?ml$/,
	/^\.github\/FUNDING\.yml$/,
];

/**
 * Rules about where a tracked path may live.
 * @param {string} path
 * @param {ReturnType<typeof parseDenylist>} [denylist]
 * @returns {Finding[]}
 */
export function scanPath(path, denylist = []) {
	/** @type {Finding[]} */
	const findings = [];
	const parts = path.split('/');
	const top = parts[0] ?? '';
	if (parts.length === 1 ? !ROOT_FILES.has(top) : !ROOT_DIRS.has(top)) {
		findings.push({ rule: 'unexpected-root-entry', excerpt: mask(top) });
	} else if (top === '.github' && !GITHUB_ALLOWED.some((re) => re.test(path))) {
		findings.push({ rule: 'unexpected-github-file', excerpt: mask(path) });
	}
	findings.push(...denylistFindings(path, denylist));
	return findings;
}

// --- repository access ----------------------------------------------------------

function git(args, cwd) {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

function looksBinary(buffer) {
	return buffer.subarray(0, 8000).includes(0);
}

// Files whose content is machine generated; address and task-key shapes are
// not meaningful there, secrets and the denylist still are.
const GENERATED_FILES = new Set(['package-lock.json']);

// --- main ---------------------------------------------------------------------

function parseArgs(argv) {
	const options = {
		history: false,
		range: null,
		denylist: null,
		requireDenylist: false,
		messageFile: null,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const takesValue = () => {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith('--')) {
				throw new Error(`${arg} needs a value`);
			}
			i += 1;
			return value;
		};
		switch (arg) {
			case '--history':
				options.history = true;
				break;
			case '--range':
				options.range = takesValue();
				break;
			case '--denylist':
				options.denylist = takesValue();
				break;
			case '--require-denylist':
				options.requireDenylist = true;
				break;
			case '--message-file':
				options.messageFile = takesValue();
				break;
			default:
				throw new Error(`unknown argument ${arg}`);
		}
	}
	return options;
}

function loadDenylist(options, root) {
	const sources = [];
	const file = options.denylist ?? join(root, DEFAULT_DENYLIST);
	if (existsSync(file)) {
		sources.push(readFileSync(file, 'utf8'));
	} else if (options.denylist) {
		throw new Error(`denylist file not found: ${options.denylist}`);
	}
	const fromEnv = process.env[DENYLIST_ENV];
	if (fromEnv && fromEnv.trim() !== '') {
		sources.push(fromEnv);
	}
	const entries = parseDenylist(sources.join('\n'));
	return { entries, available: entries.length > 0 };
}

function report(out, where, finding) {
	const excerpt = finding.excerpt ? ` ${finding.excerpt}` : '';
	out.push(`${where}${finding.line ? `:${finding.line}` : ''}: ${finding.rule}${excerpt}`);
}

function run(argv) {
	const options = parseArgs(argv);
	const root = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
	const denylist = loadDenylist(options, root);
	if (options.requireDenylist && !denylist.available) {
		console.error(
			`leak-check: no denylist available (expected ${DEFAULT_DENYLIST} or ${DENYLIST_ENV})`,
		);
		return 1;
	}
	const out = [];

	if (options.messageFile) {
		const message = readFileSync(options.messageFile, 'utf8')
			.split(/\r?\n/)
			.filter((line) => !line.startsWith('#'))
			.join('\n');
		for (const finding of [
			...checkSubject(message),
			...scanMessage(message, { denylist: denylist.entries }),
		]) {
			report(out, 'commit-message', finding);
		}
		return finish(out);
	}

	// Tracked files: paths, then contents.
	const tracked = git(['ls-files', '-z'], root).split('\0').filter(Boolean);
	for (const path of tracked) {
		for (const finding of scanPath(path, denylist.entries)) {
			report(out, path, finding);
		}
	}
	for (const path of git(['ls-files', '-z', '-ci', '--exclude-standard'], root)
		.split('\0')
		.filter(Boolean)) {
		report(out, path, { rule: 'tracked-but-ignored', excerpt: '' });
	}
	for (const path of tracked) {
		scanFile(root, path, path, denylist.entries, out, {
			skip: GENERATED_FILES.has(path) ? ['ip', 'task-id'] : [],
		});
	}

	// The built bundle, when present (task keys and addresses are checked, but
	// minified identifiers make the key shape meaningless there).
	scanFile(root, 'main.js', 'main.js (bundle)', denylist.entries, out, {
		skip: ['task-id'],
	});

	// Branch and tag names.
	const refs = git(['for-each-ref', '--format=%(refname:short)'], root)
		.split('\n')
		.filter(Boolean);
	for (const ref of refs) {
		for (const finding of scanLine(ref, { denylist: denylist.entries })) {
			report(out, `ref:${ref}`, finding);
		}
	}

	// Commit and tag messages.
	if (options.history || options.range) {
		const revs = options.range
			? [options.range]
			: ['HEAD', '--branches', '--tags', '--remotes'];
		const log = git(['log', ...revs, '--format=%H%x1f%B%x1e'], root);
		for (const record of log.split('\x1e')) {
			const [sha, message] = record.replace(/^\n/, '').split('\x1f');
			if (!sha || message === undefined) {
				continue;
			}
			for (const finding of scanMessage(message, { denylist: denylist.entries })) {
				report(out, `commit:${sha.slice(0, 8)}`, finding);
			}
		}
		if (options.history) {
			const tags = git(['tag', '--list'], root).split('\n').filter(Boolean);
			for (const tag of tags) {
				const body = git(['tag', '--list', '--format=%(contents)', tag], root);
				for (const finding of scanMessage(body, { denylist: denylist.entries })) {
					report(out, `tag:${tag}`, finding);
				}
			}
		}
	}

	return finish(out);
}

function scanFile(root, path, label, denylist, out, options) {
	const full = join(root, path);
	if (!existsSync(full)) {
		return;
	}
	const buffer = readFileSync(full);
	if (looksBinary(buffer)) {
		return;
	}
	buffer
		.toString('utf8')
		.split(/\r?\n/)
		.forEach((line, index) => {
			for (const finding of scanLine(line, { denylist, ...options })) {
				report(out, label, { ...finding, line: index + 1 });
			}
		});
}

function finish(out) {
	if (out.length === 0) {
		console.log('leak-check: clean');
		return 0;
	}
	for (const line of out) {
		console.error(line);
	}
	console.error(`leak-check: ${out.length} finding${out.length === 1 ? '' : 's'}`);
	return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		process.exitCode = run(process.argv.slice(2));
	} catch (error) {
		console.error(`leak-check: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	}
}
