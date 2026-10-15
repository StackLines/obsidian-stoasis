import WebSocket from 'ws';

// Plugin code runs in a window and uses its timers; in Node the global object
// stands in for it.
const globals = globalThis as Record<string, unknown>;
globals['window'] ??= globalThis;

/**
 * Node 20 has no global WebSocket (22 does), and the sync provider needs one.
 * The ws client throws on an unhandled error event, such as closing while it is
 * still connecting; browsers only report it.
 */
class WindowSocket extends WebSocket {
	constructor(address: string, protocols?: string | string[]) {
		super(address, protocols);
		this.on('error', () => undefined);
	}
}
globals['WebSocket'] ??= WindowSocket;
