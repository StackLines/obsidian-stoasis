#!/usr/bin/env node
// Copies the built release assets into a vault for manual testing:
// <vault>/<config folder>/plugins/<manifest id>/. Build first with
// `npm run build`. The config folder is .obsidian unless the vault uses
// another one.
// Usage: npm run install-dev -- <path-to-vault> [config-folder]
// Dev tool only: Node standard library, no network access.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RELEASE_ASSETS, missingAssets } from './stage-release.mjs';

export const DEFAULT_CONFIG_FOLDER = '.obsidian';

/**
 * Copies the release assets from `root` into the plugin folder of `vault`.
 * @param {string} root the repository root, holding the built assets
 * @param {string} vault a vault folder, which must already hold its config folder
 * @param {string} [configFolder] the vault's config folder name
 * @returns {string} the plugin folder the assets were copied into
 */
export function installDev(root, vault, configFolder = DEFAULT_CONFIG_FOLDER) {
	const configDir = join(vault, configFolder);
	if (!existsSync(configDir) || !statSync(configDir).isDirectory()) {
		throw new Error(
			`${vault} is not a vault (no ${configFolder} folder); open it in Obsidian once first`,
		);
	}
	const missing = missingAssets(root);
	if (missing.length > 0) {
		throw new Error(`${missing.join(', ')} missing or empty (run npm run build first)`);
	}
	const { id } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
	const pluginDir = join(configDir, 'plugins', id);
	mkdirSync(pluginDir, { recursive: true });
	for (const asset of RELEASE_ASSETS) {
		copyFileSync(join(root, asset), join(pluginDir, asset));
	}
	return pluginDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const vault = process.argv[2];
	if (!vault) {
		console.error('usage: npm run install-dev -- <path-to-vault> [config-folder]');
		process.exit(2);
	}
	try {
		const pluginDir = installDev('.', resolve(vault), process.argv[3]);
		console.log(`install-dev: copied ${RELEASE_ASSETS.join(', ')} to ${pluginDir}`);
		console.log('install-dev: reload Obsidian, then enable the plugin under Community plugins');
	} catch (error) {
		console.error(`install-dev: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
