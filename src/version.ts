import type { VersionInfo } from './api';

/** The control-plane API versions this plugin understands. */
export const SUPPORTED_API_VERSIONS: readonly number[] = [1];

export type Compatibility =
	| { ok: true }
	| { ok: false; reason: 'api-unsupported' | 'plugin-too-old'; minPlugin: string };

/**
 * Compares two plain x.y.z versions. A part that is missing or not a number
 * counts as 0, and any suffix after the patch number is ignored.
 */
export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	for (let i = 0; i < 3; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) {
			return diff < 0 ? -1 : 1;
		}
	}
	return 0;
}

function parseVersion(version: string): number[] {
	const core = version.trim().split(/[-+]/)[0] ?? '';
	return core.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
}

/**
 * Decides whether this plugin may sync with a server. The plugin never
 * updates itself: when it is too old, the user updates it through their
 * usual plugin update channel.
 */
export function checkCompatibility(info: VersionInfo, pluginVersion: string): Compatibility {
	if (!SUPPORTED_API_VERSIONS.includes(info.api)) {
		return { ok: false, reason: 'api-unsupported', minPlugin: info.minPlugin };
	}
	if (compareVersions(pluginVersion, info.minPlugin) < 0) {
		return { ok: false, reason: 'plugin-too-old', minPlugin: info.minPlugin };
	}
	return { ok: true };
}

export function describeIncompatibility(
	result: Exclude<Compatibility, { ok: true }>,
): string {
	switch (result.reason) {
		case 'plugin-too-old':
			return `Your server needs Stoasis ${result.minPlugin} or later. Update the plugin to keep syncing.`;
		case 'api-unsupported':
			return 'Your server uses a newer protocol than this version of Stoasis. Update the plugin to keep syncing.';
	}
}
