// Minimal stand-in for the `obsidian` module so modules can be unit tested
// without the app. It records what the plugin registers and displays.

export const notices: string[] = [];

export class Notice {
	constructor(message: string) {
		notices.push(message);
	}
}

export class StatusBarItem {
	text = '';
	classes: string[] = [];
	addClass(cls: string): void {
		this.classes.push(cls);
	}
	setText(text: string): void {
		this.text = text;
	}
}

export type ProtocolHandler = (params: Record<string, string>) => void;

export class Plugin {
	app: unknown = {};
	statusItems: StatusBarItem[] = [];
	protocolHandlers = new Map<string, ProtocolHandler>();
	settingTabs: unknown[] = [];
	saved: unknown[] = [];
	storedData: unknown = null;

	constructor(app?: unknown) {
		if (app !== undefined) {
			this.app = app;
		}
	}
	addStatusBarItem(): StatusBarItem {
		const item = new StatusBarItem();
		this.statusItems.push(item);
		return item;
	}
	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}
	registerObsidianProtocolHandler(action: string, handler: ProtocolHandler): void {
		this.protocolHandlers.set(action, handler);
	}
	loadData(): Promise<unknown> {
		return Promise.resolve(this.storedData);
	}
	saveData(data: unknown): Promise<void> {
		this.saved.push(data);
		return Promise.resolve();
	}
}

/** A rendered settings row or paragraph, in the order it was added. */
export interface RenderedItem {
	kind: 'setting' | 'heading' | 'element';
	tag?: string;
	cls?: string;
	name?: string;
	desc?: string;
	text?: string;
}

export class ContainerEl {
	items: RenderedItem[] = [];
	empty(): void {
		this.items.length = 0;
	}
	createEl(tag: string, options: { cls?: string; text?: string } = {}): void {
		this.items.push({ kind: 'element', tag, ...options });
	}
}

export class PluginSettingTab {
	containerEl = new ContainerEl();
	constructor(
		public app: unknown,
		public plugin: unknown,
	) {}
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
}

export type App = unknown;
