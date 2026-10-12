import { App, Modal, Setting } from 'obsidian';
import type { FirstRunDecision, FirstRunProposal } from './firstrun';
import type { PlanSummary } from './sync';

function buttons(el: HTMLElement): HTMLElement {
	return el.createDiv({ cls: 'simplenote-sync-buttons' });
}

function list(el: HTMLElement, items: string[], max = 200): void {
	const ul = el.createEl('ul', { cls: 'simplenote-sync-list' });
	for (const it of items.slice(0, max)) ul.createEl('li', { text: it });
	if (items.length > max) ul.createEl('li', { text: `… and ${items.length - max} more` });
}

/** Mass-change guard (spec 9.3). */
export class ConfirmPlanModal extends Modal {
	private done = false;
	constructor(
		app: App,
		private readonly summary: PlanSummary,
		private readonly resolve: (ok: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle('Simplenote sync: large change');
		contentEl.createEl('p', {
			text: `This sync would change ${this.summary.change} note(s), move or retag ${this.summary.move}, and trash ${this.summary.trash}. Please check before continuing.`,
		});
		if (this.summary.causes.length > 0) {
			contentEl.createEl('p', { text: 'Cause:' });
			list(contentEl, this.summary.causes);
		}
		contentEl.createEl('p', { text: 'Actions:' });
		list(contentEl, this.summary.items);
		const b = buttons(contentEl);
		new Setting(b)
			.addButton((btn) =>
				btn.setButtonText('Cancel and pause sync').onClick(() => {
					this.finish(false);
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText('Apply changes')
					.setWarning()
					.onClick(() => {
						this.finish(true);
					}),
			);
	}

	private finish(ok: boolean): void {
		if (this.done) return;
		this.done = true;
		this.resolve(ok);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) {
			this.done = true;
			this.resolve(false);
		}
	}
}

export function confirmPlan(app: App, summary: PlanSummary): Promise<boolean> {
	return new Promise((resolve) => new ConfirmPlanModal(app, summary, resolve).open());
}

/** First-run linking summary (spec 9.6). */
export class FirstRunModal extends Modal {
	private done = false;
	private readonly confirmed = new Set<string>();
	private applyTitleFixes = true;

	constructor(
		app: App,
		private readonly proposal: FirstRunProposal,
		private readonly excludedPaths: string[],
		private readonly resolve: (d: FirstRunDecision | null) => void,
	) {
		super(app);
		for (const m of proposal.matches) if (m.method === 'probable') this.confirmed.add(m.remote.id);
	}

	onOpen(): void {
		const p = this.proposal;
		const { contentEl } = this;
		this.setTitle('Simplenote sync: first run');
		const exact = p.matches.filter((m) => m.method === 'exact');
		const titleLine = p.matches.filter((m) => m.method === 'title-line');
		const probable = p.matches.filter((m) => m.method === 'probable');
		contentEl.createEl('p', { text: 'Nothing has been written yet. Review the plan below.' });
		list(contentEl, [
			`${exact.length + titleLine.length} note(s) match an existing file exactly and will be linked`,
			`${titleLine.length} of those still contain the title as first line (title-line fix)`,
			`${probable.length} probable match(es) to confirm`,
			`${p.unmatchedLocal.length} local file(s) without a note: will be uploaded as new notes`,
			`${p.unmatchedRemote.length} Simplenote note(s) without a file: will be created in the vault`,
			`${this.excludedPaths.length} file(s) excluded (dot folders, excluded folders, size, non-markdown)`,
		]);
		const highMiss = p.missRate > 0.1 && p.unmatchedRemote.length > 0;
		if (highMiss) {
			contentEl.createEl('p', {
				text: `${Math.round(p.missRate * 100)}% of the Simplenote notes have no matching file. This is expected when the vault never had them. If you expected matches, cancel and check the vault.`,
			});
			contentEl.createEl('p', { text: 'Unmatched Simplenote notes:' });
			list(
				contentEl,
				p.unmatchedRemote.map((r) => r.data.content.split('\n')[0] ?? ''),
			);
		}
		if (titleLine.length > 0) {
			new Setting(contentEl)
				.setName('Remove duplicated title lines')
				.setDesc('The title now comes from the file name, so the first line is removed from these files.')
				.addToggle((t) => t.setValue(true).onChange((v) => (this.applyTitleFixes = v)));
			list(
				contentEl,
				titleLine.map((m) => m.local.path),
			);
		}
		if (probable.length > 0) {
			contentEl.createEl('p', { text: 'Probable matches (same title, at least 90% similar). Unchecked ones are treated as separate notes.' });
			new Setting(contentEl).setName('Confirm all').addToggle((t) =>
				t.setValue(true).onChange((v) => {
					this.confirmed.clear();
					if (v) for (const m of probable) this.confirmed.add(m.remote.id);
					this.contentEl.querySelectorAll<HTMLInputElement>('input[data-probable]').forEach((i) => (i.checked = v));
				}),
			);
			const ul = contentEl.createEl('ul', { cls: 'simplenote-sync-list' });
			for (const m of probable) {
				const li = ul.createEl('li');
				const cb = li.createEl('input', { type: 'checkbox' });
				cb.checked = true;
				cb.dataset.probable = m.remote.id;
				cb.addEventListener('change', () => {
					if (cb.checked) this.confirmed.add(m.remote.id);
					else this.confirmed.delete(m.remote.id);
				});
				li.createSpan({ text: ` ${m.local.path}  ⟷  "${m.remote.data.content.split('\n')[0] ?? ''}" (${Math.round(m.similarity * 100)}%)` });
			}
		}
		const b = buttons(contentEl);
		new Setting(b)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => {
					this.finish(null);
				}),
			)
			.addButton((btn) =>
				btn
					.setButtonText(highMiss ? 'Import unmatched notes as new files and continue' : 'Continue')
					.setCta()
					.onClick(() => {
						this.finish({ confirmedProbable: new Set(this.confirmed), applyTitleFixes: this.applyTitleFixes, importUnmatched: true, uploadUnmatched: true });
					}),
			);
	}

	private finish(d: FirstRunDecision | null): void {
		if (this.done) return;
		this.done = true;
		this.resolve(d);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.done) {
			this.done = true;
			this.resolve(null);
		}
	}
}

export function firstRunDialog(app: App, proposal: FirstRunProposal, excludedPaths: string[]): Promise<FirstRunDecision | null> {
	return new Promise((resolve) => new FirstRunModal(app, proposal, excludedPaths, resolve).open());
}

/** "Open sync log" (spec 9.8). */
export class LogModal extends Modal {
	constructor(
		app: App,
		private readonly lines: () => string[],
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Simplenote sync log');
		const { contentEl } = this;
		const pre = contentEl.createEl('pre', { cls: 'simplenote-sync-log' });
		pre.setText(this.lines().join('\n') || '(empty)');
		const b = buttons(contentEl);
		new Setting(b)
			.addButton((btn) =>
				btn.setButtonText('Copy').onClick(() => {
					void navigator.clipboard.writeText(this.lines().join('\n'));
				}),
			)
			.addButton((btn) =>
				btn.setButtonText('Refresh').onClick(() => {
					pre.setText(this.lines().join('\n') || '(empty)');
					pre.scrollTop = pre.scrollHeight;
				}),
			);
		pre.scrollTop = pre.scrollHeight;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
