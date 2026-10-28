// The Brain panel: what the server says about the open note, as the lines to draw.
// Reads only. Every string is drawn as text, and a value this version does not know is left out.

import { ApiError } from './api';
import { ago } from './scan-status';

const MAX_TASKS = 2;
const MAX_PEOPLE = 4;
const MAX_RELATED = 3;
const MAX_TAGS = 5;
export const PANEL_DEBOUNCE_MS = 400;

/** Which blocks to draw. */
export interface PanelSettings {
	state: boolean;
	context: boolean;
	people: boolean;
	/** Whether a ribbon icon opens the panel. */
	ribbon: boolean;
}

export const DEFAULT_PANEL: PanelSettings = { state: true, context: true, people: true, ribbon: false };

export function parsePanel(data: unknown): PanelSettings {
	const stored = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
	const read = (key: keyof PanelSettings) => (typeof stored[key] === 'boolean' ? stored[key] : DEFAULT_PANEL[key]);
	return { state: read('state'), context: read('context'), people: read('people'), ribbon: read('ribbon') };
}

type BrainState = 'reading' | 'filed' | 'off';
type Author = 'brain' | 'you' | 'member' | 'agent';

interface BrainTopic {
	name: string;
	sharedWith: string | null;
	openTasks: number;
	decisions: number;
	tasks: Array<{ title: string; who: string | null; due: string | null }>;
	decision: { title: string; on: string | null } | null;
	href: string | null;
}

interface BrainPerson {
	name: string;
	kind: 'brain' | 'note' | 'name';
	noteId: string | null;
	href: string | null;
}

interface BrainRelated {
	noteId: string;
	title: string;
	why: 'tagged' | 'mentioned' | 'name';
	name: string | null;
	inSpace: boolean;
	href: string | null;
}

/** The server's answer for one note, with unknown values dropped. */
export interface NoteBrain {
	state: BrainState | null;
	updatedAt: string | null;
	updatedBy: Author | null;
	topic: BrainTopic | null;
	people: BrainPerson[];
	related: BrainRelated[];
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);
const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0);
const record = (value: unknown): Record<string, unknown> | null =>
	typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
/** A path on the server; anything else is not followed. */
const href = (value: unknown): string | null => {
	const path = text(value);
	return path !== null && path.startsWith('/') && !path.startsWith('//') ? path : null;
};

function readTopic(value: unknown): BrainTopic | null {
	const topic = record(value);
	const name = topic === null ? null : text(topic['name']);
	if (topic === null || name === null) {
		return null;
	}
	const tasks = (Array.isArray(topic['tasks']) ? (topic['tasks'] as unknown[]) : []).flatMap((t) => {
		const task = record(t);
		const title = task === null ? null : text(task['title']);
		return task === null || title === null ? [] : [{ title, who: text(task['who']), due: text(task['due']) }];
	});
	const decision = record(topic['decision']);
	const decisionTitle = decision === null ? null : text(decision['title']);
	return {
		name,
		sharedWith: text(topic['shared_with']),
		openTasks: count(topic['open_tasks']),
		decisions: count(topic['decisions']),
		tasks: tasks.slice(0, MAX_TASKS),
		decision: decision === null || decisionTitle === null ? null : { title: decisionTitle, on: text(decision['on']) },
		href: href(topic['href']),
	};
}

function readPeople(value: unknown): BrainPerson[] {
	const people: BrainPerson[] = [];
	for (const p of Array.isArray(value) ? (value as unknown[]) : []) {
		const person = record(p);
		const name = person === null ? null : text(person['name']);
		const kind = person?.['kind'];
		if (person === null || name === null || (kind !== 'brain' && kind !== 'note' && kind !== 'name')) {
			continue;
		}
		people.push({ name, kind, noteId: text(person['note_id']), href: href(person['href']) });
	}
	return people.slice(0, MAX_PEOPLE);
}

function readRelated(value: unknown, openId: string): BrainRelated[] {
	const related: BrainRelated[] = [];
	for (const r of Array.isArray(value) ? (value as unknown[]) : []) {
		const item = record(r);
		const noteId = item === null ? null : text(item['note_id']);
		const title = item === null ? null : text(item['title']);
		const why = item?.['why'];
		if (item === null || noteId === null || title === null || noteId === openId) {
			continue;
		}
		if (why !== 'tagged' && why !== 'mentioned' && why !== 'name') {
			continue;
		}
		const name = text(item['name']);
		if (why === 'name' && name === null) {
			continue;
		}
		related.push({ noteId, title, why, name: why === 'name' ? name : null, inSpace: item['in_space'] === true, href: href(item['href']) });
	}
	// Notes that only share a name come last, and only fill the places left.
	const ordered = [...related.filter((r) => r.why !== 'name'), ...related.filter((r) => r.why === 'name')];
	return ordered.slice(0, MAX_RELATED);
}

/** Reads the body of `GET /notes/{id}/brain` for the note `openId`. */
export function readNoteBrain(body: Record<string, unknown>, openId: string): NoteBrain {
	const state = body['state'];
	const by = body['updated_by'];
	const at = text(body['updated_at']);
	return {
		state: state === 'reading' || state === 'filed' || state === 'off' ? state : null,
		updatedAt: at !== null && !Number.isNaN(Date.parse(at)) ? at : null,
		updatedBy: by === 'brain' || by === 'you' || by === 'member' || by === 'agent' ? by : null,
		topic: readTopic(body['topic']),
		people: readPeople(body['people']),
		related: readRelated(body['related'], openId),
	};
}

/** Where a click goes: the note in this vault if it is there, else the page on the server. */
export interface Target {
	noteId: string | null;
	url: string | null;
}

export interface PanelModel {
	/** The state line; null when there is nothing to say. */
	state: string | null;
	summary: string | null;
	tags: string[];
	topic: {
		name: string;
		sharedWith: string | null;
		counts: string | null;
		tasks: Array<{ title: string; meta: string | null }>;
		decision: { title: string; meta: string | null } | null;
		open: Target | null;
	} | null;
	people: Array<{ name: string; target: Target | null; added: boolean }>;
	related: Array<{ title: string; also: string | null; target: Target | null }>;
	/** Whether the note is synced, so it has a history. */
	history: boolean;
}

/** The note as the vault knows it: what its own frontmatter says, without a request. */
export interface OpenNote {
	path: string;
	/** The id of the synced note; null when it is not synced. */
	id: string | null;
	frontmatter: Record<string, unknown>;
}

const AUTHORS: Record<Author, string> = { brain: 'the Brain', you: 'you', member: 'a teammate', agent: 'an agent' };

function stateLine(brain: NoteBrain, now: Date): string | null {
	if (brain.state === 'reading') {
		return 'Reading…';
	}
	if (brain.state === 'off') {
		return 'Brain is off for this note';
	}
	if (brain.state !== 'filed') {
		return null;
	}
	if (brain.updatedBy === null) {
		return 'Filed';
	}
	const when = ago(brain.updatedAt, now);
	return `Filed. Updated by ${AUTHORS[brain.updatedBy]}${when === '' ? '' : ` ${when}`}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const meta = (...parts: Array<string | null>) => {
	const kept = parts.filter((p): p is string => p !== null);
	return kept.length === 0 ? null : kept.join(', ');
};

function strings(value: unknown): string[] {
	const list = Array.isArray(value) ? (value as unknown[]) : typeof value === 'string' ? value.split(',') : [];
	return list.flatMap((v) => (typeof v === 'string' && v.trim() !== '' ? [v.trim().replace(/^#/, '')] : []));
}

/**
 * What to draw. A block with nothing to say is left out, and so are the
 * blocks the settings turn off. `brain` is null without an answer from the
 * server (offline, not found, or the note is not synced); `offline` says why.
 */
export function buildPanel(
	note: OpenNote,
	brain: NoteBrain | null,
	offline: boolean,
	origin: string | null,
	settings: PanelSettings,
	now: Date,
): PanelModel {
	const server = (path: string | null) => (origin === null || path === null ? null : `${origin}${path}`);
	const summary = text(note.frontmatter['brain-summary']);
	const named = new Set(strings(note.frontmatter['brain-people']).map((n) => n.toLowerCase()));
	const topic = brain?.topic ?? null;
	const topicCounts = topic === null ? [] : [
		topic.openTasks > 0 ? plural(topic.openTasks, 'open task', 'open tasks') : null,
		topic.decisions > 0 ? plural(topic.decisions, 'decision', 'decisions') : null,
	].filter((p): p is string => p !== null);
	const model: PanelModel = {
		state: !settings.state ? null : brain !== null ? stateLine(brain, now) : offline ? 'Offline' : null,
		summary: settings.state ? summary : null,
		tags: settings.state ? strings(note.frontmatter['tags']).slice(0, MAX_TAGS) : [],
		topic:
			!settings.context || topic === null
				? null
				: {
						name: topic.name,
						sharedWith: topic.sharedWith === null ? null : `shared with ${topic.sharedWith}`,
						counts: topicCounts.length === 0 ? null : topicCounts.join(' · '),
						tasks: topic.tasks.map((t) => ({
							title: t.title,
							meta: meta(t.who, t.due),
						})),
						decision: topic.decision === null ? null : { title: topic.decision.title, meta: topic.decision.on },
						open: topic.href === null ? null : { noteId: null, url: server(topic.href) },
					},
		people: !settings.people || brain === null ? [] : brain.people.map((p) => ({
			name: p.name,
			added: named.has(p.name.toLowerCase()),
			target:
				p.kind === 'brain'
					? p.href === null ? null : { noteId: null, url: server(p.href) }
					: p.kind === 'note' && p.noteId !== null
						? { noteId: p.noteId, url: server(`/notes/notes/${encodeURIComponent(p.noteId)}`) }
						: null,
		})),
		related: !settings.people || brain === null ? [] : brain.related.map((r) => ({
			title: r.title,
			also: r.name === null ? null : `also mentions ${r.name}`,
			target: {
				noteId: r.inSpace ? r.noteId : null,
				url: server(r.href ?? `/notes/notes/${encodeURIComponent(r.noteId)}`),
			},
		})),
		history: note.id !== null,
	};
	return model;
}

/** What the panel needs from the plugin. */
export interface PanelHost {
	/** The note in the editor; null when none is open; undefined when focus is elsewhere, such as the panel itself. */
	current(): OpenNote | null | undefined;
	/** The server's answer; null when it has none for this note. Throws an ApiError when it cannot be had. */
	load(id: string): Promise<Record<string, unknown> | null>;
	settings(): PanelSettings;
	origin(): string | null;
	now(): Date;
	render(model: PanelModel): void;
}

interface Shown {
	path: string;
	id: string | null;
	brain: NoteBrain | null;
	offline: boolean;
	/** The summary when the server was asked, to tell a note filed since from one still being read. */
	summary: string | null;
	/** Whether the one request for the state turning to filed was used. */
	followed: boolean;
}

/**
 * Decides when to ask. One request when a note is shown, one more when a note
 * that was being read gets its summary, and none otherwise; an answer that
 * fails keeps what was drawn.
 */
export class PanelController {
	private shown: Shown | null = null;
	private note: OpenNote | null = null;
	private timer: number | null = null;
	private serial = 0;
	private lastDrawn = '';

	constructor(
		private readonly host: PanelHost,
		private readonly debounceMs = PANEL_DEBOUNCE_MS,
	) {}

	/** The active leaf changed. */
	leafChanged(): void {
		this.later(false);
	}

	/** A note's properties changed, as when the server filed it. */
	metadataChanged(path: string): void {
		const shown = this.shown;
		if (shown === null || shown.path !== path) {
			return;
		}
		const current = this.host.current();
		if (current === undefined || current === null || current.path !== path) {
			return;
		}
		this.note = current;
		const summary = text(current.frontmatter['brain-summary']);
		if (shown.brain?.state === 'reading' && !shown.followed && summary !== null && summary !== shown.summary) {
			shown.followed = true;
			this.later(true);
		} else {
			this.draw();
		}
	}

	/** The settings changed: draw again, ask nothing. */
	settingsChanged(): void {
		this.draw();
	}

	dispose(): void {
		this.serial++;
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private later(force: boolean): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
		}
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.open(force);
		}, this.debounceMs);
	}

	private async open(force: boolean): Promise<void> {
		const current = this.host.current();
		if (current === undefined) {
			return;
		}
		if (current === null) {
			this.shown = null;
			this.note = null;
			this.serial++;
			this.draw();
			return;
		}
		this.note = current;
		const same = this.shown !== null && this.shown.path === current.path && this.shown.id === current.id;
		if (same && !force) {
			this.draw();
			return;
		}
		const keep = same ? this.shown : null;
		const shown: Shown = {
			path: current.path,
			id: current.id,
			brain: keep?.brain ?? null,
			offline: keep?.offline ?? false,
			summary: text(current.frontmatter['brain-summary']),
			followed: keep?.followed ?? false,
		};
		this.shown = shown;
		this.draw();
		if (current.id === null) {
			return;
		}
		const serial = ++this.serial;
		try {
			const body = await this.host.load(current.id);
			if (serial !== this.serial) {
				return;
			}
			shown.brain = body === null ? null : readNoteBrain(body, current.id);
			shown.offline = false;
		} catch (error) {
			if (serial !== this.serial) {
				return;
			}
			// Nothing is shown for a failure, and nothing is asked again; offline is said once, when nothing else is known.
			if (error instanceof ApiError && error.kind === 'network' && shown.brain === null) {
				shown.offline = true;
			}
		}
		this.draw();
	}

	private draw(): void {
		if (this.note === null) {
			this.drawn(null);
			return;
		}
		const shown = this.shown;
		this.drawn(buildPanel(this.note, shown?.brain ?? null, shown?.offline ?? false, this.host.origin(), this.host.settings(), this.host.now()));
	}

	private drawn(model: PanelModel | null): void {
		const key = JSON.stringify(model);
		if (key === this.lastDrawn) {
			return;
		}
		this.lastDrawn = key;
		this.host.render(
			model ?? { state: null, summary: null, tags: [], topic: null, people: [], related: [], history: false },
		);
	}
}
