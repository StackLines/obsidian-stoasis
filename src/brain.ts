// The Brain section of the settings tab: the person's "scan my notes" switch,
// and for the synced space its scan mode and base metadata. This module talks
// to the server and keeps what it said; src/settings.ts draws it.

import { ApiError, type ScanMode, type ScanSettings, type Space } from './api';
import { describeApiError } from './pairing';

/** The calls the Brain section makes; `NotesApi` has them all. */
export interface BrainApi {
	scanSettings(): Promise<ScanSettings>;
	setScanEnabled(enabled: boolean): Promise<ScanSettings>;
	listSpaces(): Promise<Space[]>;
	setScanMode(spaceId: string, mode: ScanMode): Promise<Space>;
	setBaseMetadata(spaceId: string, enabled: boolean): Promise<Space>;
	requestBaseBackfill(spaceId: string): Promise<Space | null>;
}

export type BrainView =
	/** Not asked yet, or the device is not paired. */
	| { kind: 'idle' }
	| { kind: 'loading' }
	/** The server has no scan settings: the section is not shown. */
	| { kind: 'hidden' }
	| { kind: 'failed'; message: string }
	| {
			kind: 'ready';
			scan: ScanSettings;
			/** The synced space, when there is one and the server listed it. */
			space: Space | null;
			/** Whether to offer the owner's controls for that space. */
			owner: boolean;
			/** Whether to offer base metadata: the server has it, and the person owns the space. */
			baseMetadata: boolean;
			/** What the last change ran into, if anything. */
			message: string;
	  };

type ReadyView = Extract<BrainView, { kind: 'ready' }>;

/** What a change makes of the section, kept until it is known to belong to the section still shown. */
interface Candidate {
	scan: ScanSettings;
	space: Space | null;
	message: string;
	/** Set when the server refused an owner-only change, or answered 404 for base metadata. */
	forbidden: boolean;
	noBaseMetadata: boolean;
}

export const UNREACHABLE = "Couldn't reach the server. Nothing was changed.";
const UNREACHABLE_LOAD = "Couldn't reach the server.";
export const NOT_OWNER = "Only the space's owner can change this.";

/** Loads the Brain section and makes its changes, calling `changed` whenever there is something new to show. */
export class Brain {
	view: BrainView = { kind: 'idle' };
	private loadedFor = '';
	/** Counts resets, so an answer to an earlier load or change is dropped. */
	private generation = 0;
	/** The generation a change is being made for, if any. */
	private busyFor: number | null = null;
	/** Set when the server refused an owner-only change, or answered 404 for base metadata. */
	private forbidden = false;
	private noBaseMetadata = false;

	constructor(private readonly changed: () => void) {}

	/**
	 * Loads what the server says, once for each server and space; `api` is null
	 * while the device is not paired.
	 */
	async load(api: BrainApi | null, key: string, spaceId: string, again = false): Promise<void> {
		if (api === null) {
			this.reset('');
			return;
		}
		const wanted = `${key}\n${spaceId}`;
		if (!again && wanted === this.loadedFor && this.view.kind !== 'idle') {
			return;
		}
		this.reset(wanted);
		const generation = this.generation;
		this.view = { kind: 'loading' };
		this.changed();

		let scan: ScanSettings;
		try {
			scan = await api.scanSettings();
		} catch (error) {
			if (this.generation !== generation) {
				return;
			}
			this.view = notFound(error)
				? { kind: 'hidden' }
				: { kind: 'failed', message: isNetwork(error) ? UNREACHABLE_LOAD : describeApiError(error) };
			this.changed();
			return;
		}
		let space: Space | null = null;
		let message = '';
		if (spaceId !== '') {
			try {
				space = (await api.listSpaces()).find((s) => s.id === spaceId) ?? null;
			} catch (error) {
				message = isNetwork(error) ? "Couldn't reach the server to read the space." : describeApiError(error);
			}
		}
		if (this.generation !== generation) {
			return;
		}
		this.show({ scan, space, message, forbidden: false, noBaseMetadata: false });
	}

	/** Forgets what was loaded, so the next `load` asks again. */
	reset(key = ''): void {
		this.loadedFor = key;
		this.generation++;
		this.view = { kind: 'idle' };
		this.forbidden = false;
		this.noBaseMetadata = false;
	}

	setScanEnabled(api: BrainApi, enabled: boolean): Promise<void> {
		return this.change(async (next) => {
			next.scan = await api.setScanEnabled(enabled);
		});
	}

	setScanMode(api: BrainApi, mode: ScanMode): Promise<void> {
		return this.ownerChange((space) => api.setScanMode(space.id, mode));
	}

	setBaseMetadata(api: BrainApi, enabled: boolean): Promise<void> {
		return this.ownerChange((space) => api.setBaseMetadata(space.id, enabled), true);
	}

	requestBaseBackfill(api: BrainApi): Promise<void> {
		return this.ownerChange(
			async (space) => (await api.requestBaseBackfill(space.id)) ?? { ...space, baseBackfillRequested: true },
			true,
		);
	}

	private ownerChange(make: (space: Space) => Promise<Space>, baseMetadata = false): Promise<void> {
		return this.change(async (next, view) => {
			const space = next.space;
			if (space === null || !view.owner) {
				return;
			}
			try {
				next.space = await make(space);
			} catch (error) {
				if (baseMetadata && notFound(error)) {
					// The server does not offer base metadata (any more).
					next.noBaseMetadata = true;
					return;
				}
				if (error instanceof ApiError && error.kind === 'base-metadata-off') {
					// Turned off elsewhere since the section was loaded.
					next.space = { ...space, baseMetadata: false };
				}
				if (error instanceof ApiError && error.kind === 'forbidden') {
					next.forbidden = true;
					next.message = NOT_OWNER;
					return;
				}
				throw error;
			}
		});
	}

	/**
	 * Makes one change; on failure the controls show what the server last
	 * said. What the answer says is kept only when the section still shows
	 * what the change was made for: an answer to an earlier load is dropped.
	 */
	private async change(make: (next: Candidate, view: ReadyView) => Promise<void>): Promise<void> {
		const view = this.view;
		const generation = this.generation;
		if (view.kind !== 'ready' || this.busyFor === generation) {
			return;
		}
		const next: Candidate = {
			scan: view.scan,
			space: view.space,
			message: '',
			forbidden: this.forbidden,
			noBaseMetadata: this.noBaseMetadata,
		};
		this.busyFor = generation;
		try {
			await make(next, view);
		} catch (error) {
			next.message = isNetwork(error) ? UNREACHABLE : describeApiError(error);
		} finally {
			if (this.busyFor === generation) {
				this.busyFor = null;
			}
		}
		if (this.generation === generation) {
			this.show(next);
		}
	}

	private show(next: Candidate): void {
		this.forbidden = next.forbidden;
		this.noBaseMetadata = next.noBaseMetadata;
		const space = next.space;
		const owner = space !== null && space.role === 'owner' && !this.forbidden;
		this.view = {
			kind: 'ready',
			scan: next.scan,
			space,
			owner,
			baseMetadata: owner && space.baseMetadata !== null && !this.noBaseMetadata,
			message: next.message,
		};
		this.changed();
	}
}

/** One line on what a scan mode does. */
export function describeScanModes(): string {
	return (
		'Off leaves the notes alone. Suggest holds the scanner\'s changes for review; ' +
		'there is no screen to review them yet. Auto writes them into the notes.'
	);
}

function notFound(error: unknown): boolean {
	return error instanceof ApiError && error.kind === 'not-found';
}

function isNetwork(error: unknown): boolean {
	return error instanceof ApiError && error.kind === 'network';
}
