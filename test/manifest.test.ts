import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_ACTION } from '../src/protocol';

// These checks follow the manifest rules of the Obsidian community directory,
// so a submission is not rejected for something a test could have caught.

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as T;
}

interface Manifest {
	id: string;
	name: string;
	version: string;
	minAppVersion: string;
	description: string;
	author: string;
	authorUrl?: string;
	fundingUrl?: unknown;
	isDesktopOnly: boolean;
}

const manifest = readJson<Manifest>('manifest.json');
const versions = readJson<Record<string, string>>('versions.json');
const pkg = readJson<{ version: string }>('package.json');

const VERSION = /^\d+\.\d+\.\d+$/;

describe('manifest.json', () => {
	it('has an id of lowercase letters and hyphens', () => {
		expect(manifest.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
		expect(manifest.id).not.toContain('obsidian');
		expect(manifest.id).not.toMatch(/plugin$/);
	});

	it('uses the id as the pairing link action', () => {
		expect(manifest.id).toBe(PROTOCOL_ACTION);
	});

	it('has a short Basic Latin name without "Obsidian" or "Plugin"', () => {
		expect(manifest.name).toMatch(/^[A-Za-z0-9 ()+-]+$/);
		expect(manifest.name.toLowerCase()).not.toMatch(/obsi|sidian|plugin/);
	});

	it('has a short description ending in a period', () => {
		expect(manifest.description.length).toBeLessThanOrEqual(250);
		expect(manifest.description).toMatch(/\.$/);
		expect(manifest.description).toMatch(/^[\x20-\x7e]+$/);
		expect(manifest.description.toLowerCase()).not.toMatch(/obsidian|^this (?:is a )?plugin/);
	});

	it('uses x.y.z versions', () => {
		expect(manifest.version).toMatch(VERSION);
		expect(manifest.minAppVersion).toMatch(VERSION);
	});

	it('names an author and no funding link', () => {
		expect(manifest.author.trim()).not.toBe('');
		expect(manifest.authorUrl ?? 'https://').toMatch(/^https:\/\//);
		expect(manifest).not.toHaveProperty('fundingUrl');
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
});
