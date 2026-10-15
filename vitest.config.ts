import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
	resolve: {
		alias: {
			// Unit tests import pure modules only; the real module needs the app.
			obsidian: fileURLToPath(
				new URL('./test/stubs/obsidian.ts', import.meta.url),
			),
		},
	},
	test: {
		environment: 'node',
		include: ['test/**/*.test.ts'],
		setupFiles: ['test/setup.ts'],
	},
});
