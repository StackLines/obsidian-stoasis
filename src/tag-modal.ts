import { App, Modal, Setting } from 'obsidian';
import type { Proposal } from './tagging';

/** Shows what tagging a note would change, and applies it only when asked. */
export class TagModal extends Modal {
	private busy = false;

	constructor(
		app: App,
		private readonly noteName: string,
		private readonly proposal: Proposal,
		private readonly onApply: () => Promise<boolean>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, proposal } = this;
		this.titleEl.setText('Tag this note');
		for (const error of proposal.errors) {
			contentEl.createEl('p', { cls: 'stoasis-error', text: error });
		}
		if (proposal.errors.length > 0) {
			contentEl.createEl('p', { text: 'Nothing was changed.' });
		} else if (proposal.lines.length === 0) {
			contentEl.createEl('p', { text: 'Nothing to add.' });
		} else {
			contentEl.createEl('p', { text: `Proposed changes to "${this.noteName}":` });
			for (const line of proposal.lines) {
				const from = line.sources.length > 0 ? ` From ${line.sources.join('; ')}.` : '';
				new Setting(contentEl).setName(line.key).setDesc(`${line.text}.${from}`);
			}
		}
		if (proposal.others.length > 0) {
			contentEl.createEl('p', {
				cls: 'stoasis-disclosure',
				text: `Already in the note: ${proposal.others.join('; ')}.`,
			});
		}

		const buttons = new Setting(contentEl);
		if (proposal.patch === null) {
			buttons.addButton((button) => button.setButtonText('Close').onClick(() => this.close()));
			return;
		}
		buttons
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText('Apply')
					.setCta()
					.onClick(async () => {
						await this.apply();
					}),
			);
	}

	/** Writes the proposal; closes on success, stays open on failure. */
	async apply(): Promise<void> {
		if (this.busy || this.proposal.patch === null) {
			return;
		}
		this.busy = true;
		const ok = await this.onApply();
		this.busy = false;
		if (ok) {
			this.close();
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
