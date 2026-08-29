import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
	AGENT_PHASE,
	type Attribution,
	type Host,
	type Kind,
	type Mode,
	type Outcome,
	type PhaseExitFields,
	type PhaseName,
	type PhaseRecord,
	type Run,
	type Tokens,
	computeSeams,
	emptySeams,
	emptyTokens,
	phaseByName,
	SCHEMA_VERSION,
} from "./schema.ts";
import { applyNotionalPricing, loadPriceTable, type PriceTable } from "./pricing.ts";
import { applyCraftVersion } from "./version.ts";

/**
 * Grace window for attributing usage that arrives after its phase already closed.
 * Off by default: a host that reports a whole session in one terminal lump (Pi's
 * `agent_end`) would have that lump charged to whichever phase happened to close
 * last, which is worse than leaving it unattributed. Emit per-turn instead. Set
 * this only for hosts that genuinely report small, late increments.
 */
export function backfillWindowMs(): number {
	const raw = Number(process.env.CRAFT_METRICS_BACKFILL_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export function defaultDir(): string {
	return join(homedir(), ".local", "share", "craft-metrics");
}

export function defaultStorePath(): string {
	return join(defaultDir(), "events.jsonl");
}

function sidecarPath(storePath: string): string {
	return join(dirname(storePath), "current.json");
}

function nowIso(): string {
	return new Date().toISOString();
}

function addTokens(a: Tokens, b: Partial<Tokens>): void {
	a.input += b.input ?? 0;
	a.output += b.output ?? 0;
	a.cacheRead += b.cacheRead ?? 0;
	a.cacheWrite += b.cacheWrite ?? 0;
}

export function pushUnique(list: string[], value?: string): void {
	if (!value) return;
	if (!list.includes(value)) list.push(value);
}

export interface UsageEvent {
	at?: string;
	/**
	 * Phase this usage belongs to, stamped by the emitter at the moment the work
	 * *started*. Beats the open phase, which is what the fold would otherwise infer
	 * at the moment the event *arrives*.
	 */
	phase?: PhaseName;
	model?: string;
	provider?: string;
	thinking?: string;
	tokens?: Partial<Tokens>;
	cost_usd?: number;
	turns?: number;
	tool_calls?: number;
	tool_name?: string;
	subagent?: boolean;
	agent?: string;
	quota_error?: boolean;
	timeout?: boolean;
	failover?: boolean;
	/** Authorship signals stripped from a reviewer payload before spawn. */
	blinding_scrubs?: number;
}

type LogEvent =
	| {
			v: 1;
			t: "run_open";
			run_id: string;
			at: string;
			host: Host;
			cwd: string;
			repo?: string;
			mode: Mode;
			kind?: Kind;
			craft_version?: string;
	  }
	| { v: 1; t: "phase_enter"; run_id: string; at: string; phase: PhaseName; agent?: string }
	| { v: 1; t: "phase_exit"; run_id: string; at: string; phase: PhaseName; fields?: PhaseExitFields }
	| { v: 1; t: "usage"; run_id: string; at: string } & UsageEvent
	| { v: 1; t: "hitl_pause"; run_id: string; at: string }
	| { v: 1; t: "hitl_resume"; run_id: string; at: string }
	| { v: 1; t: "verify"; run_id: string; at: string; command: string; exit_code: number; phase: PhaseName | null }
	| { v: 1; t: "mode"; run_id: string; at: string; mode: Mode }
	| { v: 1; t: "kind"; run_id: string; at: string; kind: Kind }
	| {
			v: 1;
			t: "craft_version";
			run_id: string;
			at: string;
			craft_version: string;
			/**
			 * How the version was arrived at. Persisting an inference without this
			 * would launder a guess into a declaration — the tilde in `show` and the
			 * "(n inferred)" in `totals` both depend on the distinction surviving.
			 */
			source?: "declared" | "inferred";
	  }
	| { v: 1; t: "run_end"; run_id: string; at: string; outcome: Outcome };

export class Store {
	path: string;
	/**
	 * Explicit price table wins over the default load from disk. Pass one in tests
	 * so pricing behavior does not depend on what happens to be in this machine's
	 * `~/.pi/agent/models-store.json` — that file is real, host-specific state, and
	 * a test asserting "no price found" would otherwise pass or fail depending on
	 * who runs it and when they last synced their model registry.
	 */
	prices?: PriceTable;
	constructor(path: string = defaultStorePath(), prices?: PriceTable) {
		this.path = path;
		this.prices = prices;
	}

	loadEvents(): LogEvent[] {
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		const events: LogEvent[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			events.push(JSON.parse(line) as LogEvent);
		}
		return events;
	}

	append(event: LogEvent): void {
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, JSON.stringify(event) + "\n");
		if (event.t === "run_open") this.writeSidecar(event.cwd, event.run_id);
		if (event.t === "run_end") this.clearSidecar(event.run_id);
	}

	readSidecar(): Record<string, string> {
		try {
			return JSON.parse(readFileSync(sidecarPath(this.path), "utf8")) as Record<string, string>;
		} catch {
			return {};
		}
	}

	writeSidecar(cwd: string, runId: string): void {
		const map = this.readSidecar();
		map[cwd] = runId;
		writeFileSync(sidecarPath(this.path), JSON.stringify(map));
	}

	clearSidecar(runId: string): void {
		const map = this.readSidecar();
		let changed = false;
		for (const [cwd, id] of Object.entries(map)) {
			if (id === runId) {
				delete map[cwd];
				changed = true;
			}
		}
		if (changed) writeFileSync(sidecarPath(this.path), JSON.stringify(map));
	}

	loadAll(): Run[] {
		const events = this.loadEvents();
		// A run's mode decides where its usage lands — `dag` buckets to `supervisor`
		// rather than `unattributed`. Folding events in order would resolve usage
		// against whatever mode was known at the time, so a `mode` event appended
		// later relabelled the run without moving a cent of its already-folded cost.
		// Resolving the final mode up front makes a correction actually correct.
		const finalMode = finalModes(events);
		const byId = new Map<string, Run>();
		for (const ev of events) fold(byId, ev, finalMode);
		const runs = [...byId.values()];
		// Priced at read time, not folded from events: a price-table correction
		// re-prices every historical run on the next `loadAll`, no migration needed.
		const prices = this.prices ?? loadPriceTable();
		for (const run of runs) {
			applyNotionalPricing(run, prices);
			// Runs recorded before `--craft-version` existed carry no declaration, so
			// their workflow revision is recovered from the agents they spawned.
			applyCraftVersion(run);
		}
		return runs;
	}

	get(runId: string): Run | undefined {
		return this.loadAll().find((r) => r.run_id === runId);
	}

	/**
	 * The phase currently open for a run, without folding the whole log. Called on
	 * every agent turn, so it scans backwards and only parses lines that mention
	 * both the run and a phase transition.
	 */
	openPhase(runId: string): PhaseName | undefined {
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch {
			return undefined;
		}
		const lines = raw.split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i];
			if (!line || !line.includes(runId)) continue;
			if (!line.includes('"phase_enter"') && !line.includes('"phase_exit"') && !line.includes('"run_end"')) {
				continue;
			}
			let ev: LogEvent;
			try {
				ev = JSON.parse(line) as LogEvent;
			} catch {
				continue;
			}
			if (ev.run_id !== runId) continue;
			if (ev.t === "phase_enter") return ev.phase;
			if (ev.t === "phase_exit" || ev.t === "run_end") return undefined;
		}
		return undefined;
	}

	openRun(opts: {
		run_id?: string;
		host: Host;
		cwd: string;
		repo?: string;
		mode: Mode;
		kind?: Kind;
		craft_version?: string;
		at?: string;
	}): Run {
		const existing = opts.run_id ? this.get(opts.run_id) : this.latestOpenForCwd(opts.cwd);
		if (existing) {
			if (opts.kind && !existing.kind) this.setKind(existing.run_id, opts.kind, opts.at);
			// The pi extension opens a run from the prompt before the skill reaches its
			// own `start`, so the declared version arrives second and must be backfilled
			// or every run silently falls back to inference.
			//
			// The test is whether a version was *declared*, not whether one is present:
			// `existing` has already been through the classifier, so an inferred value
			// would otherwise look like a declaration and block the real one.
			if (opts.craft_version && existing.craft_version_source !== "declared") {
				this.setCraftVersion(existing.run_id, opts.craft_version, "declared", opts.at);
			}
			return this.get(existing.run_id) ?? existing;
		}
		const run_id = opts.run_id ?? randomUUID();
		this.append({
			v: SCHEMA_VERSION,
			t: "run_open",
			run_id,
			at: opts.at ?? nowIso(),
			host: opts.host,
			cwd: opts.cwd,
			repo: opts.repo,
			mode: opts.mode,
			kind: opts.kind,
			craft_version: opts.craft_version,
		});
		return this.require(run_id);
	}

	enterPhase(runId: string, phase: PhaseName, opts: { agent?: string; at?: string } = {}): Run {
		const run = this.require(runId);
		if (run.mode === "lite" && (phase === "counsel" || phase === "T")) {
			throw new Error(
				`refusing phase_enter: run ${runId} is mode=lite, which forbids phase=${phase}. ` +
					`craft-lite skips counsel and T entirely — do not spawn craft-plan-*/craft-security-review agents under this protocol.`,
			);
		}
		this.append({
			v: SCHEMA_VERSION,
			t: "phase_enter",
			run_id: runId,
			at: opts.at ?? nowIso(),
			phase,
			agent: opts.agent,
		});
		return this.get(runId) ?? this.missing(runId);
	}

	/**
	 * Record the result of the repo's declared verification command. This is the
	 * ground truth a reviewer's `pass` verdict is checked against — a phase report
	 * asserting "tests pass" is a claim, this is an exit code.
	 */
	recordVerify(runId: string, command: string, exitCode: number, at?: string): Run {
		const run = this.require(runId);
		this.append({
			v: SCHEMA_VERSION,
			t: "verify",
			run_id: runId,
			at: at ?? nowIso(),
			command,
			exit_code: exitCode,
			phase: run.open_phase,
		});
		return this.require(runId);
	}

	exitPhase(runId: string, phase: PhaseName, fields: PhaseExitFields = {}, at?: string): Run {
		const run = this.require(runId);
		const verdict = fields.verdict?.toLowerCase();
		if (phase === "A" && verdict === "pass" && run.last_verify && run.last_verify.exit_code !== 0) {
			throw new Error(
				`refusing phase_exit: A cannot report verdict=pass while verification is red. ` +
					`\`${run.last_verify.command}\` exited ${run.last_verify.exit_code}. ` +
					`Fix the tree and re-run verify, or exit A with verdict=fail.`,
			);
		}
		this.append({
			v: SCHEMA_VERSION,
			t: "phase_exit",
			run_id: runId,
			at: at ?? nowIso(),
			phase,
			fields,
		});
		return this.get(runId) ?? this.missing(runId);
	}

	recordUsage(runId: string, event: UsageEvent, fold = true): Run | undefined {
		this.append({
			v: SCHEMA_VERSION,
			t: "usage",
			run_id: runId,
			at: event.at ?? nowIso(),
			...event,
		});
		if (!fold) return undefined;
		return this.get(runId) ?? this.missing(runId);
	}

	endRun(runId: string, outcome: Outcome, at?: string): Run {
		this.append({
			v: SCHEMA_VERSION,
			t: "run_end",
			run_id: runId,
			at: at ?? nowIso(),
			outcome: outcome === "open" ? "completed" : outcome,
		});
		return this.get(runId) ?? this.missing(runId);
	}

	pauseHitl(runId: string, at?: string): Run {
		this.append({ v: SCHEMA_VERSION, t: "hitl_pause", run_id: runId, at: at ?? nowIso() });
		return this.get(runId) ?? this.missing(runId);
	}

	resumeHitl(runId: string, at?: string): Run {
		this.append({ v: SCHEMA_VERSION, t: "hitl_resume", run_id: runId, at: at ?? nowIso() });
		return this.get(runId) ?? this.missing(runId);
	}

	setMode(runId: string, mode: Mode): Run {
		this.append({
			v: SCHEMA_VERSION,
			t: "mode",
			run_id: runId,
			at: nowIso(),
			mode,
		});
		return this.get(runId) ?? this.missing(runId);
	}

	setKind(runId: string, kind: Kind, at?: string): Run {
		this.append({
			v: SCHEMA_VERSION,
			t: "kind",
			run_id: runId,
			at: at ?? nowIso(),
			kind,
		});
		return this.get(runId) ?? this.missing(runId);
	}

	setCraftVersion(
		runId: string,
		craft_version: string,
		source: "declared" | "inferred" = "declared",
		at?: string,
	): Run {
		this.append({
			v: SCHEMA_VERSION,
			t: "craft_version",
			run_id: runId,
			at: at ?? nowIso(),
			craft_version,
			source,
		});
		return this.get(runId) ?? this.missing(runId);
	}

	latestOpenForCwd(cwd: string): Run | undefined {
		const id = this.readSidecar()[cwd];
		if (id) {
			const run = this.get(id);
			if (run && run.outcome === "open") return run;
		}
		return this.loadAll()
			.filter((r) => r.cwd === cwd && r.outcome === "open")
			.at(-1);
	}

	require(runId: string): Run {
		return this.get(runId) ?? this.missing(runId);
	}

	missing(runId: string): never {
		throw new Error(`unknown run ${runId}`);
	}
}

/**
 * Each run's mode as of the end of the log, rather than as of the event being
 * folded. Mode decides where usage lands, so resolving it up front is what lets
 * a later `mode` correction move cost that was already recorded.
 */
function finalModes(events: LogEvent[]): Map<string, Mode> {
	const modes = new Map<string, Mode>();
	for (const ev of events) {
		if (ev.t === "run_open" || ev.t === "mode") modes.set(ev.run_id, ev.mode);
	}
	return modes;
}

function fold(byId: Map<string, Run>, ev: LogEvent, finalMode?: Map<string, Mode>): void {
	if (ev.t === "run_open") {
		if (byId.has(ev.run_id)) return;
		byId.set(ev.run_id, {
			schema_version: SCHEMA_VERSION,
			run_id: ev.run_id,
			started_at: ev.at,
			ended_at: null,
			host: ev.host,
			cwd: ev.cwd,
			repo: ev.repo,
			// The run's eventual mode, not the one declared at open. See `finalModes`.
			mode: finalMode?.get(ev.run_id) ?? ev.mode,
			kind: ev.kind,
			craft_version: ev.craft_version,
			craft_version_source: ev.craft_version ? "declared" : undefined,
			outcome: "open",
			open_phase: null,
			phase_entries: 0,
			last_closed_phase: null,
			last_closed_at: null,
			phases: [],
			seams: emptySeams(),
			hitl: { pause_ms: 0 },
			last_verify: null,
			verify_count: 0,
		});
		return;
	}
	const run = byId.get(ev.run_id);
	if (!run) return;

	switch (ev.t) {
		case "phase_enter": {
			if (run.open_phase && run.open_phase !== ev.phase) closePhase(run, run.open_phase, ev.at);
			const p = phaseByName(run, ev.phase);
			if (!p.started_at) p.started_at = ev.at;
			p.ended_at = null;
			pushUnique(p.agents, ev.agent);
			if (ev.agent) p.agent = ev.agent;
			p.cycles = (p.cycles ?? 0) + 1;
			run.open_phase = ev.phase;
			run.phase_entries += 1;
			run.seams = computeSeams(run);
			return;
		}
		case "phase_exit": {
			const p = closePhase(run, ev.phase, ev.at);
			// Accumulate before assigning: `Object.assign` overwrites, so a phase that
			// failed, was fixed, and passed would otherwise fold to a clean pass and
			// erase every finding that caused the loop.
			if (ev.fields?.blocking_findings) {
				p.blocking_findings_total = (p.blocking_findings_total ?? 0) + ev.fields.blocking_findings;
			}
			if (ev.fields) Object.assign(p, stripUndefined(normalizeFields(ev.fields)));
			if (run.open_phase === ev.phase) run.open_phase = null;
			run.seams = computeSeams(run);
			return;
		}
		case "usage": {
			const { phase, how } = resolvePhase(run, ev);
			applyUsage(phase, ev, how);
			run.seams = computeSeams(run);
			return;
		}
		case "verify": {
			run.last_verify = { command: ev.command, exit_code: ev.exit_code, at: ev.at, phase: ev.phase };
			run.verify_count += 1;
			const target = ev.phase ?? run.open_phase;
			if (target) {
				const p = phaseByName(run, target);
				p.verify_runs += 1;
				if (ev.exit_code !== 0) p.verify_failures += 1;
			}
			return;
		}
		case "hitl_pause":
			run.hitl.paused_at = ev.at;
			run.outcome = "hitl-paused";
			return;
		case "hitl_resume":
			run.hitl.resumed_at = ev.at;
			if (run.hitl.paused_at) {
				run.hitl.pause_ms += Date.parse(ev.at) - Date.parse(run.hitl.paused_at);
			}
			if (run.outcome === "hitl-paused") run.outcome = "open";
			return;
		case "mode":
			run.mode = ev.mode;
			return;
		case "kind":
			run.kind = ev.kind;
			return;
		case "craft_version":
			run.craft_version = ev.craft_version;
			run.craft_version_source = ev.source ?? "declared";
			return;
		case "run_end":
			if (run.open_phase) closePhase(run, run.open_phase, ev.at);
			run.ended_at = ev.at;
			run.outcome = ev.outcome === "open" ? "completed" : ev.outcome;
			run.open_phase = null;
			run.seams = computeSeams(run);
			return;
	}
}

function closePhase(run: Run, phase: PhaseName, at: string): PhaseRecord {
	const p = phaseByName(run, phase);
	if (!p.started_at) p.started_at = at;
	p.ended_at = at;
	p.duration_ms = Math.max(0, Date.parse(at) - Date.parse(p.started_at));
	run.last_closed_phase = phase;
	run.last_closed_at = at;
	return p;
}

/**
 * Where a usage event lands, in descending order of trust:
 *   1. the emitter's own stamp — it knew which phase the work started under
 *   2. the phase open right now
 *   3. a named craft-* agent whose phase is fixed by protocol
 *   4. the phase that just closed, if a grace window is configured (off by default)
 *   5. nowhere — unattributed, and never folded into a real phase
 */
function resolvePhase(run: Run, ev: UsageEvent): { phase: PhaseRecord; how: Attribution } {
	if (ev.phase && ev.phase !== "unattributed") {
		return { phase: phaseByName(run, ev.phase), how: "stamped" };
	}
	if (run.open_phase) return { phase: phaseByName(run, run.open_phase), how: "open-phase" };
	if (ev.agent && AGENT_PHASE[ev.agent]) {
		return { phase: phaseByName(run, AGENT_PHASE[ev.agent]), how: "agent-map" };
	}
	const window = backfillWindowMs();
	if (window > 0 && run.last_closed_phase && run.last_closed_at && ev.at) {
		const lag = Date.parse(ev.at) - Date.parse(run.last_closed_at);
		if (lag >= 0 && lag <= window) {
			return { phase: phaseByName(run, run.last_closed_phase), how: "backfilled" };
		}
	}
	// A supervisor session legitimately has no phases — orchestration *is* its work.
	// Bucket it as `supervisor` so DAG overhead is measurable against node cost,
	// rather than orphaned into `unattributed` where it looks like a collection bug.
	if (run.mode === "dag") return { phase: phaseByName(run, "supervisor"), how: "open-phase" };
	return { phase: phaseByName(run, "unattributed"), how: "none" };
}

function applyUsage(phase: PhaseRecord, event: UsageEvent, how: Attribution = "none"): void {
	pushUnique(phase.agents, event.agent);
	if (event.agent && !phase.agent) phase.agent = event.agent;
	pushUnique(phase.models, event.model);
	if (event.model) phase.model = event.model;
	if (event.provider) phase.provider = event.provider;
	if (event.thinking) phase.thinking = event.thinking;
	if (event.tokens) addTokens(phase.tokens, event.tokens);
	const cost = event.cost_usd ?? 0;
	phase.cost_usd += cost;
	phase.attribution[how] += 1;
	if (how === "backfilled") phase.backfilled_cost_usd += cost;
	if (event.model) {
		const m = (phase.by_model[event.model] ??= {
			provider: event.provider,
			turns: 0,
			events: 0,
			cost_usd: 0,
			tokens: emptyTokens(),
		});
		m.events += 1;
		m.turns += event.turns ?? 0;
		m.cost_usd += cost;
		if (event.tokens) addTokens(m.tokens, event.tokens);
	}
	if (event.subagent) {
		phase.child_cost_usd += cost;
		if (event.turns || event.cost_usd || event.tokens) phase.subagent_count += 1;
	} else {
		phase.conductor_cost_usd += cost;
	}
	phase.turns += event.turns ?? 0;
	if (event.tool_name) {
		phase.tool_calls += 1;
		phase.tool_calls_by_name[event.tool_name] = (phase.tool_calls_by_name[event.tool_name] ?? 0) + 1;
	} else {
		phase.tool_calls += event.tool_calls ?? 0;
	}
	if (event.quota_error) phase.quota_errors += 1;
	if (event.timeout) phase.timeouts += 1;
	if (event.failover) phase.failovers += 1;
	phase.blinding_scrubs += event.blinding_scrubs ?? 0;
}

/** Free-text status fields arrive with inconsistent casing; fold them to one form. */
function normalizeFields(fields: PhaseExitFields): Record<string, unknown> {
	const out: Record<string, unknown> = { ...fields };
	for (const key of ["afk_hitl_status", "counsel_status", "t_status", "verdict", "criteria_provenance"]) {
		const v = out[key];
		if (typeof v === "string") out[key] = v.toLowerCase();
	}
	return out;
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (v !== undefined) out[k] = v;
	}
	return out;
}

export function summarize(runs: Run[]): string {
	if (runs.length === 0) return "no craft runs recorded";
	const lines: string[] = [];
	for (const run of runs) {
		const totalCost = run.phases.reduce((s, p) => s + p.cost_usd, 0);
		const totalNotional = run.notional_cost_usd ?? totalCost;
		const totalMs = run.phases.reduce((s, p) => s + p.duration_ms, 0);
		const runNotional = totalNotional > totalCost ? `  (notional $${totalNotional.toFixed(4)})` : "";
		// `~` marks an inferred version: recovered from the run's shape, not declared.
		const ver = run.craft_version
			? `  v${run.craft_version}${run.craft_version_source === "inferred" ? "~" : ""}`
			: "  v?";
		lines.push(
			`${run.run_id.slice(0, 8)}${ver}  ${(run.kind ?? "?").padEnd(8)}  ${run.mode.padEnd(5)}  ${run.outcome.padEnd(12)}  $${totalCost.toFixed(4)}${runNotional}  ${(totalMs / 1000).toFixed(1)}s  ${run.host}  ${run.repo ?? run.cwd}`,
		);
		for (const p of run.phases) {
			if (p.name === "unattributed" && p.cost_usd === 0 && p.duration_ms === 0 && p.tool_calls === 0) continue;
			const model = p.model ?? p.models[0] ?? "-";
			const guessed = p.backfilled_cost_usd > 0 ? `  (backfilled $${p.backfilled_cost_usd.toFixed(4)})` : "";
			const blinded = p.blinding_scrubs > 0 ? `  (blinded ${p.blinding_scrubs})` : "";
			// A phase entered more than once argued with the next one. Only the final
			// verdict survives the fold, so without this the loop is invisible.
			const looped =
				(p.cycles ?? 0) > 1
					? `  (${p.cycles} cycles, ${p.blocking_findings_total ?? 0} findings total)`
					: "";
			// Tokens, not just dollars: a subscription-billed phase reports $0 and would
			// otherwise read as no work at all. Notional is what closes that gap.
			const tok = totalTokens(p.tokens);
			const notional = p.notional_cost_usd ?? p.cost_usd;
			const spend =
				p.cost_usd > 0
					? `$${p.cost_usd.toFixed(4)}`
					: tok > 0
						? notional > 0
							? `$0 (~$${notional.toFixed(4)})`
							: "$    n/a"
						: "$0.0000";
			lines.push(
				`  ${p.name.padEnd(13)}  ${spend}  ${(p.duration_ms / 1000).toFixed(1)}s  ${p.turns}t ${p.tool_calls}tools  ${fmtTokens(p.tokens)}  ${model}${guessed}${blinded}${looped}`,
			);
		}
		// A `dag` supervisor has no phases by design — orchestration is its work — so
		// flagging it here would contradict `diagnose`, which already exempts it.
		if (run.phase_entries === 0 && run.mode !== "dag") {
			lines.push("  ! ungated — run started but no phase was ever entered");
		}
		if (run.last_verify) {
			const v = run.last_verify;
			const mark = v.exit_code === 0 ? "green" : `RED (exit ${v.exit_code})`;
			lines.push(`  verify ${mark}  \`${v.command}\`  ×${run.verify_count}`);
		}
		const render = run.phases.find((p) => p.name === "R");
		if (render?.decisions) {
			const dev = render.plan_deviations ?? 0;
			lines.push(`  decisions ${render.decisions}${dev > 0 ? `, ${dev} deviating from plan` : ""}`);
		}
		// Absent means mutation was skipped, which is not the same as a clean sweep —
		// so this line appears only when something was actually measured.
		if (render?.mutants_tested !== undefined) {
			const survived = render.mutants_survived ?? 0;
			lines.push(`  mutants ${render.mutants_tested - survived}/${render.mutants_tested} killed, ${survived} to adjudicate`);
		}
		const s = run.seams;
		lines.push(
			`  seams  counsel≠C=${fmtSeam(s.counsel_family_differs_from_c)}  A≠R=${fmtSeam(s.a_family_differs_from_r)}  T≠R=${fmtSeam(s.t_family_differs_from_r)}`,
		);
	}
	return lines.join("\n");
}

export function fmtSeam(v: boolean | null): string {
	if (v === null) return "?";
	return v ? "yes" : "NO";
}

export interface Complaint {
	kind: "ungated" | "stale-open" | "costless-model" | "unattributed" | "unverified-pass" | "fix-without-findings";
	run_id?: string;
	detail: string;
	cost_usd: number;
}

/**
 * Data-quality problems that make the numbers lie. Cheap to run, and the only
 * thing standing between a silent collection bug and six days of bad metrics.
 */
export function diagnose(runs: Run[], now = Date.now(), staleHours = 12): Complaint[] {
	const out: Complaint[] = [];
	let unattributed = 0;
	let total = 0;
	const costless = new Map<string, { events: number; tokens: number }>();

	for (const run of runs) {
		const runCost = run.phases.reduce((s, p) => s + p.cost_usd, 0);
		total += runCost;
		const un = run.phases.find((p) => p.name === "unattributed");
		unattributed += un?.cost_usd ?? 0;

		// `dag` runs have no phases by design; only a CRAFTS run is expected to gate.
		if (run.phase_entries === 0 && run.mode !== "dag") {
			out.push({
				kind: "ungated",
				run_id: run.run_id,
				detail: `${run.repo ?? run.cwd}: started ${run.started_at}, no phase ever entered`,
				cost_usd: runCost,
			});
		}
		// Fix exists to resolve blockers. Entering it when Assess and Tighten both
		// passed means the phase sequence is being emitted mechanically rather than
		// followed, and the work it does is unbudgeted by definition.
		const fix = run.phases.find((p) => p.name === "F");
		if (fix?.started_at) {
			const assess = run.phases.find((p) => p.name === "A");
			const tighten = run.phases.find((p) => p.name === "T");
			const blockers =
				(assess?.blocking_findings_total ?? 0) > 0 ||
				(tighten?.p0_count ?? 0) > 0 ||
				assess?.verdict === "fail" ||
				tighten?.t_status === "fail";
			if (!blockers) {
				out.push({
					kind: "fix-without-findings",
					run_id: run.run_id,
					detail: `${run.repo ?? run.cwd}: F ran with no blocking finding from A or T`,
					cost_usd: fix.notional_cost_usd ?? fix.cost_usd,
				});
			}
		}
		// A red tree is blocked at the gate; a tree nobody checked is not, so it is
		// the case that needs surfacing.
		const assess = run.phases.find((p) => p.name === "A");
		if (assess?.verdict === "pass" && run.verify_count === 0) {
			out.push({
				kind: "unverified-pass",
				run_id: run.run_id,
				detail: `${run.repo ?? run.cwd}: A passed with no verify command ever recorded`,
				cost_usd: runCost,
			});
		}
		if (run.outcome === "open") {
			const ageH = (now - Date.parse(run.started_at)) / 3.6e6;
			if (ageH > staleHours) {
				out.push({
					kind: "stale-open",
					run_id: run.run_id,
					detail: `${run.repo ?? run.cwd}: open for ${ageH.toFixed(1)}h with no run_end`,
					cost_usd: runCost,
				});
			}
		}
		for (const p of run.phases) {
			for (const [model, spend] of Object.entries(p.by_model)) {
				const spent = totalTokens(spend.tokens);
				// A model that burned tokens but reported $0 has no price table entry
				// either — actually unpriced, not just subscription-billed. This is the
				// case notional pricing cannot paper over.
				if (spend.cost_usd === 0 && spent > 0 && (spend.notional_cost_usd ?? 0) === 0) {
					const cur = costless.get(model) ?? { events: 0, tokens: 0 };
					cur.events += 1;
					cur.tokens += spent;
					costless.set(model, cur);
				}
			}
		}
	}

	for (const [model, s] of costless) {
		out.push({
			kind: "costless-model",
			detail: `${model}: ${s.events} phases, ${(s.tokens / 1e6).toFixed(1)}M tokens, no price found — add it to the price table`,
			cost_usd: 0,
		});
	}
	if (total > 0 && unattributed > 0) {
		out.push({
			kind: "unattributed",
			detail: `$${unattributed.toFixed(2)} of $${total.toFixed(2)} (${((100 * unattributed) / total).toFixed(0)}%) landed outside any phase`,
			cost_usd: unattributed,
		});
	}
	return out.sort((a, b) => b.cost_usd - a.cost_usd);
}

export interface PhaseTotal {
	cost: number;
	/** List-price value of the phase's tokens. See `ModelSpend.notional_cost_usd`. */
	notional: number;
	ms: number;
	n: number;
	turns: number;
	tokens: Tokens;
}

/**
 * Phase totals split by workflow revision. Averaging a phase across versions
 * describes a workflow that never existed — the counsel phase, for instance, was a
 * three-agent panel in v3 and one reviewer in v4, and a blended figure is neither.
 */
export function phaseTotalsByVersion(runs: Run[]): Map<string, Map<PhaseName, PhaseTotal>> {
	const byVersion = new Map<string, Run[]>();
	for (const run of runs) {
		const key = run.craft_version ?? "unknown";
		const list = byVersion.get(key) ?? [];
		list.push(run);
		byVersion.set(key, list);
	}
	const out = new Map<string, Map<PhaseName, PhaseTotal>>();
	for (const [version, list] of [...byVersion.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
		out.set(version, phaseTotals(list));
	}
	return out;
}

export function phaseTotals(runs: Run[]): Map<PhaseName, PhaseTotal> {
	const map = new Map<PhaseName, PhaseTotal>();
	for (const run of runs) {
		for (const p of run.phases) {
			const cur = map.get(p.name) ?? { cost: 0, notional: 0, ms: 0, n: 0, turns: 0, tokens: emptyTokens() };
			cur.cost += p.cost_usd;
			cur.notional += p.notional_cost_usd ?? p.cost_usd;
			cur.ms += p.duration_ms;
			cur.turns += p.turns;
			addTokens(cur.tokens, p.tokens);
			if (p.started_at) cur.n += 1;
			map.set(p.name, cur);
		}
	}
	return map;
}

/**
 * Work grouped by model. The only honest cross-model comparison: subscription-billed
 * models (Codex) report real token counts but $0, so a cost-only view makes them look
 * free and silently understates whichever phases they ran.
 */
export interface ModelTotal {
	model: string;
	provider?: string;
	events: number;
	turns: number;
	cost: number;
	/** List-price value of this model's tokens. See `ModelSpend.notional_cost_usd`. */
	notional: number;
	tokens: Tokens;
	/** True when this model burned tokens without ever reporting a price. */
	costless: boolean;
	/** True when notional could not be priced either — no entry in the price table. */
	unpriced: boolean;
}

export function modelTotals(runs: Run[]): ModelTotal[] {
	const map = new Map<string, ModelTotal>();
	for (const run of runs) {
		for (const p of run.phases) {
			for (const [model, spend] of Object.entries(p.by_model)) {
				const cur = map.get(model) ?? {
					model,
					provider: spend.provider,
					events: 0,
					turns: 0,
					cost: 0,
					notional: 0,
					tokens: emptyTokens(),
					costless: false,
					unpriced: false,
				};
				cur.events += spend.events;
				cur.turns += spend.turns;
				cur.cost += spend.cost_usd;
				cur.notional += spend.notional_cost_usd ?? spend.cost_usd;
				addTokens(cur.tokens, spend.tokens);
				map.set(model, cur);
			}
		}
	}
	for (const m of map.values()) {
		m.costless = m.cost === 0 && totalTokens(m.tokens) > 0;
		// Notional fell back to actual (both zero) despite real token volume: the
		// price table has no entry for this model, not just a $0 subscription.
		m.unpriced = m.costless && m.notional === 0;
	}
	return [...map.values()].sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens));
}

export function totalTokens(t: Tokens): number {
	return t.input + t.output + t.cacheRead + t.cacheWrite;
}

function short(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
	return String(n);
}

export function fmtTokens(t: Tokens): string {
	if (totalTokens(t) === 0) return "-";
	return `${short(t.input)}in/${short(t.output)}out/${short(t.cacheRead)}cache`;
}
