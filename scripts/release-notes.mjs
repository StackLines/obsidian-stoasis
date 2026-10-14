#!/usr/bin/env node
// Prints the CHANGELOG.md section for a version to standard output.
// Usage: node scripts/release-notes.mjs <version>
// Exits 1 when the section is missing or empty.
// Dev tool only: Node standard library, no network access.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** @returns {string} the trimmed body of the "## [version]" section, or "" */
export function extractNotes(changelog, version) {
	const lines = changelog.split(/\r?\n/);
	const heading = new RegExp(`^##\\s+\\[?${version.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')}\\]?(?:\\s|$)`);
	const start = lines.findIndex((line) => heading.test(line));
	if (start === -1) {
		return '';
	}
	const body = [];
	for (const line of lines.slice(start + 1)) {
		if (/^##\s/.test(line)) {
			break;
		}
		body.push(line);
	}
	return body.join('\n').trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const version = process.argv[2];
	if (!version) {
		console.error('usage: node scripts/release-notes.mjs <version>');
		process.exit(2);
	}
	const notes = extractNotes(readFileSync('CHANGELOG.md', 'utf8'), version);
	if (notes === '') {
		console.error(`release-notes: no CHANGELOG.md section for ${version}`);
		process.exit(1);
	}
	process.stdout.write(`${notes}\n`);
}
