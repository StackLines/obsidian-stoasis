import { App, Modal, Setting } from 'obsidian';
import type { DiffLine } from './conflict';

/** Shows a conflict copy against its note, and keeps the one the user picks. */
export class ConflictModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private readonly copyName: string,
		private readonly noteName: string,
		private readonly lines: readonly DiffLine[],
		private readonly keep: (which: 'device' | 'server') => Promise<boolean>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, lines } = this;
		this.titleEl.setText('Compare with the synced note');
		contentEl.createEl('p', {
			text:
				`"${this.copyName}" has the text this device had; "${this.noteName}" has the server's. ` +
				'Lines marked − are only in this device\'s copy, lines marked + only on the server.',
		});
		if (!lines.some((line) => line.kind === 'device' || line.kind === 'server')) {
			contentEl.createEl('p', { text: 'The two have the same text.' });
		}
		const diff = contentEl.createDiv({ cls: 'stoasis-diff' });
		for (const line of lines) {
			if (line.kind === 'skip') {
				diff.createDiv({
					cls: 'stoasis-diff-skip',
					text: `… ${line.count} unchanged line${line.count === 1 ? '' : 's'}`,
				});
				continue;
			}
			const mark = line.kind === 'device' ? '− ' : line.kind === 'server' ? '+ ' : '  ';
			diff.createDiv({ cls: `stoasis-diff-${line.kind}`, text: `${mark}${line.text}` });
		}
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Keep this device puts the copy\'s text into the note, on every device. ' +
				'Keep the server leaves the note as it is. Either way the copy moves to the trash.',
		});
		new Setting(contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) =>
				button.setButtonText('Keep the server').onClick(async () => {
					await this.choose('server');
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('Keep this device')
					.setCta()
					.onClick(async () => {
						await this.choose('device');
					}),
			);
	}

	/** Keeps one side; closes on success, stays open on failure. */
	async choose(which: 'device' | 'server'): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = true;
		const ok = await this.keep(which);
		this.busy = false;
		if (ok) {
			this.close();
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
