import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { PanelController, type PanelHost, type PanelModel, type Target } from './panel';

export const PANEL_VIEW = 'stoasis-brain';

/** What the panel does on a click; everything else only reads. */
export interface PanelActions {
	/** Opens the note in this vault if it is there; false when it is not. */
	openNote(noteId: string): boolean;
	openUrl(url: string): void;
	history(): void;
	hide(): void;
}

/** The right-hand side panel with what the Brain knows about the open note. */
export class BrainPanelView extends ItemView {
	private controller: PanelController | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly makeHost: (render: (model: PanelModel) => void) => PanelHost,
		private readonly actions: PanelActions,
	) {
		super(leaf);
	}

	getViewType(): string {
		return PANEL_VIEW;
	}

	getDisplayText(): string {
		return 'Brain';
	}

	getIcon(): string {
		return 'sparkles';
	}

	onOpen(): Promise<void> {
		this.contentEl.addClass('stoasis-panel');
		const controller = new PanelController(this.makeHost((model) => this.draw(model)));
		this.controller = controller;
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => controller.leafChanged()));
		// Opening another note in the same pane changes the file, not the active leaf.
		this.registerEvent(this.app.workspace.on('file-open', () => controller.leafChanged()));
		this.registerEvent(this.app.metadataCache.on('changed', (file) => controller.metadataChanged(file.path)));
		controller.leafChanged();
		return Promise.resolve();
	}

	/** Draws again after the settings changed. */
	settingsChanged(): void {
		this.controller?.settingsChanged();
	}

	onClose(): Promise<void> {
		this.controller?.dispose();
		this.controller = null;
		return Promise.resolve();
	}

	private draw(model: PanelModel): void {
		const root = this.contentEl;
		root.empty();
		const head = root.createDiv({ cls: 'stoasis-panel-head' });
		head.createDiv({ cls: 'stoasis-panel-title', text: 'Brain' });
		this.button(head, 'Hide', () => this.actions.hide());

		if (model.state !== null) {
			root.createDiv({ cls: 'stoasis-panel-dim', text: model.state });
		}
		if (model.summary !== null) {
			root.createDiv({ cls: 'stoasis-panel-brain stoasis-panel-summary', text: model.summary });
		}
		if (model.tags.length > 0) {
			root.createDiv({ cls: 'stoasis-panel-dim', text: model.tags.map((t) => `#${t}`).join(' ') });
		}

		const topic = model.topic;
		if (topic !== null) {
			const block = root.createDiv({ cls: 'stoasis-panel-block' });
			const row = block.createDiv({ cls: 'stoasis-panel-row' });
			row.createDiv({ cls: 'stoasis-panel-brain stoasis-panel-topic', text: topic.name });
			if (topic.sharedWith !== null) {
				row.createDiv({ cls: 'stoasis-panel-dim', text: topic.sharedWith });
			}
			if (topic.open !== null) {
				this.button(row, 'Open', () => this.go(topic.open));
			}
			if (topic.counts !== null) {
				block.createDiv({ cls: 'stoasis-panel-dim', text: topic.counts });
			}
			for (const item of [...topic.tasks, ...(topic.decision === null ? [] : [topic.decision])]) {
				const line = block.createDiv({ cls: 'stoasis-panel-row stoasis-panel-item' });
				line.createDiv({ text: item.title });
				if (item.meta !== null) {
					line.createDiv({ cls: 'stoasis-panel-dim', text: item.meta });
				}
			}
		}

		if (model.people.length > 0 || model.related.length > 0) {
			const block = root.createDiv({ cls: 'stoasis-panel-block' });
			if (model.people.length > 0) {
				const row = block.createDiv({ cls: 'stoasis-panel-row' });
				for (const person of model.people) {
					const cls = person.added ? 'stoasis-panel-brain' : '';
					if (person.target === null) {
						row.createDiv({ cls, text: person.name });
					} else {
						const target = person.target;
						this.link(row, person.name, cls, () => this.go(target));
					}
				}
			}
			for (const note of model.related) {
				const row = block.createDiv({ cls: 'stoasis-panel-row' });
				if (note.also !== null) {
					row.createDiv({ cls: 'stoasis-panel-dim', text: note.also });
				}
				const target = note.target;
				this.link(row, note.title, '', () => this.go(target));
			}
		}

		if (model.history) {
			const foot = root.createDiv({ cls: 'stoasis-panel-block stoasis-panel-row' });
			this.link(foot, 'History', 'stoasis-panel-dim', () => this.actions.history());
		}
	}

	private go(target: Target | null): void {
		if (target === null) {
			return;
		}
		if (target.noteId !== null && this.actions.openNote(target.noteId)) {
			return;
		}
		if (target.url !== null) {
			this.actions.openUrl(target.url);
		}
	}

	/** A button the user presses; a tap works the same as a click. */
	private button(parent: HTMLElement, label: string, onClick: () => void): void {
		const button = parent.createEl('button', { cls: 'stoasis-panel-button', text: label });
		button.addEventListener('click', onClick);
	}

	private link(parent: HTMLElement, label: string, cls: string, onClick: () => void): void {
		const link = parent.createEl('a', { cls: `stoasis-panel-link ${cls}`.trim(), text: label });
		link.setAttribute('role', 'button');
		link.setAttribute('tabindex', '0');
		link.addEventListener('click', onClick);
		link.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				onClick();
			}
		});
	}
}
