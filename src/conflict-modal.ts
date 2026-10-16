import { App, Modal, Setting } from 'obsidian';
import type { DiffLine } from './conflict';

/**
 * What to do after a choice: close, stay open as it is (after an error), or
 * show the two files again because they changed.
 */
export type ConflictAnswer = 'close' | 'stay' | { lines: readonly DiffLine[] };

/** Shows a conflict copy against its note, and keeps the one the user picks. */
export class ConflictModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private readonly copyName: string,
		private readonly noteName: string,
		private lines: readonly DiffLine[],
		private readonly keep: (which: 'copy' | 'note') => Promise<ConflictAnswer>,
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText('Compare with the synced note');
		this.draw(false);
	}

	private draw(changed: boolean): void {
		const { contentEl, lines, copyName, noteName } = this;
		contentEl.empty();
		if (changed) {
			contentEl.createEl('p', {
				cls: 'stoasis-error',
				text: 'The two notes changed while this was open. This is how they differ now; choose again.',
			});
		}
		contentEl.createEl('p', {
			text:
				`"${copyName}" is the conflict copy, with the text this device had; "${noteName}" is the current ` +
				'synced note. Lines marked − are only in the conflict copy, lines marked + only in the synced note.',
		});
		if (!lines.some((line) => line.kind === 'copy' || line.kind === 'note')) {
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
			const mark = line.kind === 'copy' ? '− ' : line.kind === 'note' ? '+ ' : '  ';
			diff.createDiv({ cls: `stoasis-diff-${line.kind}`, text: `${mark}${line.text}` });
		}
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				`Use conflict copy puts the text of "${copyName}" into "${noteName}", on every device. ` +
				`Keep current synced note leaves "${noteName}" as it is. Either way "${copyName}" then moves ` +
				'to the trash.',
		});
		new Setting(contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) =>
				button.setButtonText('Keep current synced note').onClick(async () => {
					await this.choose('note');
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('Use conflict copy')
					.setCta()
					.onClick(async () => {
						await this.choose('copy');
					}),
			);
	}

	/** Keeps one side; closes when done, shows the files again when they changed. */
	async choose(which: 'copy' | 'note'): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = true;
		const answer = await this.keep(which);
		this.busy = false;
		if (answer === 'close') {
			this.close();
		} else if (answer !== 'stay') {
			this.lines = answer.lines;
			this.draw(true);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
