import { App, Modal, Setting } from 'obsidian';
import { MAX_DEVICE_LABEL } from './pairing';
import type { PairingRequest } from './protocol';

/** Asks before pairing from a link, since a link can come from anywhere. */
export class PairModal extends Modal {
	private label: string;
	private busy = false;

	constructor(
		app: App,
		private readonly request: PairingRequest,
		defaultLabel: string,
		private readonly currentServer: string,
		private readonly onPair: (label: string) => Promise<boolean>,
	) {
		super(app);
		this.label = defaultLabel;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText('Pair with server');
		contentEl.createEl('p', {
			text: `Pair this device with ${this.request.server}? It will sync the folder you choose with your notes on that server.`,
		});
		if (this.currentServer !== '') {
			contentEl.createEl('p', {
				text: `This replaces the current pairing with ${this.currentServer}.`,
			});
		}
		new Setting(contentEl)
			.setName('Device name')
			.setDesc('Shown in your list of devices on the server.')
			.addText((text) =>
				text.setValue(this.label).onChange((value) => {
					this.label = value.slice(0, MAX_DEVICE_LABEL);
				}),
			);
		new Setting(contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText('Pair')
					.setCta()
					.onClick(async () => {
						await this.confirm();
					}),
			);
	}

	/** Pairs with the label entered; closes on success, stays open on failure. */
	async confirm(): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = true;
		const ok = await this.onPair(this.label);
		this.busy = false;
		if (ok) {
			this.close();
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
