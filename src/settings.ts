import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type SimplenoteSyncPlugin from './main';

/** Settings stored in data.json (shared between devices through the vault). */
export interface SimplenoteSyncSettings {
	email: string;
	syncIntervalSeconds: number;
	idleIntervalSeconds: number;
	excludedFolders: string[];
	maxNoteSizeKb: number;
	dryRun: boolean;
	debugLogging: boolean;
	translateLinks: boolean;
	hideProperties: boolean;
	tagStyle: 'inline' | 'property';
	/** The vault is shared between devices through iCloud or Obsidian Sync: only one device syncs at a time. */
	sharedVault: boolean;
	appId: string;
	apiKey: string;
}

export const DEFAULT_APP_ID = 'chalk-bump-f49';
/** Public client key of the official Simplenote apps (see NOTES.md). */
export const DEFAULT_API_KEY = 'c8c2b86337154cdabc989b23e30c6bf4';

export const DEFAULT_SETTINGS: SimplenoteSyncSettings = {
	email: '',
	syncIntervalSeconds: 10,
	idleIntervalSeconds: 60,
	excludedFolders: [],
	maxNoteSizeKb: 975,
	dryRun: false,
	debugLogging: false,
	translateLinks: false,
	hideProperties: true,
	tagStyle: 'inline',
	sharedVault: true,
	appId: DEFAULT_APP_ID,
	apiKey: DEFAULT_API_KEY,
};

export const MIN_SYNC_INTERVAL = 10;
/** How long after the last change (either side) the fast interval stays in effect. */
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export class SimplenoteSettingTab extends PluginSettingTab {
	plugin: SimplenoteSyncPlugin;

	constructor(app: App, plugin: SimplenoteSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName('Account').setHeading();

		new Setting(containerEl)
			.setName('Email')
			.setDesc('Simplenote account email.')
			.addText((t) =>
				t.setValue(s.email).onChange(async (v) => {
					s.email = v.trim();
					await this.plugin.saveSettings();
				}),
			);

		const status = this.plugin.hasToken() ? `Logged in${s.email ? ` as ${s.email}` : ''}` : 'Not logged in';
		new Setting(containerEl)
			.setName('Login status')
			.setDesc(status)
			.addButton((b) =>
				b.setButtonText('Log out').onClick(async () => {
					await this.plugin.logout();
					this.display();
				}),
			);

		let loginCode = '';
		new Setting(containerEl)
			.setName('Log in with an email code')
			.setDesc('Step 1: send a code to the email above. Step 2: enter the code from the email and click "Log in with code". Same flow as the Simplenote website; works on every device.')
			.addButton((b) =>
				b.setButtonText('Send code').onClick(async () => {
					if (!s.email) {
						new Notice('Enter the email first.');
						return;
					}
					b.setDisabled(true);
					try {
						await this.plugin.requestLoginCode(s.email);
						new Notice(`Simplenote: a login code was sent to ${s.email}. Enter it below.`, 8000);
					} catch (e) {
						new Notice(`Simplenote: could not send a code: ${errorMessage(e)}`);
					} finally {
						b.setDisabled(false);
					}
				}),
			)
			.addText((t) =>
				t.setPlaceholder('code from the email').onChange((v) => {
					loginCode = v;
				}),
			)
			.addButton((b) =>
				b
					.setButtonText('Log in with code')
					.setCta()
					.onClick(async () => {
						if (!s.email || !loginCode.trim()) {
							new Notice('Enter the email and the code first.');
							return;
						}
						b.setDisabled(true);
						try {
							await this.plugin.completeLoginCode(s.email, loginCode);
							new Notice('Simplenote: logged in.');
						} catch (e) {
							new Notice(`Simplenote: ${errorMessage(e)}`);
						} finally {
							b.setDisabled(false);
							this.display();
						}
					}),
			);

		new Setting(containerEl).setName('Advanced login').setHeading();

		let pastedToken = '';
		new Setting(containerEl)
			.setName('Paste a token')
			.setDesc('Fallback: a Simperium access token obtained elsewhere (see README). Kept in secret storage.')
			.addText((t) => {
				t.inputEl.type = 'password';
				t.setPlaceholder('access token').onChange((v) => {
					pastedToken = v.trim();
				});
			})
			.addButton((b) =>
				b.setButtonText('Use token').onClick(async () => {
					if (!pastedToken) {
						new Notice('Paste a token first.');
						return;
					}
					b.setDisabled(true);
					try {
						await this.plugin.useToken(pastedToken);
						new Notice('Simplenote: token accepted.');
					} catch (e) {
						new Notice(`Simplenote: token rejected: ${errorMessage(e)}`);
					} finally {
						b.setDisabled(false);
						this.display();
					}
				}),
			);

		new Setting(containerEl).setName('Sync').setHeading();

		new Setting(containerEl)
			.setName('Sync with Simplenote on this device')
			.setDesc('Device-local. Turn off on a device that should only receive changes through the vault sync.')
			.addToggle((t) =>
				t.setValue(this.plugin.deviceSyncEnabled()).onChange((v) => {
					this.plugin.setDeviceSyncEnabled(v);
				}),
			);

		new Setting(containerEl)
			.setName('Shared vault: one device syncs at a time')
			.setDesc(
				`On by default. Keep it on when iCloud or Obsidian Sync shares this vault between devices that all run this plugin; turn it off only if each device has its own separate vault. One device holds a sync lease and syncs the vault in both directions; the others stand by and change nothing, and the vault sync carries the holder's writes to them. The lease moves by itself when the holder stops syncing for 3 minutes. Now: ${this.plugin.leaseInfo()}.`,
			)
			.addToggle((t) =>
				t.setValue(s.sharedVault).onChange(async (v) => {
					s.sharedVault = v;
					await this.plugin.saveSettings();
					this.display();
				}),
			);
		if (s.sharedVault) {
			new Setting(containerEl)
				.setName('Push from this device')
				.setDesc(`This device is "${this.plugin.deviceName()}". Takes the lease over now instead of waiting for the holder to go quiet.`)
				.addButton((b) =>
					b.setButtonText('Take over').onClick(() => {
						void this.plugin.takeOverSync();
					}),
				);
		}

		new Setting(containerEl)
			.setName('Sync interval while active (seconds)')
			.setDesc(`Used for 5 minutes after any change on either side. Minimum ${MIN_SYNC_INTERVAL}. Local edits sync 3 seconds after you stop typing regardless.`)
			.addText((t) =>
				t.setValue(String(s.syncIntervalSeconds)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					if (Number.isFinite(n) && n >= MIN_SYNC_INTERVAL) {
						s.syncIntervalSeconds = n;
						await this.plugin.saveSettings();
						this.plugin.restartTimer();
					}
				}),
			);

		new Setting(containerEl)
			.setName('Sync interval when idle (seconds)')
			.setDesc(`Used when nothing changed for 5 minutes. Minimum ${MIN_SYNC_INTERVAL}.`)
			.addText((t) =>
				t.setValue(String(s.idleIntervalSeconds)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					if (Number.isFinite(n) && n >= MIN_SYNC_INTERVAL) {
						s.idleIntervalSeconds = n;
						await this.plugin.saveSettings();
						this.plugin.restartTimer();
					}
				}),
			);

		new Setting(containerEl)
			.setName('Excluded folders')
			.setDesc('One vault folder path per line. Notes in these folders are never synced.')
			.addTextArea((t) =>
				t.setValue(s.excludedFolders.join('\n')).onChange(async (v) => {
					s.excludedFolders = v
						.split('\n')
						.map((x) => x.trim().replace(/^\/+|\/+$/g, ''))
						.filter((x) => x.length > 0);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Maximum note size (KB)')
			.setDesc('Larger files are not uploaded. Simplenote refuses notes over about 1,000,000 bytes; the default 975 KB stays just under that.')
			.addText((t) =>
				t.setValue(String(s.maxNoteSizeKb)).onChange(async (v) => {
					const n = Number.parseInt(v, 10);
					if (Number.isFinite(n) && n > 0) {
						s.maxNoteSizeKb = n;
						await this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl)
			.setName('Dry-run mode')
			.setDesc('Log what would happen. Change nothing locally or on Simplenote.')
			.addToggle((t) =>
				t.setValue(s.dryRun).onChange(async (v) => {
					s.dryRun = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Debug logging')
			.addToggle((t) =>
				t.setValue(s.debugLogging).onChange(async (v) => {
					s.debugLogging = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Simplenote tags in notes')
			.setDesc('Hashtag line at the end: tags are written as "#tag #other" on the last line of the note. Property: tags go into the tags property at the top. Tags that cannot be hashtags (with spaces or commas) always use the property.')
			.addDropdown((d) =>
				d
					.addOptions({ inline: 'Hashtag line at the end', property: 'Property at the top' })
					.setValue(s.tagStyle)
					.onChange(async (v) => {
						s.tagStyle = v === 'property' ? 'property' : 'inline';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Hide plugin properties')
			.setDesc('Hide simplenote-id, simplenote-title and pinned in the properties view.')
			.addToggle((t) =>
				t.setValue(s.hideProperties).onChange(async (v) => {
					s.hideProperties = v;
					await this.plugin.saveSettings();
					this.plugin.applyPropertyVisibility();
				}),
			);

		new Setting(containerEl)
			.setName('Translate links')
			.setDesc(
				'Push [[wikilinks]] as Simplenote internal links and translate them back on pull. Must be the same on every device.',
			)
			.addToggle((t) =>
				t.setValue(s.translateLinks).onChange(async (v) => {
					s.translateLinks = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName('Advanced').setHeading();

		new Setting(containerEl)
			.setName('App ID')
			.setDesc('Simperium application ID of the Simplenote app.')
			.addText((t) =>
				t.setValue(s.appId).onChange(async (v) => {
					s.appId = v.trim() || DEFAULT_APP_ID;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Public client key of the Simplenote app. Only needed for login.')
			.addText((t) =>
				t.setValue(s.apiKey).onChange(async (v) => {
					s.apiKey = v.trim() || DEFAULT_API_KEY;
					await this.plugin.saveSettings();
				}),
			);
	}
}

export function errorMessage(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
