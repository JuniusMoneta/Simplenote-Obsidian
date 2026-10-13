import { Notice, Platform, Plugin, TAbstractFile, TFile, debounce } from 'obsidian';
import { obsidianHttp } from './http';
import { Logger } from './log';
import { ObsidianVault } from './obsidian-vault';
import { ACTIVE_WINDOW_MS, DEFAULT_SETTINGS, errorMessage, MIN_SYNC_INTERVAL, SimplenoteSettingTab, SimplenoteSyncSettings } from './settings';
import { SimperiumClient, type HttpFn } from './simperium';
import { normalizeState, type StateStore, type SyncState } from './state';
import { SyncEngine, type SyncStatus } from './sync';
import { confirmPlan, ExcludedModal, firstRunDialog, LogModal } from './ui';
import { LinkTranslatorImpl } from './links';
import { LEASE_TTL_MS, PushLease } from './lease';

/** Secret storage is shared by all vaults on a device: the token id carries the vault id so that two vaults can use two accounts. */
const TOKEN_SECRET_PREFIX = 'simplenote-sync-token';
const LEGACY_TOKEN_SECRET_ID = 'simplenote-sync-token';
const LS_DEVICE_SYNC = 'simplenote-sync:device-sync-enabled';
const LS_STATE = 'simplenote-sync:state';
const LS_DEVICE_ID = 'simplenote-sync:device-id';
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
	/** Last time something changed on either side; drives the active/idle polling interval. */
	private lastActivity = 0;
	private lastTimerSync = 0;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.migrateTokenSecret();
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
		const lease = new PushLease({ client: this.client, deviceId: this.deviceId(), deviceName: this.deviceName(), now: () => Date.now(), log: (m) => this.log.info(m) });
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
				tagStyle: this.settings.tagStyle,
				sharedVault: this.settings.sharedVault,
			}),
			confirmPlan: (summary) => confirmPlan(this.app, summary),
			firstRun: (proposal, excluded) => firstRunDialog(this.app, proposal, excluded),
			notice: (msg) => {
				new Notice(msg, 10_000);
			},
			onStatus: (s) => this.renderStatus(s),
			translator,
			lease,
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
		this.addCommand({ id: 'cleanup-duplicates', name: 'Clean up duplicate copies of notes', callback: () => void this.cleanupDuplicates() });
		this.addCommand({ id: 'take-over-sync', name: 'Take over sync on this device (shared vault)', callback: () => void this.takeOverSync() });

		// file events (debounced per file, ignoring the plugin's own writes)
		const kick = debounce(() => void this.syncNow('file changes'), FILE_EVENT_DEBOUNCE_MS, true);
		const onFile = (f: TAbstractFile, oldPath?: string): void => {
			if (!(f instanceof TFile) || f.extension !== 'md') return;
			if (this.vaultAdapter.wasWrittenByPlugin(f.path) || (oldPath && this.vaultAdapter.wasWrittenByPlugin(oldPath))) return;
			this.dirtyPaths.add(f.path);
			this.lastActivity = Date.now();
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
			if (document.visibilityState === 'visible') {
				this.lastActivity = Date.now();
				void this.syncNow('app resumed');
			}
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
		if (this.settings.idleIntervalSeconds < MIN_SYNC_INTERVAL) this.settings.idleIntervalSeconds = MIN_SYNC_INTERVAL;
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

	/** Secret id of this vault's token. Obsidian's secret storage is device-wide, so the id carries the vault id. */
	private tokenSecretId(): string {
		const raw = (this.app as unknown as { appId?: string }).appId ?? this.app.vault.getName();
		const vaultKey = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vault';
		return `${TOKEN_SECRET_PREFIX}-${vaultKey}`;
	}

	/**
	 * Versions up to 0.4.1 stored the token under one id for all vaults, so two vaults on one device synced
	 * the same account. The first vault to load takes the old token over; other vaults ask for a new login.
	 */
	private migrateTokenSecret(): void {
		const legacy = this.app.secretStorage.getSecret(LEGACY_TOKEN_SECRET_ID);
		if (!legacy) return;
		if (!this.app.secretStorage.getSecret(this.tokenSecretId())) this.app.secretStorage.setSecret(this.tokenSecretId(), legacy);
		this.app.secretStorage.setSecret(LEGACY_TOKEN_SECRET_ID, '');
	}

	private storedToken(): string | undefined {
		return this.app.secretStorage.getSecret(this.tokenSecretId()) ?? undefined;
	}

	newClient(maxRetries?: number, http: HttpFn = obsidianHttp): SimperiumClient {
		return new SimperiumClient({
			appId: this.settings.appId,
			apiKey: this.settings.apiKey,
			http,
			token: this.storedToken(),
			log: (m) => this.log.debug(`http: ${m}`),
			maxRetries,
		});
	}

	hasToken(): boolean {
		return !!this.storedToken();
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
		this.app.secretStorage.setSecret(this.tokenSecretId(), token);
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
		this.app.secretStorage.setSecret(this.tokenSecretId(), token);
		this.client.setToken(token);
		this.log.info('login: pasted token verified and stored');
		if (this.engine.status.kind === 'error') this.engine.resume();
		void this.syncNow('login');
	}

	async logout(): Promise<void> {
		this.app.secretStorage.setSecret(this.tokenSecretId(), '');
		this.client.setToken(undefined);
		this.log.info('logged out');
		this.renderStatus({ kind: 'error', message: 'Not logged in' });
		await Promise.resolve();
	}

	// ----- device identity and push lease -----

	/** Random id of this device, kept in local storage (never in the vault). */
	deviceId(): string {
		const stored = this.app.loadLocalStorage(LS_DEVICE_ID) as string | null;
		if (typeof stored === 'string' && /^[a-z0-9]{8,}$/.test(stored)) return stored;
		const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
		this.app.saveLocalStorage(LS_DEVICE_ID, id);
		return id;
	}

	deviceName(): string {
		const kind = Platform.isIosApp ? 'iPhone/iPad' : Platform.isAndroidApp ? 'Android' : Platform.isMacOS ? 'Mac' : Platform.isWin ? 'Windows' : Platform.isLinux ? 'Linux' : 'Device';
		return `${kind} ${this.deviceId().slice(0, 4)}`;
	}

	/** One line for the settings page: who holds the push lease. */
	leaseInfo(): string {
		if (!this.settings.sharedVault) return 'off';
		const d = this.engine.pullOnly;
		if (d) return `${d} pushes, this device pulls only`;
		return this.engine.lastSyncAt() > 0 ? 'this device pushes' : 'decided on the next sync';
	}

	async takeOverSync(): Promise<void> {
		if (!this.settings.sharedVault) {
			new Notice('Simplenote: turn on "Shared vault" in the settings first.');
			return;
		}
		this.engine.takeOver();
		new Notice(`Simplenote: taking the push lease over for ${this.deviceName()}. Other devices notice within ${Math.round(LEASE_TTL_MS / 60_000)} minutes.`);
		await this.syncNow('take over');
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

	/**
	 * Adaptive polling: the timer ticks at the active interval; when nothing changed on either side
	 * for ACTIVE_WINDOW_MS, syncs only happen every idle interval.
	 */
	restartTimer(): void {
		if (this.timer !== null) window.clearInterval(this.timer);
		const active = Math.max(MIN_SYNC_INTERVAL, this.settings.syncIntervalSeconds) * 1000;
		this.timer = this.registerIntervalSafe(() => {
			const now = Date.now();
			const idle = now - this.lastActivity > ACTIVE_WINDOW_MS;
			const due = idle ? Math.max(active, this.settings.idleIntervalSeconds * 1000) : active;
			if (now - this.lastTimerSync < due - 500) return;
			this.lastTimerSync = now;
			void this.syncNow(idle ? 'timer (idle)' : 'timer');
		}, active);
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
			if (r.pulled + r.pushed + r.trashed > 0) this.lastActivity = Date.now();
			if (r.errors.length > 0 && (reason === 'command' || reason === 'ribbon')) new Notice(`Simplenote: ${r.errors.length} error(s). See the sync log.`);
		} catch (e) {
			this.log.error(`sync crashed: ${errorMessage(e)}`);
			new Notice(`Simplenote sync error: ${errorMessage(e)}`);
		}
	}

	async cleanupDuplicates(): Promise<void> {
		if (!this.hasToken()) {
			new Notice('Simplenote: not logged in.');
			return;
		}
		new Notice('Simplenote: looking for duplicate copies…');
		try {
			const r = await this.engine.cleanupDuplicates();
			const parts = [`${r.trashed.length} copy/copies moved to the Obsidian trash`];
			if (r.notesTrashed > 0) parts.push(`${r.notesTrashed} duplicate note(s) moved to the Simplenote trash`);
			if (r.skipped.length > 0) parts.push(`${r.skipped.length} copy/copies with different text left alone (see the sync log)`);
			new Notice(`Simplenote${r.dryRun ? ' [dry-run]' : ''}: ${parts.join('; ')}.`, 12_000);
			if (r.trashed.length > 0 && !r.dryRun) void this.syncNow('duplicate cleanup');
		} catch (e) {
			this.log.error(`duplicate cleanup failed: ${errorMessage(e)}`);
			new Notice(`Simplenote: cleanup failed: ${errorMessage(e)}`);
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
				if (s.pullOnly) text += ` · standby (${s.pullOnly} syncs)`;
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
