import { App, Modal, Setting } from 'obsidian';

/** Asks a yes or no question; resolves false when the window is closed any other way. */
export class ConfirmModal extends Modal {
	private answered = false;
	private resolve: (answer: boolean) => void = () => undefined;

	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
		private readonly confirmLabel: string,
	) {
		super(app);
	}

	/** Opens the window and waits for the answer. */
	ask(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		this.titleEl.setText(this.title);
		this.contentEl.createEl('p', { text: this.message });
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.confirmLabel)
					.setCta()
					.onClick(() => {
						this.answer(true);
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.answer(false);
	}

	private answer(value: boolean): void {
		if (!this.answered) {
			this.answered = true;
			this.resolve(value);
		}
	}
}
