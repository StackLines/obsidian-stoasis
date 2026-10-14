import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notices } from './stubs/obsidian';
import StoaPlugin from '../src/main';

async function loadedPlugin(): Promise<StoaPlugin> {
	const plugin = new StoaPlugin({} as never, {} as never);
	await plugin.onload();
	return plugin;
}

describe('plugin load', () => {
	beforeEach(() => {
		notices.length = 0;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('shows the not paired state in the status bar', async () => {
		const plugin = (await loadedPlugin()) as unknown as {
			statusItems: Array<{ text: string }>;
		};
		expect(plugin.statusItems).toHaveLength(1);
		expect(plugin.statusItems[0]?.text).toBe('Stoa: not paired');
	});

	it('registers a settings tab and the pairing link handler', async () => {
		const plugin = (await loadedPlugin()) as unknown as {
			settingTabs: unknown[];
			protocolHandlers: Map<string, unknown>;
		};
		expect(plugin.settingTabs).toHaveLength(1);
		expect([...plugin.protocolHandlers.keys()]).toEqual(['stoa']);
	});

	it('answers a valid pairing link with a notice and no network call', async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		const plugin = await loadedPlugin();
		const handlers = (
			plugin as unknown as {
				protocolHandlers: Map<string, (p: Record<string, string>) => void>;
			}
		).protocolHandlers;

		handlers.get('stoa')?.({
			action: 'stoa',
			server: 'https://notes.example.test',
			code: 'abc123',
		});

		expect(notices).toEqual(['Pairing is not available in this version yet.']);
		expect(notices.join(' ')).not.toContain('abc123');
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(plugin.pendingPairing).toEqual({
			server: 'https://notes.example.test',
			code: 'abc123',
		});
		expect(
			(plugin as unknown as { saved: unknown[] }).saved,
		).toHaveLength(0);
	});

	it('rejects an invalid link without keeping or echoing anything', async () => {
		const plugin = await loadedPlugin();
		const handlers = (
			plugin as unknown as {
				protocolHandlers: Map<string, (p: Record<string, string>) => void>;
			}
		).protocolHandlers;

		handlers.get('stoa')?.({
			action: 'stoa',
			server: 'http://example.test',
			code: 'secret-code-1',
		});

		expect(notices).toEqual(['This pairing link is not valid.']);
		expect(plugin.pendingPairing).toBeNull();
	});

	it('writes nothing to the console while loading or handling links', async () => {
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
			vi.spyOn(console, method).mockImplementation(() => undefined),
		);
		const plugin = await loadedPlugin();
		const handler = (
			plugin as unknown as {
				protocolHandlers: Map<string, (p: Record<string, string>) => void>;
			}
		).protocolHandlers.get('stoa');

		handler?.({ action: 'stoa', server: 'https://notes.example.test', code: 'abc123' });
		handler?.({ action: 'stoa', server: 'notes', code: 'abc123' });
		handler?.({ action: 'stoa' });

		for (const spy of spies) {
			expect(spy).not.toHaveBeenCalled();
		}
	});

	it('loads stored settings through the same validation', async () => {
		const plugin = new StoaPlugin({} as never, {} as never);
		(plugin as unknown as { storedData: unknown }).storedData = { serverUrl: 3 };
		await plugin.onload();
		expect(plugin.settings).toEqual({ serverUrl: '' });
	});
});
