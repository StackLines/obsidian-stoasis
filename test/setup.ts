// Plugin code runs in a window and uses its timers; in Node the global object
// stands in for it.
const globals = globalThis as Record<string, unknown>;
globals['window'] ??= globalThis;
