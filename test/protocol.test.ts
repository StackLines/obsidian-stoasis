import { describe, expect, it } from 'vitest';
import {
	PROTOCOL_ACTION,
	normalisePairingCode,
	parseManualPairing,
	parsePairingParams,
	syncSocketUrl,
} from '../src/protocol';

describe('parsePairingParams', () => {
	it('accepts an https server and a code', () => {
		const result = parsePairingParams({
			server: 'https://notes.example.test',
			code: 'abc-123-def',
		});
		expect(result).toEqual({
			ok: true,
			request: { server: 'https://notes.example.test', code: 'abc-123-def' },
		});
	});

	it('trims whitespace around both values', () => {
		const result = parsePairingParams({
			server: '  https://notes.example.test/  ',
			code: '  abc123  ',
		});
		expect(result).toEqual({
			ok: true,
			request: { server: 'https://notes.example.test', code: 'abc123' },
		});
	});

	it('keeps a path prefix and drops trailing slashes', () => {
		const result = parsePairingParams({
			server: 'https://example.test/team/',
			code: 'abc123',
		});
		expect(result).toMatchObject({
			ok: true,
			request: { server: 'https://example.test/team' },
		});
	});

	it('rejects a missing or blank server', () => {
		expect(parsePairingParams({ code: 'abc' })).toEqual({
			ok: false,
			reason: 'missing-server',
		});
		expect(parsePairingParams({ server: '   ', code: 'abc' })).toEqual({
			ok: false,
			reason: 'missing-server',
		});
	});

	it('rejects a missing or blank code', () => {
		expect(parsePairingParams({ server: 'https://example.test' })).toEqual({
			ok: false,
			reason: 'missing-code',
		});
		expect(
			parsePairingParams({ server: 'https://example.test', code: ' ' }),
		).toEqual({ ok: false, reason: 'missing-code' });
	});

	it('rejects plain http except for local development hosts', () => {
		expect(
			parsePairingParams({ server: 'http://example.test', code: 'abc' }),
		).toEqual({ ok: false, reason: 'insecure-server' });
		expect(
			parsePairingParams({ server: 'http://localhost:8080', code: 'abc' }),
		).toMatchObject({ ok: true });
		expect(
			parsePairingParams({ server: 'http://127.0.0.1:8080', code: 'abc' }),
		).toMatchObject({ ok: true });
	});

	it('does not treat a lookalike host as a local development host', () => {
		for (const server of [
			'http://localhost.example.test',
			'http://127.0.0.1.example.test',
			'http://[::1]:8080',
		]) {
			expect(parsePairingParams({ server, code: 'abc' })).toEqual({
				ok: false,
				reason: 'insecure-server',
			});
		}
	});

	it('normalises the case of the scheme and host', () => {
		expect(
			parsePairingParams({ server: 'HTTPS://Notes.Example.Test/Team', code: 'abc' }),
		).toMatchObject({ ok: true, request: { server: 'https://notes.example.test/Team' } });
	});

	it('rejects other schemes and unparseable servers', () => {
		for (const server of [
			'ftp://example.test',
			'file:///etc/hosts',
			'data:text/plain,hello',
			'obsidian://stoasis',
			'https://',
			'notes',
			'javascript:alert(1)',
		]) {
			expect(parsePairingParams({ server, code: 'abc' })).toEqual({
				ok: false,
				reason: 'invalid-server',
			});
		}
	});

	it('rejects a server with credentials, a query or a fragment', () => {
		for (const server of [
			'https://alice:secret@example.test',
			'https://example.test/?token=abc',
			'https://example.test/#frag',
		]) {
			expect(parsePairingParams({ server, code: 'abc' })).toEqual({
				ok: false,
				reason: 'invalid-server',
			});
		}
	});

	it('rejects a code with whitespace, control characters or an absurd length', () => {
		for (const code of ['ab cd', 'ab\tcd', 'ab\u0000cd', 'ab\u007fcd']) {
			expect(parsePairingParams({ server: 'https://example.test', code })).toEqual({
				ok: false,
				reason: 'invalid-code',
			});
		}
		expect(
			parsePairingParams({
				server: 'https://example.test',
				code: 'a'.repeat(1000),
			}),
		).toEqual({ ok: false, reason: 'invalid-code' });
	});

	it('never includes the code in a rejection', () => {
		const code = 'super-secret-code';
		const result = parsePairingParams({ server: 'http://example.test', code });
		expect(JSON.stringify(result)).not.toContain(code);
	});

	it('uses the stoasis action name', () => {
		expect(PROTOCOL_ACTION).toBe('stoasis');
	});
});

describe('parseManualPairing', () => {
	it('accepts a code typed with spaces, dashes or lower case', () => {
		expect(parseManualPairing(' https://notes.example.test/ ', ' abcd-23 45 ')).toEqual({
			ok: true,
			request: { server: 'https://notes.example.test', code: 'ABCD2345' },
		});
	});

	it('names what is missing or wrong', () => {
		expect(parseManualPairing('', 'ABCD2345')).toEqual({ ok: false, reason: 'missing-server' });
		expect(parseManualPairing('https://notes.example.test', ' ')).toEqual({ ok: false, reason: 'missing-code' });
		expect(parseManualPairing('https://notes.example.test', 'O0I1')).toEqual({ ok: false, reason: 'invalid-code' });
		expect(parseManualPairing('http://notes.example.test', 'ABCD2345')).toEqual({
			ok: false,
			reason: 'insecure-server',
		});
	});
});

describe('normalisePairingCode', () => {
	it('ignores case, spaces and dashes', () => {
		expect(normalisePairingCode('abcd-2345')).toBe('ABCD2345');
		expect(normalisePairingCode(' AB CD\t23-45 ')).toBe('ABCD2345');
	});

	it('rejects characters a code never contains', () => {
		for (const code of ['', ' - ', 'ABCD0', 'ABCDO', 'ABCDI', 'ABCD1', 'ABCDL', 'ABC!', 'ÄBCD']) {
			expect(normalisePairingCode(code)).toBeNull();
		}
	});
});

describe('syncSocketUrl', () => {
	it('uses a secure socket for an https server', () => {
		expect(syncSocketUrl('https://notes.example.test')).toBe('wss://notes.example.test/notes/sync');
	});

	it('keeps a path prefix and allows plain sockets for local development', () => {
		expect(syncSocketUrl('https://example.test/brain')).toBe('wss://example.test/brain/notes/sync');
		expect(syncSocketUrl('http://localhost:8080')).toBe('ws://localhost:8080/notes/sync');
	});
});
