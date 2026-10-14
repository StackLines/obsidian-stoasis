import { describe, expect, it } from 'vitest';
import type { ContainerEl } from './stubs/obsidian';
import type StoasisPlugin from '../src/main';
import {
	DEFAULT_SETTINGS,
	StoasisSettingTab,
	describePairingState,
	getPairingState,
	parseSettings,
} from '../src/settings';

describe('default settings', () => {
	it('start in the not paired state', () => {
		expect(DEFAULT_SETTINGS.serverUrl).toBe('');
		expect(getPairingState(DEFAULT_SETTINGS)).toBe('not-paired');
		expect(describePairingState('not-paired')).toBe('Not paired');
	});
});

describe('parseSettings', () => {
	it('falls back to the defaults when nothing is stored', () => {
		for (const data of [null, undefined, 'text', 42, []]) {
			expect(parseSettings(data)).toEqual(DEFAULT_SETTINGS);
		}
	});

	it('keeps a stored server address', () => {
		expect(parseSettings({ serverUrl: 'https://notes.example.test' })).toEqual({
			serverUrl: 'https://notes.example.test',
		});
	});

	it('drops unknown fields and values of the wrong type', () => {
		expect(parseSettings({ serverUrl: 7, extra: 'x' })).toEqual(DEFAULT_SETTINGS);
	});

	it('returns a copy, never the defaults object itself', () => {
		const settings = parseSettings(null);
		settings.serverUrl = 'changed';
		expect(DEFAULT_SETTINGS.serverUrl).toBe('');
	});
});

describe('settings tab', () => {
	function render() {
		const plugin = { settings: { ...DEFAULT_SETTINGS } } as unknown as StoasisPlugin;
		const tab = new StoasisSettingTab({} as never, plugin);
		tab.display();
		return (tab.containerEl as unknown as ContainerEl).items;
	}

	it('shows the status first, without a heading above it', () => {
		const items = render();
		expect(items[0]).toEqual({ kind: 'setting', name: 'Status', desc: 'Not paired' });
	});

	it('shows the network and privacy disclosure under its own heading', () => {
		const items = render();
		expect(items[1]).toEqual({ kind: 'heading', name: 'Network and privacy' });
		expect(items[2]).toMatchObject({ kind: 'element', tag: 'p', cls: 'stoasis-disclosure' });
		const text = items[2]?.text ?? '';
		expect(text).toContain('needs an account on a compatible server');
		expect(text).toContain('no telemetry and no self-update');
		expect(text).toContain('not available in this version yet');
	});

	it('renders the same content when shown again', () => {
		const plugin = { settings: { ...DEFAULT_SETTINGS } } as unknown as StoasisPlugin;
		const tab = new StoasisSettingTab({} as never, plugin);
		tab.display();
		tab.display();
		expect((tab.containerEl as unknown as ContainerEl).items).toHaveLength(3);
	});
});
