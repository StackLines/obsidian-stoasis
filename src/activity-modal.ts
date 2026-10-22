import { App, Modal } from 'obsidian';
import { describeContact, describeEntry, formatWhen, splitPath, type ActivityEntry } from './activity';

/** What the sync window shows; read each time it opens. */
export interface ActivityView {
	/** The connection explained for people, as the settings tab says it. */
	status(): string;
	online(): boolean;
	contactAt(): number | null;
	entries(): readonly ActivityEntry[];
}

/** Shows the connection, the last contact with the server, and what synced lately. */
export class ActivityModal extends Modal {
	constructor(
		app: App,
		private readonly view: ActivityView,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText('Sync status and history');
		const entries = this.view.entries();
		contentEl.createEl('p', { text: this.view.status() });
		for (const line of describeContact(this.view.contactAt(), this.view.online(), entries[0], new Date())) {
			contentEl.createEl('p', { cls: 'setting-item-description', text: line });
		}
		if (entries.length === 0) {
			return;
		}
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'The last changes that went to or came from the server, newest first. Only names and paths are kept, on this device.',
		});
		const table = contentEl.createDiv({ cls: 'stoasis-activity' }).createEl('table');
		const head = table.createEl('thead').createEl('tr');
		for (const title of ['When', 'What', 'Note', 'Folder']) {
			head.createEl('th', { text: title });
		}
		const body = table.createEl('tbody');
		for (const entry of entries) {
			const { name, folder } = splitPath(entry.path);
			const row = body.createEl('tr');
			row.createEl('td', { text: formatWhen(entry.at) });
			row.createEl('td', { text: describeEntry(entry) });
			const note = row.createEl('td', { text: name });
			if (entry.from !== undefined) {
				note.setAttribute('aria-label', `Was ${entry.from}`);
			}
			row.createEl('td', { text: folder });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
