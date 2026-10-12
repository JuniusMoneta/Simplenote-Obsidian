import { Notice, Platform, Plugin, TAbstractFile, TFile, debounce } from 'obsidian';
import { obsidianHttp } from './http';
import { Logger } from './log';
import { ObsidianVault } from './obsidian-vault';
import { DEFAULT_SETTINGS, errorMessage, MIN_SYNC_INTERVAL, SimplenoteSettingTab, SimplenoteSyncSettings } from './settings';
import { SimperiumClient, type HttpFn } from './simperium';
import { normalizeState, type StateStore, type SyncState } from './state';
import { SyncEngine, type SyncStatus } from './sync';
import { confirmPlan, ExcludedModal, firstRunDialog, LogModal } from './ui';
import { LinkTranslatorImpl } from './links';

const TOKEN_SECRET_ID = 'simplenote-sync-token';
const LS_DEVICE_SYNC = 'simplenote-sync:device-sync-enabled';
const LS_STATE = 'simplenote-sync:state';
const LS_LOG = 'simplenote-sync:log';
const FILE_EVENT_DEBOUNCE_MS = 3000;

class LocalStorageStateStore implements StateStore {
	constructor(private readonly plugin: Plugin) {}
	load(): SyncState {
		return normalizeState(this.plugin.app.loadLocalStorage(LS_STATE));
	}
	save(state: SyncState): void {
		this.plugin.app.saveLocalStorage(LS_STATE, state);
	}
}

export default class SimplenoteSyncPlugin extends Plugin {
	settings!: SimplenoteSyncSettings;
	log!: Logger;
	client!: SimperiumClient;
	engine!: SyncEngine;
	vaultAdapter!: ObsidianVault;
	private statusEl: HTMLElement | null = null;
	private timer: number | null = null;
	private statusTimer: number | null = null;
	private lastStatus: SyncStatus = { kind: 'idle', at: 0, problems: 0 };
	private readonly dirtyPaths = new Set<string>();

	async onload(): Promise<void> {
		await this.loadSettings();
		const persistLog = debounce((lines: string[]) => this.app.saveLocalStorage(LS_LOG, lines.slice(-500)), 2000, true);
		const stored = this.app.loadLocalStorage(LS_LOG) as unknown;
		this.log = new Logger(
			{
				isDebug: () => this.settings.debugLogging,
				onChange: persistLog,
				mirror: (level, line) => {
					if (level === 'error') console.error(`[simplenote-sync] ${line}`);
				},
			},
			Array.isArray(stored) ? stored.filter((l): l is string => typeof l === 'string') : [],
		);
		this.client = this.newClient();
		this.vaultAdapter = new ObsidianVault(this.app, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		const translator = new LinkTranslatorImpl(this.app, () => this.engine.knownNotes(), (path) => this.isExcluded(path));
		this.engine = new SyncEngine({
			vault: this.vaultAdapter,
			client: this.client,
			store: new LocalStorageStateStore(this),
			log: this.log,
			settings: () => ({
				excludedFolders: this.settings.excludedFolders,
				maxNoteSizeKb: this.settings.maxNoteSizeKb,
				dryRun: this.settings.dryRun,
				translateLinks: this.settings.translateLinks,
			}),
			confirmPlan: (summary) => confirmPlan(this.app, summary),
			firstRun: (proposal, excluded) => firstRunDialog(this.app, proposal, excluded),
			notice: (msg) => {
				new Notice(msg, 10_000);
			},
			onStatus: (s) => this.renderStatus(s),
			translator,
		});

		this.addSettingTab(new SimplenoteSettingTab(this.app, this));
		this.applyPropertyVisibility();
		this.addRibbonIcon('refresh-cw', 'Simplenote: sync now', () => {
			void this.syncNow('ribbon');
		});
		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass('simplenote-sync-status');
			this.statusEl.onClickEvent(() => {
				if (this.engine.problems().length > 0) this.openProblems();
				else void this.syncNow('status bar');
			});
		}
		this.renderStatus({ kind: 'idle', at: this.engine.lastSyncAt(), problems: this.engine.problems().length });
		this.statusTimer = this.registerIntervalSafe(() => this.renderStatus(this.lastStatus), 30_000);

		this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.syncNow('command') });
		this.addCommand({
			id: 'pause-resume',
			name: 'Pause / resume sync',
			callback: () => {
				if (this.engine.paused) {
					this.engine.resume();
					new Notice('Simplenote sync resumed.');
					void this.syncNow('resume');
				} else {
					this.engine.pause('paused by user');
					new Notice('Simplenote sync paused.');
				}
			},
		});
		this.addCommand({ id: 'full-reconcile', name: 'Full reconcile', callback: () => void this.syncNow('full reconcile', true) });
		this.addCommand({ id: 'open-log', name: 'Open sync log', callback: () => new LogModal(this.app, () => this.log.getLines()).open() });
		this.addCommand({ id: 'log-out', name: 'Log out', callback: () => void this.logout() });
		this.addCommand({ id: 'list-excluded', name: 'List excluded and failing files', callback: () => this.openProblems() });

		// file events (debounced per file, ignoring the plugin's own writes)
		const kick = debounce(() => void this.syncNow('file changes'), FILE_EVENT_DEBOUNCE_MS, true);
		const onFile = (f: TAbstractFile, oldPath?: string): void => {
			if (!(f instanceof TFile) || f.extension !== 'md') return;
			if (this.vaultAdapter.wasWrittenByPlugin(f.path) || (oldPath && this.vaultAdapter.wasWrittenByPlugin(oldPath))) return;
			this.dirtyPaths.add(f.path);
			kick();
		};
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on('modify', (f) => onFile(f)));
			this.registerEvent(this.app.vault.on('create', (f) => onFile(f)));
			this.registerEvent(this.app.vault.on('delete', (f) => onFile(f)));
			this.registerEvent(this.app.vault.on('rename', (f, old) => onFile(f, old)));
			this.restartTimer();
			void this.syncNow('plugin load');
		});
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'visible') void this.syncNow('app resumed');
		});
	}

	onunload(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		document.body.removeClass('simplenote-sync-hide-props');
	}

	applyPropertyVisibility(): void {
		document.body.toggleClass('simplenote-sync-hide-props', this.settings.hideProperties);
	}

	private registerIntervalSafe(fn: () => void, ms: number): number {
		const id = window.setInterval(fn, ms);
		this.registerInterval(id);
		return id;
	}

	// ----- settings -----

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<SimplenoteSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		if (this.settings.syncIntervalSeconds < MIN_SYNC_INTERVAL) this.settings.syncIntervalSeconds = MIN_SYNC_INTERVAL;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	isExcluded(path: string): boolean {
		const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
		if (!path.endsWith('.md') || path.endsWith('.excalidraw.md')) return true;
		if (folder.split('/').some((s) => s.startsWith('.'))) return true;
		const fk = folder.toLocaleLowerCase('en-US');
		return this.settings.excludedFolders.some((ex) => {
			const ek = ex.toLocaleLowerCase('en-US');
			return fk === ek || fk.startsWith(`${ek}/`);
		});
	}

	// ----- account -----

	newClient(maxRetries?: number, http: HttpFn = obsidianHttp): SimperiumClient {
		return new SimperiumClient({
			appId: this.settings.appId,
			apiKey: this.settings.apiKey,
			http,
			token: this.app.secretStorage.getSecret(TOKEN_SECRET_ID) ?? undefined,
			log: (m) => this.log.debug(`http: ${m}`),
			maxRetries,
		});
	}

	hasToken(): boolean {
		return !!this.app.secretStorage.getSecret(TOKEN_SECRET_ID);
	}

	/** Email-code login, step 1. Goes to app.simplenote.com, which Chromium can reach (unlike auth.simperium.com). */
	async requestLoginCode(email: string): Promise<void> {
		this.log.info(`login: requesting an email code for ${email}`);
		await this.newClient(0).requestLoginCode(email);
		this.log.info('login: code requested; check the mailbox');
	}

	/** Email-code login, step 2. */
	async completeLoginCode(email: string, code: string): Promise<void> {
		this.log.info('login: exchanging the email code for a token');
		const probe = this.newClient(0);
		const token = await probe.completeLoginCode(email, code);
		this.app.secretStorage.setSecret(TOKEN_SECRET_ID, token);
		this.client.setToken(token);
		this.log.info(`logged in as ${email} (email code)`);
		if (this.engine.status.kind === 'error') this.engine.resume();
		void this.syncNow('login');
	}

	/** Accepts a token obtained outside Obsidian; verifies it with one index request on api.simperium.com. */
	async useToken(token: string): Promise<void> {
		this.log.info('login: verifying a pasted token against api.simperium.com');
		const probe = this.newClient(0);
		probe.setToken(token);
		await probe.indexPage({ limit: 1, data: false });
		this.app.secretStorage.setSecret(TOKEN_SECRET_ID, token);
		this.client.setToken(token);
		this.log.info('login: pasted token verified and stored');
		if (this.engine.status.kind === 'error') this.engine.resume();
		void this.syncNow('login');
	}

	async logout(): Promise<void> {
		this.app.secretStorage.setSecret(TOKEN_SECRET_ID, '');
		this.client.setToken(undefined);
		this.log.info('logged out');
		this.renderStatus({ kind: 'error', message: 'Not logged in' });
		await Promise.resolve();
	}

	// ----- device-local toggle -----

	deviceSyncEnabled(): boolean {
		const v = this.app.loadLocalStorage(LS_DEVICE_SYNC) as boolean | null;
		return v === null ? true : v;
	}

	setDeviceSyncEnabled(v: boolean): void {
		this.app.saveLocalStorage(LS_DEVICE_SYNC, v);
		this.log.info(`sync on this device ${v ? 'enabled' : 'disabled'}`);
		if (v) void this.syncNow('device sync enabled');
		else this.renderStatus({ kind: 'paused', reason: 'disabled on this device' });
	}

	// ----- sync -----

	restartTimer(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		const ms = Math.max(MIN_SYNC_INTERVAL, this.settings.syncIntervalSeconds) * 1000;
		this.timer = this.registerIntervalSafe(() => void this.syncNow('timer'), ms);
	}

	async syncNow(reason: string, full = false): Promise<void> {
		if (!this.deviceSyncEnabled()) return;
		if (!this.hasToken()) {
			this.renderStatus({ kind: 'error', message: 'Not logged in' });
			if (reason === 'command' || reason === 'ribbon' || reason === 'status bar') {
				new Notice('Simplenote: not logged in. Opening the plugin settings…', 5000);
				this.openSettings();
			}
			return;
		}
		this.dirtyPaths.clear();
		try {
			const r = await this.engine.sync({ full, reason });
			if (r.errors.length > 0 && (reason === 'command' || reason === 'ribbon')) new Notice(`Simplenote: ${r.errors.length} error(s). See the sync log.`);
		} catch (e) {
			this.log.error(`sync crashed: ${errorMessage(e)}`);
			new Notice(`Simplenote sync error: ${errorMessage(e)}`);
		}
	}

	openProblems(): void {
		new ExcludedModal(
			this.app,
			() => this.engine.excludedFiles(),
			() => this.engine.problems(),
		).open();
	}

	/** Opens this plugin's settings tab (app.setting is not in the public typings but is stable). */
	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		if (!setting) return;
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	private renderStatus(s: SyncStatus): void {
		this.lastStatus = s;
		if (!this.statusEl) return;
		let text: string;
		this.statusEl.removeClass('simplenote-sync-status-error');
		switch (s.kind) {
			case 'syncing':
				text = 'Simplenote: syncing…';
				break;
			case 'paused':
				text = 'Simplenote: paused';
				break;
			case 'error':
				text = `Simplenote: error (${s.message})`;
				this.statusEl.addClass('simplenote-sync-status-error');
				break;
			default:
				text = s.at > 0 ? `Simplenote: synced ${ago(Date.now() - s.at)}` : 'Simplenote: not synced yet';
				if (s.problems > 0) {
					text += ` · ${s.problems} not syncing`;
					this.statusEl.addClass('simplenote-sync-status-error');
				}
		}
		if (this.settings.dryRun) text += ' [dry-run]';
		this.statusEl.setText(text);
	}
}

function ago(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return 'just now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}
