import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards for code that ships in main.js. The plugin runs on mobile, makes no
// network requests in this version, and follows the community plugin
// guidelines, so these patterns must not appear under src/.

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return sourceFiles(path);
		}
		return entry.name.endsWith('.ts') ? [path] : [];
	});
}

const FORBIDDEN: Array<[string, RegExp]> = [
	['network request', /\b(?:fetch|requestUrl|request)\s*\(/],
	['network API', /\b(?:WebSocket|XMLHttpRequest|EventSource|sendBeacon)\b/],
	['Node or Electron module', /from\s+['"](?:node:|fs|path|os|crypto|child_process|electron)['"/]/],
	['require call', /\brequire\s*\(/],
	['console output', /\bconsole\.\w+\s*\(/],
	['HTML injection', /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/],
	['global app object', /\bwindow\.app\b/],
	['regular expression lookbehind', /\(\?<[=!]/],
	['dynamic code', /\b(?:eval|Function)\s*\(/],
];

describe('shipped source', () => {
	const files = sourceFiles(SRC);

	it('finds the source files', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const [label, pattern] of FORBIDDEN) {
		it(`contains no ${label}`, () => {
			const offenders = files.filter((file) => pattern.test(readFileSync(file, 'utf8')));
			expect(offenders).toEqual([]);
		});
	}
});
