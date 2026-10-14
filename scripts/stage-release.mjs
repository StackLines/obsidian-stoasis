#!/usr/bin/env node
// Copies exactly the three release assets into a directory and checks that
// each one exists and is not empty. The release workflow uploads from that
// directory; run it locally as a dry run.
// Usage: node scripts/stage-release.mjs <output-dir>
// Dev tool only: Node standard library, no network access.

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const RELEASE_ASSETS = ['main.js', 'manifest.json', 'styles.css'];

const outDir = process.argv[2];
if (!outDir) {
	console.error('usage: node scripts/stage-release.mjs <output-dir>');
	process.exit(2);
}

mkdirSync(outDir, { recursive: true });
let failed = false;
for (const asset of RELEASE_ASSETS) {
	let size = 0;
	try {
		size = statSync(asset).size;
	} catch {
		// reported below
	}
	if (size === 0) {
		console.error(`stage-release: ${asset} is missing or empty (run the build first)`);
		failed = true;
		continue;
	}
	copyFileSync(asset, join(outDir, asset));
}
if (failed) {
	process.exit(1);
}

const staged = readdirSync(outDir).sort();
console.log(`stage-release: ${staged.map((f) => `${f} (${statSync(join(outDir, f)).size} bytes)`).join(', ')}`);
