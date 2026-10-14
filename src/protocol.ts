/** Action name of the pairing link: obsidian://stoa?server=<url>&code=<code>. */
export const PROTOCOL_ACTION = 'stoa';

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
