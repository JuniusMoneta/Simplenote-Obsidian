import { Logger } from '../src/log';
import { SimperiumClient } from '../src/simperium';
import { MemoryStateStore } from '../src/state';
import { SyncEngine, type EngineDeps, type EngineSettings, type PlanSummary } from '../src/sync';
import type { FirstRunDecision, FirstRunProposal } from '../src/firstrun';
import { FakeSimperium, type FakeOptions } from './fake-simperium';
import { MemoryVault } from './memory-vault';

export interface Harness {
	server: FakeSimperium;
	vault: MemoryVault;
	client: SimperiumClient;
	engine: SyncEngine;
	store: MemoryStateStore;
	log: Logger;
	settings: EngineSettings;
	clock: { now: number };
	confirmations: PlanSummary[];
	firstRunProposals: FirstRunProposal[];
	/** Override to simulate the owner's answers. */
	answers: { confirmPlan: boolean; firstRun: ((p: FirstRunProposal) => FirstRunDecision | null) | null };
	notices: string[];
	excluded: string[];
	advance(ms: number): void;
	newDevice(): Promise<Harness>;
}

export async function makeHarness(opts: { fake?: FakeOptions; settings?: Partial<EngineSettings>; server?: FakeSimperium; vault?: MemoryVault; clock?: { now: number } } = {}): Promise<Harness> {
	const server = opts.server ?? new FakeSimperium(opts.fake);
	if (!server.users.has('u')) server.addUser('u', 'p');
	const clock = opts.clock ?? { now: 1_800_000_000_000 };
	const vault = opts.vault ?? new MemoryVault(() => clock.now);
	const client = new SimperiumClient({ appId: 'chalk-bump-f49', apiKey: 'c8c2b86337154cdabc989b23e30c6bf4', http: server.http, sleep: () => Promise.resolve(), minIntervalMs: 0, now: () => clock.now });
	await client.authorize('u', 'p');
	const store = new MemoryStateStore();
	const log = new Logger({ isDebug: () => true, now: () => clock.now });
	const settings: EngineSettings = { excludedFolders: [], maxNoteSizeKb: 200, dryRun: false, translateLinks: false, tagStyle: 'property', ...opts.settings };
	const h = {
		server,
		vault,
		client,
		store,
		log,
		settings,
		clock,
		confirmations: [] as PlanSummary[],
		firstRunProposals: [] as FirstRunProposal[],
		answers: { confirmPlan: true, firstRun: null as Harness['answers']['firstRun'] },
		notices: [] as string[],
		excluded: [] as string[],
	};
	const deps: EngineDeps = {
		vault,
		client,
		store,
		log,
		settings: () => settings,
		now: () => clock.now,
		confirmPlan: (s) => {
			h.confirmations.push(s);
			return Promise.resolve(h.answers.confirmPlan);
		},
		firstRun: (p, excluded) => {
			h.firstRunProposals.push(p);
			h.excluded.push(...excluded.map((e) => e.path));
			if (h.answers.firstRun) return Promise.resolve(h.answers.firstRun(p));
			return Promise.resolve({ confirmedProbable: new Set(p.matches.filter((m) => m.method === 'probable').map((m) => m.remote.id)), applyTitleFixes: true, importUnmatched: true, uploadUnmatched: true });
		},
		notice: (m) => {
			h.notices.push(m);
		},
	};
	const engine = new SyncEngine(deps);
	const harness: Harness = {
		...h,
		engine,
		advance(ms: number) {
			clock.now += ms;
		},
		newDevice: () => makeHarness({ server, vault, clock, settings: opts.settings }),
	};
	return harness;
}

export function logText(h: Harness): string {
	return h.log.getLines().join('\n');
}
