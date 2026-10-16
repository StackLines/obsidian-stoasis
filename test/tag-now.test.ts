import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App, Menu, TFile, notices, openedModals, requests, setRequestHandler, type Control } from './stubs/obsidian';
import StoasisPlugin from '../src/main';
import type { TagModal } from '../src/tag-modal';
import { FakeControlPlane } from './helpers/control-plane';

const SERVER = 'https://notes.example.test';
const TOPIC = '0b6c1f7e-2d4a-4e8b-9c3f-5a7d1e2b4c6f';
const NOTE = 'Local/Plans.md';
const TEXT = '---\ntitle: Plans\nbrain-created: 2026-10-01\n---\nMet [[Alice Stone]] about the gardens.\n';

type TestPlugin = StoasisPlugin & {
	commands: Array<{ id: string; name: string; editorCheckCallback?: (...args: unknown[]) => boolean | void }>;
};

let control: FakeControlPlane;
const plugins: TestPlugin[] = [];

beforeEach(() => {
	notices.length = 0;
	requests.length = 0;
	openedModals.length = 0;
	control = new FakeControlPlane(SERVER);
	setRequestHandler(control.handle);
	control.suggest = () => ({
		status: 200,
		body: {
			patch: {
				tags_add: ['garden'],
				set: { 'brain-people': ['[[Alice Stone]]'], 'brain-topics': [TOPIC] },
				actor: 'agent',
			},
			matches: [
				{ kind: 'person', id: 'p1', name: 'Alice Stone', reason: 'wikilink', matched: 'Alice Stone' },
				{ kind: 'topic', id: TOPIC, name: 'Garden', reason: 'name_in_text', matched: 'gardens' },
			],
			errors: [],
		},
	});
});

afterEach(() => {
	for (const plugin of plugins.splice(0)) {
		plugin.onunload();
	}
	setRequestHandler(null);
});

/** A plugin on a device that is paired but syncs no folder, with one local note. */
async function setUp(paired = true) {
	const app = new App();
	app.vault.files.set(NOTE, TEXT);
	app.metadataCache.parse(NOTE, TEXT);
	const plugin = new StoasisPlugin(app as never, { id: 'stoasis', version: '0.2.0' } as never) as TestPlugin;
	plugins.push(plugin);
	await plugin.onload();
	if (paired) {
		expect(await plugin.pair(SERVER, 'ABCD2345', 'Desk')).toBe(true);
	}
	expect(plugin.settings.folder).toBe('');
	notices.length = 0;
	const file = new TFile(NOTE);
	/** The open editor, which holds the note's text as the app shows it. */
	const editor = { getValue: () => app.vault.files.get(NOTE) ?? '' };
	return { app, plugin, file, editor };
}

async function runCommand(plugin: TestPlugin, editor: unknown, file: TFile | null): Promise<boolean | void> {
	const command = plugin.commands.find((c) => c.id === 'tag-note-now');
	const available = command?.editorCheckCallback?.(true, editor, { file });
	if (available === true) {
		command?.editorCheckCallback?.(false, editor, { file });
		// The command starts the request without waiting for it.
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
	}
	return available;
}

function lastModal(): TagModal & { isOpen: boolean } {
	return openedModals[openedModals.length - 1] as unknown as TagModal & { isOpen: boolean };
}

function rendered(modal: TagModal) {
	const items = (modal.contentEl as unknown as { items: Array<{ name?: string; desc?: string; text?: string; controls?: Control[] }> }).items;
	return {
		lines: items.filter((i) => i.name !== undefined).map((i) => `${i.name}: ${i.desc}`),
		texts: items.filter((i) => i.text !== undefined).map((i) => i.text),
		buttons: items.flatMap((i) => i.controls ?? []).filter((c) => c.kind === 'button'),
	};
}

describe('Tag this note now', () => {
	it('is a command for markdown notes in an editor', async () => {
		const { plugin, editor } = await setUp();
		expect(plugin.commands.map((c) => c.name)).toContain('Tag this note now');
		expect(await runCommand(plugin, editor, null)).toBe(false);
		expect(await runCommand(plugin, editor, new TFile('Local/Board.canvas'))).toBe(false);
	});

	it('shows the proposed changes for a local-only note on a device that syncs nothing', async () => {
		const { plugin, file, editor } = await setUp();
		expect(await runCommand(plugin, editor, file)).toBe(true);
		expect(control.suggested).toEqual([TEXT]);
		const view = rendered(lastModal());
		expect(view.texts).toEqual(['Proposed changes to "Plans":']);
		expect(view.lines).toEqual([
			'tags: adds garden.',
			'brain-people: adds [[Alice Stone]]. From Alice Stone: linked in the note.',
			'brain-topics: adds Garden. From Topic Garden: named in the text (matched "gardens").',
			expect.stringMatching(/^brain-tagged: \d{4}-\d{2}-\d{2} by agent\.$/),
		]);
		expect(view.buttons.map((b) => b.label)).toEqual(['Cancel', 'Apply']);
	});

	it('writes the patch on Apply and keeps the frontmatter that was there', async () => {
		const { app, plugin, file, editor } = await setUp();
		await runCommand(plugin, editor, file);
		const modal = lastModal();
		await rendered(modal).buttons.find((b) => b.label === 'Apply')?.click();
		expect(modal.isOpen).toBe(false);
		const date = new Date().toISOString().slice(0, 10);
		expect(app.vault.files.get(NOTE)).toBe(
			'---\ntitle: Plans\nbrain-created: 2026-10-01\ntags:\n  - garden\nbrain-people:\n  - [[Alice Stone]]\n' +
				`brain-topics:\n  - ${TOPIC}\nbrain-tagged: ${date} by agent\n---\nMet [[Alice Stone]] about the gardens.\n`,
		);
		expect(notices).toEqual(['Asking the server for properties…', 'Tagged "Plans".']);
	});

	it('applies when only the text below the frontmatter changed', async () => {
		const { app, plugin, file, editor } = await setUp();
		await runCommand(plugin, editor, file);
		app.vault.files.set(NOTE, TEXT.replace('about the gardens.', 'about the gardens, and typed since.'));
		await rendered(lastModal()).buttons.find((b) => b.label === 'Apply')?.click();
		expect(app.vault.files.get(NOTE)).toMatch(/^---\ntitle: Plans\nbrain-created: 2026-10-01\ntags:\n {2}- garden\n/);
		expect(app.vault.files.get(NOTE)).toMatch(/\n---\nMet \[\[Alice Stone\]\] about the gardens, and typed since\.\n$/);
	});

	it('writes nothing when the frontmatter changed since the suggestion, and asks for a new one', async () => {
		const { app, plugin, file, editor } = await setUp();
		await runCommand(plugin, editor, file);
		const stale = lastModal();
		// Another edit adds a person while the proposal is open; the proposal would replace the list.
		const changed = '---\nbrain-people:\n  - [[Bob Example]]\n---\nMet [[Alice Stone]].\n';
		app.vault.files.set(NOTE, changed);
		app.metadataCache.parse(NOTE, changed);
		await rendered(stale).buttons.find((b) => b.label === 'Apply')?.click();
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
		expect(app.vault.files.get(NOTE)).toBe(changed);
		expect(stale.isOpen).toBe(false);
		expect(notices).toContain(
			'The properties of "Plans" changed since the suggestion, so nothing was written. Asking for a new suggestion.',
		);
		expect(control.suggested).toEqual([TEXT, changed]);
		const fresh = lastModal();
		expect(fresh).not.toBe(stale);
		expect(fresh.isOpen).toBe(true);
	});

	it('checks the file itself as it writes, when the editor still shows the old properties', async () => {
		const { app, plugin, file } = await setUp();
		const editor = { getValue: () => TEXT };
		await runCommand(plugin, editor, file);
		const changed = '---\nbrain-people:\n  - [[Bob Example]]\n---\nMet [[Alice Stone]].\n';
		app.vault.files.set(NOTE, changed);
		await rendered(lastModal()).buttons.find((b) => b.label === 'Apply')?.click();
		expect(app.vault.files.get(NOTE)).toBe(changed);
		expect(notices).toContain(
			'The properties of "Plans" changed since the suggestion, so nothing was written. Asking for a new suggestion.',
		);
	});

	it('asks only once more when the frontmatter keeps changing', async () => {
		const { app, plugin, file, editor } = await setUp();
		await runCommand(plugin, editor, file);
		app.vault.files.set(NOTE, '---\ntitle: Plans, renamed\n---\nMet [[Alice Stone]].\n');
		await rendered(lastModal()).buttons.find((b) => b.label === 'Apply')?.click();
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
		const changed = '---\ntitle: Plans, renamed again\n---\nMet [[Alice Stone]].\n';
		app.vault.files.set(NOTE, changed);
		await rendered(lastModal()).buttons.find((b) => b.label === 'Apply')?.click();
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
		expect(app.vault.files.get(NOTE)).toBe(changed);
		expect(control.suggested).toHaveLength(2);
		expect(notices.at(-1)).toBe(
			'The properties of "Plans" changed since the suggestion, so nothing was written. Run "Tag this note now" again.',
		);
	});

	it('writes nothing on Cancel', async () => {
		const { app, plugin, file, editor } = await setUp();
		await runCommand(plugin, editor, file);
		const modal = lastModal();
		await rendered(modal).buttons.find((b) => b.label === 'Cancel')?.click();
		expect(modal.isOpen).toBe(false);
		expect(app.vault.files.get(NOTE)).toBe(TEXT);
	});

	it('is in the editor menu too', async () => {
		const { app, file, editor } = await setUp();
		const menu = new Menu();
		app.workspace.trigger('editor-menu', menu, editor, { file });
		expect(menu.items.map((i) => i.title)).toEqual(['Tag this note now']);
		await menu.items[0]?.click();
		for (let i = 0; i < 10; i++) {
			await Promise.resolve();
		}
		expect(control.suggested).toEqual([TEXT]);
		expect(openedModals).toHaveLength(1);
	});

	it('says "Nothing to add" when the server has nothing', async () => {
		control.suggest = () => ({ status: 200, body: { patch: null, matches: [], errors: [] } });
		const { app, plugin, file, editor } = await setUp();
		await runCommand(plugin, editor, file);
		const view = rendered(lastModal());
		expect(view.texts).toEqual(['Nothing to add.']);
		expect(view.buttons.map((b) => b.label)).toEqual(['Close']);
		expect(app.vault.files.get(NOTE)).toBe(TEXT);
	});

	it('shows contract errors as text and offers nothing to apply', async () => {
		control.suggest = () => ({
			status: 200,
			body: { patch: null, matches: [], errors: [{ key: null, code: 'frontmatter_unparseable' }] },
		});
		const { plugin, file, editor } = await setUp();
		await runCommand(plugin, editor, file);
		const view = rendered(lastModal());
		expect(view.texts).toEqual([
			"The note's frontmatter can't be read. Fix it first, then tag the note again.",
			'Nothing was changed.',
		]);
		expect(view.buttons.map((b) => b.label)).toEqual(['Close']);
	});

	it('refuses a patch the contract does not allow, without showing it', async () => {
		control.suggest = () => ({
			status: 200,
			body: { patch: { tags_add: [], set: { 'brain-id': TOPIC }, actor: 'agent' }, matches: [], errors: [] },
		});
		const { app, plugin, file, editor } = await setUp();
		await runCommand(plugin, editor, file);
		expect(openedModals).toHaveLength(0);
		expect(notices.at(-1)).toBe('The server gave an unexpected answer. Check that it is a compatible server.');
		expect(app.vault.files.get(NOTE)).toBe(TEXT);
	});

	it("says when it couldn't reach the server", async () => {
		const { plugin, file, editor } = await setUp();
		setRequestHandler(null);
		await runCommand(plugin, editor, file);
		expect(openedModals).toHaveLength(0);
		expect(notices.at(-1)).toBe("Couldn't reach the server.");
	});

	it('asks to pair first, and sends nothing', async () => {
		const { plugin, file, editor } = await setUp(false);
		await runCommand(plugin, editor, file);
		expect(notices).toEqual(['Pair this device with a server first, in the plugin settings.']);
		expect(requests).toEqual([]);
	});

	it('does not send a note over 1 MiB', async () => {
		const { plugin, file } = await setUp();
		await runCommand(plugin, { getValue: () => 'x'.repeat(1024 * 1024 + 1) }, file);
		expect(control.suggested).toEqual([]);
		expect(notices).toEqual(['This note is too long to tag.']);
	});

	it('keeps the proposal open when the frontmatter cannot be written', async () => {
		const { app, plugin, file, editor } = await setUp();
		await runCommand(plugin, editor, file);
		app.fileManager.frontmatterError = new Error('bad YAML');
		const modal = lastModal();
		await rendered(modal).buttons.find((b) => b.label === 'Apply')?.click();
		expect(modal.isOpen).toBe(true);
		expect(notices.at(-1)).toBe('Stoasis could not write the properties: bad YAML');
		expect(app.vault.files.get(NOTE)).toBe(TEXT);
	});
});
