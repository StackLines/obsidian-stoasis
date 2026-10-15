import { ApiError, type NotesApi, type Space } from './api';
import { normalisePairingCode, type PairingRequest } from './protocol';
import { checkCompatibility, describeIncompatibility } from './version';

/** What pairing stores: a key that can only reach the notes API, and who it belongs to. */
export interface Pairing {
	serverUrl: string;
	deviceKey: string;
	keyId: string;
	deviceLabel: string;
	personName: string;
}

export class PairingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PairingError';
	}
}

/** Longest device label the server accepts. */
export const MAX_DEVICE_LABEL = 80;

/**
 * Pairs this device: checks the server accepts this plugin version, then
 * trades the one-time code for a device key. Throws a PairingError with a
 * message for the user; the message never contains the code.
 */
export async function pairDevice(
	api: NotesApi,
	request: PairingRequest,
	deviceLabel: string,
	pluginVersion: string,
): Promise<Pairing> {
	const code = normalisePairingCode(request.code);
	if (code === null) {
		throw new PairingError('This pairing code is not valid. Check it and try again.');
	}
	let info;
	try {
		info = await api.version();
	} catch (error) {
		throw new PairingError(describeApiError(error));
	}
	const compatibility = checkCompatibility(info, pluginVersion);
	if (!compatibility.ok) {
		throw new PairingError(describeIncompatibility(compatibility));
	}
	const label = deviceLabel.trim().slice(0, MAX_DEVICE_LABEL);
	try {
		const result = await api.pair(code, label);
		return {
			serverUrl: request.server,
			deviceKey: result.token,
			keyId: result.keyId,
			deviceLabel: result.label || label,
			personName: result.person.displayName,
		};
	} catch (error) {
		throw new PairingError(describeApiError(error));
	}
}

/** The person's personal space, created on the server if it does not exist yet. */
export async function personalSpace(api: NotesApi): Promise<Space> {
	const spaces = await api.listSpaces();
	const existing = spaces.find((space) => space.kind === 'personal' && !space.archived);
	return existing ?? (await api.ensurePersonalSpace('Personal'));
}

export function describeApiError(error: unknown): string {
	if (!(error instanceof ApiError)) {
		return 'Something went wrong. Try again.';
	}
	switch (error.kind) {
		case 'network':
			return 'Could not reach the server. Check the address and your connection.';
		case 'invalid-code':
			return 'This pairing code is not valid or has expired. Create a new one and try again.';
		case 'locked': {
			const minutes = error.retryAfter === null ? null : Math.max(1, Math.ceil(error.retryAfter / 60));
			return minutes === null
				? 'Too many attempts. Wait a while and try again.'
				: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
		}
		case 'unauthenticated':
			return 'The server no longer accepts this device. Pair it again.';
		case 'forbidden':
			return 'The server does not allow this.';
		case 'unavailable':
			return 'The server is unavailable right now. Try again later.';
		case 'not-found':
		case 'invalid-request':
		case 'unexpected':
			return 'The server gave an unexpected answer. Check that it is a compatible server.';
	}
}
