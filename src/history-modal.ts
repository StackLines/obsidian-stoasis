import { App, Modal, Setting } from 'obsidian';
import type { NoteVersion, VersionPage } from './api';
import { diffLines, type DiffLine } from './conflict';
import { describeVersion } from './history';

/** What the history window needs from the server and the note; nothing else crosses. */
export interface HistorySource {
	versions(before: number | null): Promise<VersionPage>;
	text(version: number): Promise<string>;
	/** The note as it reads now, unsaved typing included. */
	current(): Promise<string>;
	/** Writes the text into the note; false when the note changed or is gone. */
	restore(text: string, expected: string): Promise<boolean>;
}

/** Lists a note's earlier versions, shows how one differs from now, and restores it. */
export class HistoryModal extends Modal {
	private versions: NoteVersion[] = [];
	private next: number | null = null;
	private error = '';
	private busy = false;

	constructor(
		app: App,
		private readonly noteName: string,
		private readonly source: HistorySource,
		private readonly describeError: (error: unknown) => string,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText('Note history');
		this.contentEl.createEl('p', { text: 'Loading…' });
		await this.more(null);
	}

	/** Loads a page and shows the list. */
	async more(before: number | null): Promise<void> {
		try {
			const page = await this.source.versions(before);
			this.versions.push(...page.versions);
			this.next = page.nextBefore;
			this.error = '';
		} catch (error) {
			this.error = this.describeError(error);
		}
		this.list();
	}

	private list(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			text: `Earlier versions of "${this.noteName}". Choose one to see how it differs from the note now.`,
		});
		if (this.error !== '') {
			contentEl.createEl('p', { cls: 'stoasis-error', text: this.error });
		}
		if (this.versions.length === 0 && this.error === '') {
			contentEl.createEl('p', { text: 'This note has no saved versions yet.' });
		}
		for (const version of this.versions) {
			new Setting(contentEl).setName(describeVersion(version)).addButton((button) =>
				button.setButtonText('View').onClick(() => void this.view(version)),
			);
		}
		if (this.next !== null) {
			const before = this.next;
			new Setting(contentEl).addButton((button) =>
				button.setButtonText('Show older versions').onClick(() => void this.more(before)),
			);
		}
	}

	private async view(version: NoteVersion): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = true;
		let text: string;
		let current: string;
		try {
			[text, current] = await Promise.all([this.source.text(version.version), this.source.current()]);
		} catch (error) {
			this.error = this.describeError(error);
			this.busy = false;
			this.list();
			return;
		}
		this.busy = false;
		this.compare(version, text, current);
	}

	private compare(version: NoteVersion, text: string, current: string, changed = false): void {
		const { contentEl } = this;
		contentEl.empty();
		if (changed) {
			contentEl.createEl('p', {
				cls: 'stoasis-error',
				text: 'The note changed while this was open. This is how the version differs from it now.',
			});
		}
		contentEl.createEl('p', { text: describeVersion(version) });
		const lines: DiffLine[] = diffLines(text, current);
		if (!lines.some((line) => line.kind === 'copy' || line.kind === 'note')) {
			contentEl.createEl('p', { text: 'This version has the same text as the note now.' });
		}
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Lines marked − are only in this version, lines marked + only in the note now.',
		});
		const diff = contentEl.createDiv({ cls: 'stoasis-diff' });
		for (const line of lines) {
			if (line.kind === 'skip') {
				diff.createDiv({
					cls: 'stoasis-diff-skip',
					text: `… ${line.count} unchanged line${line.count === 1 ? '' : 's'}`,
				});
				continue;
			}
			const mark = line.kind === 'copy' ? '− ' : line.kind === 'note' ? '+ ' : '  ';
			diff.createDiv({ cls: `stoasis-diff-${line.kind}`, text: `${mark}${line.text}` });
		}
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Restore writes this version into the note as one edit, on every device. The text it replaces is usually kept in the history, once it has been saved as a version.',
		});
		new Setting(contentEl)
			.addButton((button) => button.setButtonText('Back').onClick(() => this.list()))
			.addButton((button) =>
				button
					.setButtonText('Restore this version')
					.setCta()
					.onClick(() => void this.restore(version, text, current)),
			);
	}

	private async restore(version: NoteVersion, text: string, current: string): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = true;
		try {
			if (await this.source.restore(text, current)) {
				this.close();
				return;
			}
			// The note changed since the comparison: show it again.
			this.busy = false;
			this.compare(version, text, await this.source.current(), true);
		} catch (error) {
			this.error = this.describeError(error);
			this.list();
		} finally {
			this.busy = false;
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
