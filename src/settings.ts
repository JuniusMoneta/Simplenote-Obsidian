import { App, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type SimplenoteSyncPlugin from './main';

/** Settings stored in data.json (shared between devices through the vault). */
export interface SimplenoteSyncSettings {
	email: string;
	syncIntervalSeconds: number;
	excludedFolders: string[];
	maxNoteSizeKb: number;
	dryRun: boolean;
	debugLogging: boolean;
	translateLinks: boolean;
	appId: string;
	apiKey: string;
}

export const DEFAULT_APP_ID = 'chalk-bump-f49';
/** Public client key of the official Simplenote apps (see NOTES.md). */
export const DEFAULT_API_KEY = 'c8c2b86337154cdabc989b23e30c6bf4';

export const DEFAULT_SETTINGS: SimplenoteSyncSettings = {
	email: '',
	syncIntervalSeconds: 30,
	excludedFolders: [],
	maxNoteSizeKb: 200,
	dryRun: false,
	debugLogging: false,
	translateLinks: false,
	appId: DEFAULT_APP_ID,
	apiKey: DEFAULT_API_KEY,
};

export const MIN_SYNC_INTERVAL = 30;

export class SimplenoteSettingTab extends PluginSettingTab {
	plugin: SimplenoteSyncPlugin;
	private password = '';

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

		const pw = new Setting(containerEl)
			.setName('Password')
			.setDesc('Used once to get a token. The password is not stored.');
		const secret = new SecretComponent(this.app, pw.controlEl);
		secret.onChange((v) => {
			this.password = v ?? '';
		});

		const status = this.plugin.hasToken() ? `Logged in${s.email ? ` as ${s.email}` : ''}` : 'Not logged in';
		new Setting(containerEl)
			.setName('Login status')
			.setDesc(status)
			.addButton((b) =>
				b
					.setButtonText('Log in')
					.setCta()
					.onClick(async () => {
						if (!s.email || !this.password) {
							new Notice('Enter email and password first.');
							return;
						}
						b.setDisabled(true);
						try {
							await this.plugin.login(s.email, this.password);
							this.password = '';
							new Notice('Simplenote: logged in.');
						} catch (e) {
							new Notice(`Simplenote login failed: ${errorMessage(e)}`);
						} finally {
							b.setDisabled(false);
							this.display();
						}
					}),
			)
			.addButton((b) =>
				b.setButtonText('Log out').onClick(async () => {
					await this.plugin.logout();
					this.display();
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
			.setName('Sync interval (seconds)')
			.setDesc(`Minimum ${MIN_SYNC_INTERVAL}.`)
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
			.setDesc('Larger files are skipped and logged.')
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
