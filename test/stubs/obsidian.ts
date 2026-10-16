// Minimal stand-in for the `obsidian` module so modules can be unit tested
// without the app. It records what the plugin registers and displays, and
// keeps a small vault in memory.

export const notices: string[] = [];
/** Every notice shown, to follow one that updates in place. */
export const shownNotices: Notice[] = [];

export class Notice {
	message: string;
	hidden = false;
	constructor(
		message: string,
		readonly duration?: number,
	) {
		this.message = message;
		notices.push(message);
		shownNotices.push(this);
	}
	setMessage(message: string): this {
		this.message = message;
		return this;
	}
	hide(): void {
		this.hidden = true;
	}
}

export const Platform = {
	isIosApp: false,
	isAndroidApp: false,
	isMacOS: false,
	isWin: false,
	isMobile: false,
};

// HTTP: tests install a handler; without one every request fails.

export interface RequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	contentType?: string;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}

export const requests: RequestUrlParam[] = [];
let requestHandler: ((request: RequestUrlParam) => RequestUrlResponse) | null = null;

export function setRequestHandler(handler: ((request: RequestUrlParam) => RequestUrlResponse) | null): void {
	requestHandler = handler;
}

export function requestUrl(request: RequestUrlParam): Promise<RequestUrlResponse> {
	requests.push(request);
	if (requestHandler === null) {
		return Promise.reject(new Error('offline'));
	}
	return Promise.resolve(requestHandler(request));
}

// Elements.

/** A rendered settings row or paragraph, in the order it was added. */
export interface RenderedItem {
	kind: 'setting' | 'heading' | 'element';
	tag?: string;
	cls?: string;
	name?: string;
	desc?: string;
	text?: string;
	controls?: Control[];
	/** What was added inside an element. */
	children?: RenderedItem[];
}

export class ContainerEl {
	items: RenderedItem[] = [];
	text = '';
	attributes: Record<string, string> = {};
	classes: string[] = [];
	empty(): void {
		this.items.length = 0;
	}
	createEl(tag: string, options: { cls?: string; text?: string } = {}): ContainerEl {
		const child = new ContainerEl();
		this.items.push({ kind: 'element', tag, ...options, children: child.items });
		return child;
	}
	createDiv(options: { cls?: string; text?: string } = {}): ContainerEl {
		const child = new ContainerEl();
		this.items.push({ kind: 'element', tag: 'div', ...options, children: child.items });
		return child;
	}
	setText(text: string): void {
		this.text = text;
	}
	addClass(cls: string): void {
		this.classes.push(cls);
	}
	setAttribute(name: string, value: string): void {
		this.attributes[name] = value;
	}
}

/** Kept for tests that read the status bar item. */
export type StatusBarItem = ContainerEl;

export class Control {
	kind: 'text' | 'button' | 'dropdown' | 'toggle';
	value: unknown = '';
	label = '';
	disabled = false;
	options: Array<[string, string]> = [];
	private changeHandler: ((value: never) => unknown) | null = null;
	private clickHandler: (() => unknown) | null = null;

	constructor(kind: Control['kind']) {
		this.kind = kind;
	}
	setValue(value: unknown): this {
		this.value = value;
		return this;
	}
	setPlaceholder(): this {
		return this;
	}
	onChange(handler: (value: never) => unknown): this {
		this.changeHandler = handler;
		return this;
	}
	setButtonText(label: string): this {
		this.label = label;
		return this;
	}
	setCta(): this {
		return this;
	}
	setWarning(): this {
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.disabled = disabled;
		return this;
	}
	onClick(handler: () => unknown): this {
		this.clickHandler = handler;
		return this;
	}
	addOption(value: string, label: string): this {
		this.options.push([value, label]);
		return this;
	}
	// What the user does.
	async change(value: unknown): Promise<void> {
		this.value = value;
		await this.changeHandler?.(value as never);
	}
	async click(): Promise<void> {
		await this.clickHandler?.();
	}
}

export class Setting {
	private item: RenderedItem = { kind: 'setting' };
	constructor(containerEl: ContainerEl) {
		containerEl.items.push(this.item);
	}
	setName(name: string): this {
		this.item.name = name;
		return this;
	}
	setDesc(desc: string): this {
		this.item.desc = desc;
		return this;
	}
	setHeading(): this {
		this.item.kind = 'heading';
		return this;
	}
	private add(kind: Control['kind'], build: (control: never) => unknown): this {
		const control = new Control(kind);
		(this.item.controls ??= []).push(control);
		build(control as never);
		return this;
	}
	addText(build: (control: never) => unknown): this {
		return this.add('text', build);
	}
	addButton(build: (control: never) => unknown): this {
		return this.add('button', build);
	}
	addDropdown(build: (control: never) => unknown): this {
		return this.add('dropdown', build);
	}
	addToggle(build: (control: never) => unknown): this {
		return this.add('toggle', build);
	}
}

// Vault.

export class TAbstractFile {
	constructor(public path: string) {}
	get name(): string {
		return this.path.split('/').pop() ?? '';
	}
}
export class TFile extends TAbstractFile {
	get basename(): string {
		return this.name.replace(/\.[^.]*$/, '');
	}
	get extension(): string {
		return this.path.split('.').pop() ?? '';
	}
}
export class TFolder extends TAbstractFile {
	constructor(
		path: string,
		public children: TAbstractFile[] = [],
	) {
		super(path);
	}
}

type Listener = (...args: unknown[]) => void;

/** The file system under the vault, which also holds what the vault does not list. */
export class DataAdapter {
	/** Files the vault does not list, such as its configuration. */
	readonly hidden = new Map<string, string>();
	/** Where the vault is on the device; null where the app does not tell. */
	basePath: string | null = '/home/user/Vault';
	constructor(private readonly vault: Vault) {}
	getFullPath(path: string): string {
		if (this.basePath === null) {
			throw new Error('No full paths here');
		}
		return `${this.basePath}/${path}`;
	}
	exists(path: string): Promise<boolean> {
		const all = [...this.hidden.keys(), ...this.vault.files.keys(), ...this.vault.folders];
		return Promise.resolve(all.some((p) => p === path || p.startsWith(`${path}/`)));
	}
	read(path: string): Promise<string> {
		const text = this.hidden.get(path) ?? this.vault.files.get(path);
		return text === undefined ? Promise.reject(new Error(`No file ${path}`)) : Promise.resolve(text);
	}
}

export class Vault {
	configDir = '.obsidian';
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly adapter: DataAdapter = new DataAdapter(this);
	private readonly listeners = new Map<string, Set<Listener>>();
	/** One object per file, as the app keeps: a rename changes its path, a delete drops it. */
	private readonly objects = new Map<string, TFile>();

	/** The object for the file at `path`. */
	fileAt(path: string): TFile {
		let file = this.objects.get(path);
		if (file === undefined) {
			file = new TFile(path);
			this.objects.set(path, file);
		}
		return file;
	}
	private moveObject(from: string, to: string): TFile {
		const file = this.fileAt(from);
		this.objects.delete(from);
		file.path = to;
		this.objects.set(to, file);
		return file;
	}

	on(name: string, listener: Listener): { name: string; listener: Listener } {
		let set = this.listeners.get(name);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(name, set);
		}
		set.add(listener);
		return { name, listener };
	}
	offref(ref: { name: string; listener: Listener }): void {
		this.listeners.get(ref.name)?.delete(ref.listener);
	}
	trigger(name: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(name) ?? []) {
			listener(...args);
		}
	}
	getAbstractFileByPath(path: string): TAbstractFile | null {
		if (this.files.has(path)) {
			return this.fileAt(path);
		}
		return this.folders.has(path) ? new TFolder(path, this.children(path)) : null;
	}
	/** What a folder holds directly, including folders only implied by file paths. */
	private children(folder: string): TAbstractFile[] {
		const prefix = `${folder}/`;
		const names = new Map<string, TAbstractFile>();
		for (const path of [...this.folders, ...this.files.keys()]) {
			if (!path.startsWith(prefix)) {
				continue;
			}
			const name = path.slice(prefix.length).split('/')[0] ?? '';
			const child = prefix + name;
			if (!names.has(child)) {
				names.set(child, this.files.has(child) ? this.fileAt(child) : new TFolder(child));
			}
		}
		return [...names.values()];
	}
	getMarkdownFiles(): TFile[] {
		return [...this.files.keys()].filter((p) => p.endsWith('.md')).map((p) => this.fileAt(p));
	}
	getAllFolders(): TFolder[] {
		return [...this.folders].map((p) => new TFolder(p));
	}
	read(file: TFile): Promise<string> {
		return Promise.resolve(this.files.get(file.path) ?? '');
	}
	createFolder(path: string): Promise<TFolder> {
		this.folders.add(path);
		this.trigger('create', new TFolder(path));
		return Promise.resolve(new TFolder(path));
	}
	create(path: string, text: string): Promise<TFile> {
		this.files.set(path, text);
		this.objects.delete(path);
		const file = this.fileAt(path);
		this.trigger('create', file);
		return Promise.resolve(file);
	}
	modify(file: TFile, text: string): Promise<void> {
		this.files.set(file.path, text);
		this.trigger('modify', file);
		return Promise.resolve();
	}
	process(file: TFile, update: (text: string) => string): Promise<string> {
		const next = update(this.files.get(file.path) ?? '');
		this.files.set(file.path, next);
		this.trigger('modify', file);
		return Promise.resolve(next);
	}
	rename(file: TAbstractFile, to: string): Promise<void> {
		const from = file.path;
		if (this.folders.delete(from)) {
			this.folders.add(to);
			this.trigger('rename', new TFolder(to), from);
			for (const [path, text] of [...this.files]) {
				if (path.startsWith(`${from}/`)) {
					const moved = to + path.slice(from.length);
					this.files.delete(path);
					this.files.set(moved, text);
					this.trigger('rename', this.moveObject(path, moved), path);
				}
			}
			return Promise.resolve();
		}
		const text = this.files.get(from) ?? '';
		this.files.delete(from);
		this.files.set(to, text);
		this.trigger('rename', this.moveObject(from, to), from);
		return Promise.resolve();
	}
	delete(file: TAbstractFile): Promise<void> {
		if (this.folders.delete(file.path)) {
			for (const path of [...this.files.keys()]) {
				if (path.startsWith(`${file.path}/`)) {
					this.files.delete(path);
					const gone = this.fileAt(path);
					this.objects.delete(path);
					this.trigger('delete', gone);
				}
			}
			this.trigger('delete', new TFolder(file.path));
			return Promise.resolve();
		}
		this.files.delete(file.path);
		this.objects.delete(file.path);
		this.trigger('delete', file);
		return Promise.resolve();
	}
}

export class FileManager {
	/** Thrown from processFrontMatter when set, like the app does for YAML it cannot parse. */
	frontmatterError: Error | null = null;
	constructor(
		private readonly vault: Vault,
		private readonly cache: MetadataCache,
	) {}
	trashFile(file: TAbstractFile): Promise<void> {
		return this.vault.delete(file);
	}
	/**
	 * Hands over the note's frontmatter, then writes it back as the app would:
	 * `key: value` lines, lists as `- item` lines, in the object's key order.
	 */
	async processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
		if (this.frontmatterError !== null) {
			throw this.frontmatterError;
		}
		await this.vault.process(file, (text) => {
			const { frontmatter, body } = splitFrontmatter(text);
			fn(frontmatter);
			const yaml = Object.entries(frontmatter)
				.map(([key, value]) =>
					Array.isArray(value)
						? `${key}:\n${value.map((item) => `  - ${String(item)}`).join('\n')}`
						: `${key}: ${String(value)}`,
				)
				.join('\n');
			return yaml === '' ? body : `---\n${yaml}\n---\n${body}`;
		});
		this.cache.parse(file.path, this.vault.files.get(file.path) ?? '');
	}
}

/** Reads the simple frontmatter the stub writes: `key: value` and `- item` lines. */
export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = /^---\n([\s\S]*?)\n?---\n/.exec(text);
	if (match === null) {
		return { frontmatter: {}, body: text };
	}
	const frontmatter: Record<string, unknown> = {};
	let list: unknown[] | null = null;
	for (const line of (match[1] ?? '').split('\n')) {
		const item = /^\s+- (.*)$/.exec(line);
		if (item !== null && list !== null) {
			list.push(item[1]);
			continue;
		}
		const pair = /^([^:]+):\s*(.*)$/.exec(line);
		if (pair !== null) {
			const key = pair[1] ?? '';
			if (pair[2] === '') {
				list = [];
				frontmatter[key] = list;
			} else {
				list = null;
				frontmatter[key] = pair[2];
			}
		}
	}
	return { frontmatter, body: text.slice(match[0].length) };
}

export class MetadataCache {
	private readonly frontmatter = new Map<string, Record<string, unknown>>();
	getFileCache(file: TFile): { frontmatter?: Record<string, unknown> } | null {
		const frontmatter = this.frontmatter.get(file.path);
		return frontmatter === undefined ? {} : { frontmatter };
	}
	/** What the app's indexer does when a note changes. */
	parse(path: string, text: string): void {
		const { frontmatter } = splitFrontmatter(text);
		if (Object.keys(frontmatter).length === 0) {
			this.frontmatter.delete(path);
		} else {
			this.frontmatter.set(path, frontmatter);
		}
	}
}

export class MenuItem {
	title = '';
	icon = '';
	private clickHandler: (() => unknown) | null = null;
	setTitle(title: string): this {
		this.title = title;
		return this;
	}
	setIcon(icon: string): this {
		this.icon = icon;
		return this;
	}
	onClick(handler: () => unknown): this {
		this.clickHandler = handler;
		return this;
	}
	async click(): Promise<void> {
		await this.clickHandler?.();
	}
}

export class Menu {
	items: MenuItem[] = [];
	addItem(build: (item: MenuItem) => unknown): this {
		const item = new MenuItem();
		this.items.push(item);
		build(item);
		return this;
	}
}

/** An open Markdown editor: the file it shows and its text, saved or not. */
export class MarkdownView {
	constructor(
		public file: TFile | null,
		private text: string,
	) {}
	editor = {
		getValue: (): string => this.text,
		setValue: (text: string): void => {
			this.text = text;
		},
	};
}

export class Workspace {
	/** The open panes; tests add Markdown views here. */
	readonly leaves: Array<{ view: unknown }> = [];
	getLeavesOfType(type: string): Array<{ view: unknown }> {
		return type === 'markdown' ? this.leaves.filter((leaf) => leaf.view instanceof MarkdownView) : [];
	}
	private readyCallbacks: Array<() => void> = [];
	private readonly listeners = new Map<string, Listener[]>();
	layoutReady = false;
	on(name: string, listener: Listener): { name: string; listener: Listener } {
		this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
		return { name, listener };
	}
	trigger(name: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(name) ?? []) {
			listener(...args);
		}
	}
	onLayoutReady(callback: () => void): void {
		if (this.layoutReady) {
			callback();
		} else {
			this.readyCallbacks.push(callback);
		}
	}
	ready(): void {
		this.layoutReady = true;
		for (const callback of this.readyCallbacks.splice(0)) {
			callback();
		}
	}
}

export class App {
	vault = new Vault();
	metadataCache = new MetadataCache();
	fileManager = new FileManager(this.vault, this.metadataCache);
	workspace = new Workspace();
}

// Plugins.

export type ProtocolHandler = (params: Record<string, string>) => void;

export class Plugin {
	app: App;
	manifest: { id: string; version: string };
	statusItems: ContainerEl[] = [];
	protocolHandlers = new Map<string, ProtocolHandler>();
	settingTabs: unknown[] = [];
	commands: Array<{ id: string; name: string; editorCheckCallback?: (...args: never[]) => boolean | void }> = [];
	editorExtensions: unknown[] = [];
	events: Array<{ name: string; listener: Listener }> = [];
	saved: unknown[] = [];
	storedData: unknown = null;

	constructor(app?: App, manifest?: { id: string; version: string }) {
		this.app = app ?? new App();
		this.manifest = manifest ?? { id: 'stoasis', version: '0.1.0' };
	}
	addStatusBarItem(): ContainerEl {
		const item = new ContainerEl();
		this.statusItems.push(item);
		return item;
	}
	addCommand<T extends { id: string; name: string }>(command: T): T {
		this.commands.push(command);
		return command;
	}
	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}
	registerObsidianProtocolHandler(action: string, handler: ProtocolHandler): void {
		this.protocolHandlers.set(action, handler);
	}
	registerEditorExtension(extension: unknown): void {
		this.editorExtensions.push(extension);
	}
	registerEvent(ref: { name: string; listener: Listener }): void {
		this.events.push(ref);
	}
	loadData(): Promise<unknown> {
		return Promise.resolve(this.storedData);
	}
	saveData(data: unknown): Promise<void> {
		this.saved.push(JSON.parse(JSON.stringify(data)));
		this.storedData = JSON.parse(JSON.stringify(data));
		return Promise.resolve();
	}
}

export class PluginSettingTab {
	containerEl = new ContainerEl();
	constructor(
		public app: unknown,
		public plugin: unknown,
	) {}
	hide(): void {}
}

export const openedModals: Modal[] = [];

export class Modal {
	titleEl = new ContainerEl();
	contentEl = new ContainerEl();
	isOpen = false;
	constructor(public app: unknown) {}
	open(): void {
		this.isOpen = true;
		openedModals.push(this);
		this.onOpen();
	}
	close(): void {
		this.isOpen = false;
		this.onClose();
	}
	onOpen(): void {}
	onClose(): void {}
}

/** The editor state field holding the open file; unused outside the app. */
export const editorInfoField = {};
