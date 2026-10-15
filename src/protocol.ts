/** Action name of the pairing link: obsidian://stoasis?server=<url>&code=<code>. */
export const PROTOCOL_ACTION = 'stoasis';

/** Longest pairing code accepted; codes are short, so this is generous. */
const MAX_CODE_LENGTH = 256;

export interface PairingRequest {
	/** Normalised server address: origin plus optional path, no trailing slash. */
	server: string;
	code: string;
}

export type PairingParseResult =
	| { ok: true; request: PairingRequest }
	| { ok: false; reason: PairingRejection };

export type PairingRejection =
	| 'missing-server'
	| 'missing-code'
	| 'invalid-server'
	| 'insecure-server'
	| 'invalid-code';

const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * Validates the decoded query parameters of a pairing link.
 *
 * The result never echoes the code in a reason, so callers can show or log a
 * rejection without leaking a credential.
 */
export function parsePairingParams(
	params: Record<string, string | undefined>,
): PairingParseResult {
	const rawServer = params['server']?.trim() ?? '';
	const code = params['code']?.trim() ?? '';

	if (rawServer === '') {
		return { ok: false, reason: 'missing-server' };
	}
	if (code === '') {
		return { ok: false, reason: 'missing-code' };
	}
	if (code.length > MAX_CODE_LENGTH || /[\s\p{Cc}]/u.test(code)) {
		return { ok: false, reason: 'invalid-code' };
	}

	const server = normaliseServer(rawServer);
	if (!server.ok) {
		return server;
	}
	return { ok: true, request: { server: server.address, code } };
}

type ServerResult =
	| { ok: true; address: string }
	| { ok: false; reason: 'invalid-server' | 'insecure-server' };

function normaliseServer(raw: string): ServerResult {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: 'invalid-server' };
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		return { ok: false, reason: 'invalid-server' };
	}
	if (url.hostname === '') {
		return { ok: false, reason: 'invalid-server' };
	}
	// A pairing link carries a server address, never a login or a query.
	if (url.username !== '' || url.password !== '') {
		return { ok: false, reason: 'invalid-server' };
	}
	if (url.search !== '' || url.hash !== '') {
		return { ok: false, reason: 'invalid-server' };
	}
	if (url.protocol === 'http:' && !LOCAL_DEV_HOSTS.has(url.hostname)) {
		return { ok: false, reason: 'insecure-server' };
	}

	return { ok: true, address: url.origin + url.pathname.replace(/\/+$/, '') };
}

/** Characters a pairing code is made of, once normalised. */
const PAIRING_CODE_ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/;

/**
 * Normalises a pairing code the way the server compares it: case, spaces and
 * dashes do not matter. Returns null when the result cannot be a valid code,
 * so an obvious typo is caught without a network request.
 */
export function normalisePairingCode(raw: string): string | null {
	const code = raw.replace(/[\s-]+/g, '').toUpperCase();
	if (code === '' || code.length > MAX_CODE_LENGTH || !PAIRING_CODE_ALPHABET.test(code)) {
		return null;
	}
	return code;
}

/**
 * Validates a server address and code typed in by hand, with the same rules
 * as a pairing link. The code may be typed with spaces, dashes or lower case.
 */
export function parseManualPairing(server: string, code: string): PairingParseResult {
	if (code.trim() === '') {
		return parsePairingParams({ server, code: '' });
	}
	const normal = normalisePairingCode(code);
	if (normal === null) {
		return server.trim() === ''
			? { ok: false, reason: 'missing-server' }
			: { ok: false, reason: 'invalid-code' };
	}
	return parsePairingParams({ server, code: normal });
}

/** Address of the sync socket for a server address from pairing. */
export function syncSocketUrl(server: string): string {
	const url = new URL(server);
	url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
	url.pathname = url.pathname.replace(/\/+$/, '') + '/notes/sync';
	return url.toString();
}
