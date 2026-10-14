#!/usr/bin/env node
// Verifies that a release tag, manifest.json, package.json and versions.json
// agree. Usage: node scripts/check-release.mjs <tag> (tag without a prefix).
// Dev tool only: Node standard library, no network access.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * @param {{ tag: string, manifest: Record<string, string>, pkg: Record<string, string>, versions: Record<string, string> }} input
 * @returns {string[]} problems, empty when the release is consistent
 */
export function checkRelease({ tag, manifest, pkg, versions }) {
	const problems = [];
	if (!SEMVER.test(tag)) {
		problems.push(`tag "${tag}" is not a bare version such as 1.2.3 (no prefix)`);
	}
	if (manifest.version !== tag) {
		problems.push(`manifest.json version "${manifest.version}" differs from tag "${tag}"`);
	}
	if (pkg.version !== tag) {
		problems.push(`package.json version "${pkg.version}" differs from tag "${tag}"`);
	}
	if (!(tag in versions)) {
		problems.push(`versions.json has no entry for "${tag}"`);
	} else if (versions[tag] !== manifest.minAppVersion) {
		problems.push(
			`versions.json maps "${tag}" to "${versions[tag]}" but manifest.json minAppVersion is "${manifest.minAppVersion}"`,
		);
	}
	return problems;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const tag = process.argv[2];
	if (!tag) {
		console.error('usage: node scripts/check-release.mjs <tag>');
		process.exit(2);
	}
	const problems = checkRelease({
		tag,
		manifest: readJson('manifest.json'),
		pkg: readJson('package.json'),
		versions: readJson('versions.json'),
	});
	if (problems.length > 0) {
		for (const problem of problems) {
			console.error(`check-release: ${problem}`);
		}
		process.exit(1);
	}
	console.log(`check-release: ${tag} is consistent`);
}
