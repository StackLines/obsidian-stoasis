import { describe, expect, it } from 'vitest';
import {
	DEFAULT_SETTINGS,
	describePairingState,
	getPairingState,
} from '../src/settings';

describe('default settings', () => {
	it('start in the not paired state', () => {
		expect(DEFAULT_SETTINGS.serverUrl).toBe('');
		expect(getPairingState(DEFAULT_SETTINGS)).toBe('not-paired');
		expect(describePairingState('not-paired')).toBe('Not paired');
	});
});
