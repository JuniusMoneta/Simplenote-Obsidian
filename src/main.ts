import { Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, SimplenoteSettingTab, SimplenoteSyncSettings } from './settings';

const TOKEN_SECRET_ID = 'simplenote-sync-token';
const LS_DEVICE_SYNC = 'simplenote-sync:device-sync-enabled';

export default class SimplenoteSyncPlugin extends Plugin {
	settings!: SimplenoteSyncSettings;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new SimplenoteSettingTab(this.app, this));
	}

	onunload(): void {}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<SimplenoteSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	hasToken(): boolean {
		return !!this.app.secretStorage.getSecret(TOKEN_SECRET_ID);
	}

	async login(_email: string, _password: string): Promise<void> {
		throw new Error('not implemented yet (M1)');
	}

	async logout(): Promise<void> {
		this.app.secretStorage.setSecret(TOKEN_SECRET_ID, '');
	}

	deviceSyncEnabled(): boolean {
		const v = this.app.loadLocalStorage(LS_DEVICE_SYNC) as boolean | null;
		return v === null ? true : v;
	}

	setDeviceSyncEnabled(v: boolean): void {
		this.app.saveLocalStorage(LS_DEVICE_SYNC, v);
	}

	restartTimer(): void {}
}
