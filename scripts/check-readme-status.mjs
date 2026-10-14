#!/usr/bin/env node
// Fails when the version named in the README Status section differs from
// manifest.json. The Status section carries a line of the form
//   **Current version:** `1.2.3`
// Dev tool only: Node standard library, no network access.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION_LINE = /\*\*Current version:\*\*\s*`([^`]+)`/;

/** @returns {string | null} the version named in the README, if any */
export function readmeVersion(readme) {
	const match = VERSION_LINE.exec(readme);
	return match ? (match[1] ?? null) : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
	const named = readmeVersion(readFileSync('README.md', 'utf8'));
	if (named === null) {
		console.error('check-readme-status: README.md has no "Current version" line');
		process.exit(1);
	}
	if (named !== manifest.version) {
		console.error(
			`check-readme-status: README names ${named} but manifest.json is ${manifest.version}`,
		);
		process.exit(1);
	}
	console.log(`check-readme-status: README matches ${manifest.version}`);
}
