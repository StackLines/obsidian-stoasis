import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_ACTION } from '../src/protocol';

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as T;
}

interface Manifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	description: string;
	isDesktopOnly: boolean;
}

const manifest = readJson<Manifest>('manifest.json');
const versions = readJson<Record<string, string>>('versions.json');
const pkg = readJson<{ version: string }>('package.json');

describe('manifest.json', () => {
	it('has a lowercase id without "obsidian"', () => {
		expect(manifest.id).toMatch(/^[a-z0-9-]+$/);
		expect(manifest.id).not.toContain('obsidian');
	});

	it('uses the id as the pairing link action', () => {
		expect(manifest.id).toBe(PROTOCOL_ACTION);
	});

	it('runs on mobile', () => {
		expect(manifest.isDesktopOnly).toBe(false);
	});

	it('is listed in versions.json with the same minimum app version', () => {
		expect(Object.keys(versions)).toContain(manifest.version);
		expect(versions[manifest.version]).toBe(manifest.minAppVersion);
	});

	it('matches the package version', () => {
		expect(manifest.version).toBe(pkg.version);
	});

	it('has a description ending in a period', () => {
		expect(manifest.description).toMatch(/\.$/);
		expect(manifest.description.toLowerCase()).not.toContain('obsidian');
	});
});
