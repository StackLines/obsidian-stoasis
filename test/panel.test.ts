import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NotesApi, type HttpResponse } from '../src/api';
import {
	buildPanel,
	DEFAULT_PANEL,
	PanelController,
	parsePanel,
	readNoteBrain,
	type OpenNote,
	type PanelHost,
	type PanelModel,
} from '../src/panel';

const ID = '3b9a0c2e-6f43-4d6e-9a53-0d5f0a1b2c3d';
const NOW = new Date('2026-10-28T10:00:00Z');
const ORIGIN = 'https://notes.example.test';
const NOTE: OpenNote = { path: 'A.md', id: ID, frontmatter: {} };

const topic = (extra: Record<string, unknown> = {}) => ({
	id: 't1',
	name: 'Cloud Migration',
	state: 'validated',
	why: 'tagged',
	shared_with: 'Cloud team',
	open_tasks: 3,
	decisions: 1,
	notes: 5,
	tasks: [
		{ id: 'a', title: 'Check where the data is stored', state: 'active', who: 'Marko', due: '2026-10-30' },
		{ id: 'b', title: 'Second', state: 'active', who: null, due: null },
		{ id: 'c', title: 'Third', state: 'active', who: null, due: null },
	],
	decision: { id: 'd', title: 'Portal first', on: '2026-10-12' },
	href: '/notes/topics/t1',
	...extra,
});

const body = (extra: Record<string, unknown> = {}) => ({
	state: 'filed',
	updated_at: '2026-10-28T09:57:00+00:00',
	updated_by: 'brain',
	topic: topic(),
	people: [],
	related: [],
	...extra,
});

const build = (brain: Record<string, unknown> | null, note: OpenNote = NOTE, settings = DEFAULT_PANEL, offline = false) =>
	buildPanel(note, brain === null ? null : readNoteBrain(brain, ID), offline, ORIGIN, settings, NOW);

describe('reading the answer', () => {
	it('keeps at most 2 tasks, 4 people and 3 related notes, never the open note', () => {
		const people = Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, kind: 'name' }));
		const related = [
			{ note_id: ID, title: 'Self', why: 'tagged', in_space: true },
			...Array.from({ length: 5 }, (_, i) => ({ note_id: `n${i}`, title: `N${i}`, why: 'tagged', in_space: true })),
		];
		const brain = readNoteBrain(body({ people, related }), ID);
		expect(brain.topic?.tasks.map((t) => t.title)).toEqual(['Check where the data is stored', 'Second']);
		expect(brain.people.map((p) => p.name)).toEqual(['P0', 'P1', 'P2', 'P3']);
		expect(brain.related.map((r) => r.title)).toEqual(['N0', 'N1', 'N2']);
	});

	it('puts notes that share a name last, and drops one without the name', () => {
		const related = [
			{ note_id: 'a', title: 'ByName', why: 'name', name: 'Ana', in_space: false },
			{ note_id: 'b', title: 'NoName', why: 'name', in_space: false },
			{ note_id: 'c', title: 'Tagged', why: 'mentioned', in_space: false },
		];
		expect(readNoteBrain(body({ related }), ID).related.map((r) => r.title)).toEqual(['Tagged', 'ByName']);
	});

	it('reads unknown states, kinds, reasons and authors as absent', () => {
		const brain = readNoteBrain(
			body({
				state: 'sleeping',
				updated_by: 'robot',
				people: [{ name: 'X', kind: 'alien' }, { name: 'Y', kind: 'name' }],
				related: [{ note_id: 'a', title: 'T', why: 'vibes', in_space: true }],
			}),
			ID,
		);
		expect(brain.state).toBeNull();
		expect(brain.updatedBy).toBeNull();
		expect(brain.people.map((p) => p.name)).toEqual(['Y']);
		expect(brain.related).toEqual([]);
	});

	it('does not follow a link that is not a path on the server', () => {
		const brain = readNoteBrain(body({ topic: topic({ href: 'https://elsewhere.test/x' }) }), ID);
		expect(build(body({ topic: topic({ href: '//elsewhere.test/x' }) })).topic?.open).toBeNull();
		expect(brain.topic?.href).toBeNull();
	});
});

describe('what is drawn', () => {
	it('draws the three blocks from a full answer', () => {
		const people = [
			{ name: 'Marko Kos', kind: 'brain', id: 'p', href: '/notes/people/p' },
			{ name: 'Luka', kind: 'note', note_id: 'n1' },
			{ name: 'Ana', kind: 'name' },
		];
		const related = [{ note_id: 'n2', title: 'Weekly sync', why: 'name', name: 'Ana', in_space: true, href: '/notes/notes/n2' }];
		const note = { ...NOTE, frontmatter: { 'brain-summary': 'Kick-off.', tags: ['cloud', '#risk'], 'brain-people': ['marko kos'] } };
		const model = build(body({ people, related }), note);
		expect(model.state).toBe('Filed. Updated by the Brain 3 minutes ago');
		expect(model.summary).toBe('Kick-off.');
		expect(model.tags).toEqual(['cloud', 'risk']);
		expect(model.topic).toMatchObject({
			name: 'Cloud Migration',
			sharedWith: 'shared with Cloud team',
			counts: '3 open tasks · 1 decision',
			open: { noteId: null, url: `${ORIGIN}/notes/topics/t1` },
		});
		expect(model.topic?.tasks).toEqual([
			{ title: 'Check where the data is stored', meta: 'Marko, 2026-10-30' },
			{ title: 'Second', meta: null },
		]);
		expect(model.topic?.decision).toEqual({ title: 'Portal first', meta: '2026-10-12' });
		expect(model.people).toEqual([
			{ name: 'Marko Kos', added: true, target: { noteId: null, url: `${ORIGIN}/notes/people/p` } },
			{ name: 'Luka', added: false, target: { noteId: 'n1', url: `${ORIGIN}/notes/notes/n1` } },
			{ name: 'Ana', added: false, target: null },
		]);
		expect(model.related).toEqual([
			{ title: 'Weekly sync', also: 'also mentions Ana', target: { noteId: 'n2', url: `${ORIGIN}/notes/notes/n2` } },
		]);
		expect(model.history).toBe(true);
	});

	it('draws nothing for what is empty', () => {
		const model = build(body({ state: 'filed', updated_by: null, updated_at: null, topic: null }));
		expect(model).toEqual({ state: 'Filed', summary: null, tags: [], topic: null, people: [], related: [], history: true });
		const bare = build(body({ topic: topic({ shared_with: null, open_tasks: 0, decisions: 0, tasks: [], decision: null, href: null }) }));
		expect(bare.topic).toMatchObject({ sharedWith: null, counts: null, tasks: [], decision: null, open: null });
		expect(build(body({ state: 'x', topic: null })).state).toBeNull();
	});

	it('opens an in-space related note in the vault only', () => {
		const related = [
			{ note_id: 'a', title: 'Here', why: 'tagged', in_space: true },
			{ note_id: 'b', title: 'Away', why: 'tagged', in_space: false, href: '/notes/notes/b' },
		];
		expect(build(body({ related })).related.map((r) => r.target)).toEqual([
			{ noteId: 'a', url: `${ORIGIN}/notes/notes/a` },
			{ noteId: null, url: `${ORIGIN}/notes/notes/b` },
		]);
	});

	it('words the state', () => {
		const line = (extra: Record<string, unknown>) => build(body({ topic: null, ...extra })).state;
		expect(line({ state: 'reading' })).toBe('Reading…');
		expect(line({ state: 'off' })).toBe('Brain is off for this note');
		expect(line({ updated_by: 'you' })).toBe('Filed. Updated by you 3 minutes ago');
		expect(line({ updated_by: 'member' })).toBe('Filed. Updated by a teammate 3 minutes ago');
		expect(line({ updated_at: null })).toBe('Filed. Updated by the Brain');
	});

	it('leaves out the blocks the settings turn off', () => {
		const note = { ...NOTE, frontmatter: { 'brain-summary': 'S', tags: ['a'] } };
		const people = [{ name: 'Ana', kind: 'name' }];
		const all = body({ people });
		const off = (key: 'state' | 'context' | 'people') => build(all, note, { ...DEFAULT_PANEL, [key]: false });
		expect(off('state')).toMatchObject({ state: null, summary: null, tags: [] });
		expect(off('context').topic).toBeNull();
		expect(off('people').people).toEqual([]);
		expect(off('people').topic).not.toBeNull();
	});

	it('shows the note\'s own summary and tags without an answer, and says Offline once', () => {
		const note = { ...NOTE, frontmatter: { 'brain-summary': 'S', tags: 'a, b' } };
		expect(build(null, note)).toMatchObject({ state: null, summary: 'S', tags: ['a', 'b'], topic: null });
		expect(build(null, note, DEFAULT_PANEL, true).state).toBe('Offline');
	});

	it('keeps text as text', () => {
		const html = '<img src=x onerror=alert(1)>';
		const model = build(body({ topic: topic({ name: html }), people: [{ name: html, kind: 'name' }] }), {
			...NOTE,
			frontmatter: { 'brain-summary': html },
		});
		expect([model.summary, model.topic?.name, model.people[0]?.name]).toEqual([html, html, html]);
	});

	it('has no history for a note that is not synced', () => {
		expect(build(null, { ...NOTE, id: null }).history).toBe(false);
	});
});

describe('panel settings', () => {
	it('start with all three blocks on and no ribbon icon, and fall back on bad values', () => {
		expect(parsePanel(undefined)).toEqual({ state: true, context: true, people: true, ribbon: false });
		expect(parsePanel({ state: false, context: 'no', ribbon: true })).toEqual({ state: false, context: true, people: true, ribbon: true });
	});
});

describe('when the panel asks', () => {
	let current: OpenNote | null | undefined;
	let load: ReturnType<typeof vi.fn<(id: string) => Promise<Record<string, unknown> | null>>>;
	let drawn: PanelModel[];
	let controller: PanelController;

	const host = (): PanelHost => ({
		current: () => current,
		load: (id) => load(id),
		settings: () => DEFAULT_PANEL,
		origin: () => ORIGIN,
		now: () => NOW,
		render: (model) => drawn.push(model),
	});
	const settle = async () => {
		await vi.advanceTimersByTimeAsync(400);
	};
	const last = () => drawn[drawn.length - 1];

	beforeEach(() => {
		vi.useFakeTimers();
		current = NOTE;
		load = vi.fn(() => Promise.resolve(body()));
		drawn = [];
		controller = new PanelController(host());
	});
	afterEach(() => {
		controller.dispose();
		vi.useRealTimers();
	});

	it('waits 400 ms and asks once for a burst of changes', async () => {
		controller.leafChanged();
		await vi.advanceTimersByTimeAsync(300);
		controller.leafChanged();
		await vi.advanceTimersByTimeAsync(300);
		expect(load).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(100);
		expect(load).toHaveBeenCalledTimes(1);
		expect(last()?.topic?.name).toBe('Cloud Migration');
	});

	it('asks once per open: focus back on the same note asks nothing', async () => {
		controller.leafChanged();
		await settle();
		controller.leafChanged();
		await settle();
		current = undefined;
		controller.leafChanged();
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		current = { ...NOTE, path: 'B.md', id: 'other' };
		controller.leafChanged();
		await settle();
		current = NOTE;
		controller.leafChanged();
		await settle();
		expect(load.mock.calls.map((c) => c[0])).toEqual([ID, 'other', ID]);
	});

	it('draws a note that is not synced from its frontmatter, without asking', async () => {
		current = { path: 'U.md', id: null, frontmatter: { 'brain-summary': 'Mine' } };
		controller.leafChanged();
		await settle();
		expect(load).not.toHaveBeenCalled();
		expect(last()).toMatchObject({ summary: 'Mine', history: false });
	});

	it('draws the server blocks as absent on a 404 and never asks again', async () => {
		load.mockResolvedValue(null);
		current = { ...NOTE, frontmatter: { 'brain-summary': 'S' } };
		controller.leafChanged();
		await settle();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(load).toHaveBeenCalledTimes(1);
		expect(last()).toMatchObject({ state: null, summary: 'S', topic: null });
	});

	it('says Offline when it cannot reach the server, and does not retry', async () => {
		load.mockRejectedValue(new ApiError('network', 0));
		controller.leafChanged();
		await settle();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(load).toHaveBeenCalledTimes(1);
		expect(last()?.state).toBe('Offline');
	});

	it('keeps what is shown when a later request fails, and says nothing for other errors', async () => {
		controller.leafChanged();
		await settle();
		const shown = last();
		current = { ...NOTE, path: 'B.md', id: 'other' };
		load.mockRejectedValue(new ApiError('unavailable', 503));
		controller.leafChanged();
		await settle();
		expect(last()?.state).toBeNull();
		current = NOTE;
		load.mockRejectedValue(new ApiError('network', 0));
		controller.leafChanged();
		await settle();
		expect(last()?.state).toBe('Offline');
		expect(shown?.state).toBe('Filed. Updated by the Brain 3 minutes ago');
	});

	it('ignores an answer for a note that is no longer shown', async () => {
		let release: (value: Record<string, unknown>) => void = () => undefined;
		load.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
		controller.leafChanged();
		await settle();
		current = { path: 'B.md', id: null, frontmatter: {} };
		controller.leafChanged();
		await settle();
		release(body());
		await vi.advanceTimersByTimeAsync(0);
		expect(last()?.topic).toBeNull();
	});

	it('asks once more when a note being read gets its summary, and no more', async () => {
		load.mockResolvedValue(body({ state: 'reading', topic: null }));
		controller.leafChanged();
		await settle();
		expect(last()?.state).toBe('Reading…');
		// Typing changes the properties, not the summary.
		current = { ...NOTE, frontmatter: { title: 'x' } };
		controller.metadataChanged('A.md');
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
		load.mockResolvedValue(body());
		current = { ...NOTE, frontmatter: { 'brain-summary': 'Done.' } };
		controller.metadataChanged('A.md');
		await settle();
		expect(load).toHaveBeenCalledTimes(2);
		expect(last()).toMatchObject({ summary: 'Done.' });
		current = { ...NOTE, frontmatter: { 'brain-summary': 'Done again.' } };
		controller.metadataChanged('A.md');
		await settle();
		expect(load).toHaveBeenCalledTimes(2);
	});

	it('draws again for new settings without asking', async () => {
		controller.leafChanged();
		await settle();
		controller.settingsChanged();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it('draws nothing when no note is open, and asks nothing after it is disposed', async () => {
		controller.leafChanged();
		await settle();
		current = null;
		controller.leafChanged();
		await settle();
		expect(last()).toMatchObject({ state: null, topic: null, history: false });
		current = NOTE;
		controller.leafChanged();
		controller.dispose();
		await settle();
		expect(load).toHaveBeenCalledTimes(1);
	});
});

describe('asking the server', () => {
	const reply = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, text: JSON.stringify(body) });
	const api = (response: HttpResponse, seen: string[] = []) =>
		new NotesApi((request) => { seen.push(`${request.method} ${request.url}`); return Promise.resolve(response); }, ORIGIN, 'key');

	it('reads one note with one GET, and treats a 404 as no answer', async () => {
		const seen: string[] = [];
		expect(await api(reply(200, body()), seen).noteBrain(ID)).toMatchObject({ state: 'filed' });
		expect(seen).toEqual([`GET ${ORIGIN}/notes/api/notes/${ID}/brain`]);
		expect(await api(reply(404, { error: 'not_found' })).noteBrain(ID)).toBeNull();
	});

	it('raises other errors', async () => {
		await expect(api(reply(401, { error: 'unauthenticated' })).noteBrain(ID)).rejects.toMatchObject({ kind: 'unauthenticated' });
		await expect(api(reply(503, {})).noteBrain(ID)).rejects.toMatchObject({ kind: 'unavailable' });
	});
});
