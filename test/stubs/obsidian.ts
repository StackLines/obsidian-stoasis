// Minimal stand-in for the `obsidian` module so pure code can be unit tested
// without the app. Only what the plugin's modules touch at import time.

export class Plugin {}

export class PluginSettingTab {
	containerEl = {};
	constructor(
		public app: unknown,
		public plugin: unknown,
	) {}
}

export class Setting {
	constructor(public containerEl: unknown) {}
	setName(): this {
		return this;
	}
	setDesc(): this {
		return this;
	}
	setHeading(): this {
		return this;
	}
}

export class Notice {
	constructor(public message: string) {}
}

export type App = unknown;
