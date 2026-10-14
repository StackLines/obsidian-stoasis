import { describe, expect, it } from 'vitest';
import { PROTOCOL_ACTION, parsePairingParams } from '../src/protocol';

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

	it('rejects other schemes and unparseable servers', () => {
		for (const server of ['ftp://example.test', 'notes', 'javascript:alert(1)']) {
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

	it('rejects a code with whitespace or an absurd length', () => {
		expect(
			parsePairingParams({ server: 'https://example.test', code: 'ab cd' }),
		).toEqual({ ok: false, reason: 'invalid-code' });
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

	it('uses the stoa action name', () => {
		expect(PROTOCOL_ACTION).toBe('stoa');
	});
});
