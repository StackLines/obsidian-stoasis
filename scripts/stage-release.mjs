#!/usr/bin/env node
// Copies exactly the three release assets into a new or empty directory and
// checks that each one exists and is not empty. The release workflow uploads
// from that directory; run it locally as a dry run.
// Usage: node scripts/stage-release.mjs <output-dir>
// Dev tool only: Node standard library, no network access.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELEASE_ASSETS = ['main.js', 'manifest.json', 'styles.css'];

/**
 * Returns the release assets in `root` that are missing or empty.
 * @param {string} root
 * @returns {string[]}
 */
export function missingAssets(root) {
	return RELEASE_ASSETS.filter((asset) => {
		const path = join(root, asset);
		return !existsSync(path) || statSync(path).size === 0;
	});
}

/**
 * Copies the release assets from `root` into `outDir`.
 * @param {string} root
 * @param {string} outDir must not exist yet, or be empty
 * @returns {string[]} the file names now in `outDir`, sorted
 */
export function stageRelease(root, outDir) {
	const missing = missingAssets(root);
	if (missing.length > 0) {
		throw new Error(`${missing.join(', ')} missing or empty (run the build first)`);
	}
	if (existsSync(outDir) && readdirSync(outDir).length > 0) {
		throw new Error(`${outDir} is not empty`);
	}
	mkdirSync(outDir, { recursive: true });
	for (const asset of RELEASE_ASSETS) {
		copyFileSync(join(root, asset), join(outDir, asset));
	}
	return readdirSync(outDir).sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const outDir = process.argv[2];
	if (!outDir) {
		console.error('usage: node scripts/stage-release.mjs <output-dir>');
		process.exit(2);
	}
	try {
		const staged = stageRelease('.', outDir);
		console.log(
			`stage-release: ${staged.map((f) => `${f} (${statSync(join(outDir, f)).size} bytes)`).join(', ')}`,
		);
	} catch (error) {
		console.error(`stage-release: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
