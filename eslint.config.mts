import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'tsconfig.eslint.json',
		'test/tsconfig.json',
		'scripts',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.mts',
						'vitest.config.ts',
						'manifest.json',
					],
					// Config files outside src/ may use Node typings; src/ may not.
					defaultProject: 'tsconfig.eslint.json',
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['test/**/*.ts', 'vitest.config.ts'],
		rules: {
			// Tests run in Node, never on a device.
			'obsidianmd/no-nodejs-modules': 'off',
			// Tests build throwaway vaults on disk, outside the app.
			'obsidianmd/hardcoded-config-path': 'off',
		},
	},
	{
		files: ['src/settings.ts'],
		rules: {
			// The declarative settings API needs app 1.13; the manifest minimum is lower.
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
		},
	},
	{
		files: ['test/settings.test.ts'],
		rules: {
			// The tab still renders through display() for apps older than 1.13.
			'@typescript-eslint/no-deprecated': 'off',
		},
	},
);
