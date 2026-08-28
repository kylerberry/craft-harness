export const SCHEMA_VERSION = 1 as const;

export type Host = "pi" | "claude-code" | "unknown";
/**
 * `dag` is not a CRAFTS protocol — it is the `/execute-dag` supervisor session.
 * It dispatches conductors and merges their work; each node opens its own run.
 * It therefore never enters a CRAFTS phase, and its orchestration cost would
 * otherwise be orphaned into `unattributed` by construction.
 */
export type Mode = "full" | "hitl" | "lite" | "dag";
export type Kind = "feature" | "bugfix" | "refactor" | "scaffold" | "docs" | "chore";
export type Outcome = "open" | "completed" | "aborted" | "blocked" | "hitl-paused";

export const KINDS: Kind[] = ["feature", "bugfix", "refactor", "scaffold", "docs", "chore"];
export type PhaseName = "C" | "counsel" | "R" | "A" | "F" | "T" | "S" | "supervisor" | "unattributed";

export const PHASES: PhaseName[] = ["C", "counsel", "R", "A", "F", "T", "S", "supervisor", "unattributed"];

export const AGENT_PHASE: Record<string, PhaseName> = {
	"craft-planner": "C",
	"craft-counsel": "counsel",
	"craft-builder": "R",
	"craft-code-simplifier": "R",
	"craft-evaluator": "A",
	"craft-security-review": "T",
};

export interface Tokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** How a usage event ended up on the phase it landed on. */
export type Attribution = "stamped" | "open-phase" | "agent-map" | "backfilled" | "none";

/** What one model spent inside one phase. */
export interface ModelSpend {
	provider?: string;
	turns: number;
	events: number;
	cost_usd: number;
	/**
	 * Tokens priced at list rate regardless of billing — set by `applyNotionalPricing`
	 * at read time, not folded from events. Undefined until that pass runs, e.g. on a
	 * `PhaseRecord` built directly in a test rather than via `Store.loadAll()`.
	 */
	notional_cost_usd?: number;
	tokens: Tokens;
}

export interface PhaseRecord {
	name: PhaseName;
	started_at: string | null;
	ended_at: string | null;
	duration_ms: number;
	agent?: string;
	agents: string[];
	model?: string;
	models: string[];
	provider?: string;
	thinking?: string;
	tokens: Tokens;
	cost_usd: number;
	/** See `ModelSpend.notional_cost_usd` — same derivation, summed across models. */
	notional_cost_usd?: number;
	turns: number;
	/**
	 * Per-model split of the phase's spend. A phase routinely runs more than one model
	 * (conductor plus subagents), so phase-level `model` alone cannot carry the tokens
	 * back to whoever burned them.
	 */
	by_model: Record<string, ModelSpend>;
	tool_calls: number;
	tool_calls_by_name: Record<string, number>;
	subagent_count: number;
	conductor_cost_usd: number;
	child_cost_usd: number;
	/** Cost that landed here via the grace-window guess, not a stamp or an open phase. */
	backfilled_cost_usd: number;
	/** Count of usage events per attribution route, so a phase's provenance is auditable. */
	attribution: Record<Attribution, number>;
	quota_errors: number;
	timeouts: number;
	failovers: number;
	/** Authorship signals stripped from a reviewer payload before it was spawned. */
	blinding_scrubs: number;
	/** Verify commands run while this phase was open, and how many came back red. */
	verify_runs: number;
	verify_failures: number;
	security_triggers?: string[];
	blocking_questions?: number;
	afk_hitl_status?: string;
	criteria_provenance?: string;
	counsel_status?: string;
	blocking_findings?: number;
	probe_required?: boolean;
	verdict?: string;
	cycles?: number;
	t_status?: string;
	p0_count?: number;
	non_p0_count?: number;
	docs_touched?: number;
	/**
	 * Implementation choices Render made that the plan did not dictate, and how many
	 * of those departed from it. A deviation is not a defect — it is the subset A
	 * must judge hardest, since a diff alone cannot distinguish a considered choice
	 * from a shortcut.
	 */
	decisions?: number;
	plan_deviations?: number;
	/**
	 * Mutation testing over Render's diff. `mutants_survived` is the count a
	 * reviewer must adjudicate; watching it against A's turn count is how we
	 * learn whether this replaced a reading pass or merely added a step.
	 */
	mutants_tested?: number;
	mutants_survived?: number;
}

export interface Seams {
	counsel_family_differs_from_c: boolean | null;
	a_family_differs_from_r: boolean | null;
	t_family_differs_from_r: boolean | null;
}

export interface Hitl {
	paused_at?: string;
	resumed_at?: string;
	pause_ms: number;
}

/**
 * Result of the repo's declared verification command. Ground truth about whether
 * the tree is green — as opposed to a phase report claiming it is.
 */
export interface Verify {
	command: string;
	exit_code: number;
	at: string;
	phase: PhaseName | null;
}

export interface Run {
	schema_version: typeof SCHEMA_VERSION;
	run_id: string;
	started_at: string;
	ended_at: string | null;
	host: Host;
	cwd: string;
	repo?: string;
	mode: Mode;
	kind?: Kind;
	/**
	 * Which CRAFTS revision produced this run. Declared at `start` where available;
	 * otherwise inferred from the run's shape. Never compare phase costs across
	 * versions without saying so — the workflow being measured is what changed.
	 */
	craft_version?: string;
	craft_version_source?: "declared" | "inferred" | "unknown";
	outcome: Outcome;
	open_phase: PhaseName | null;
	/** Number of phase_enter events seen. Zero means the run was started but never gated. */
	phase_entries: number;
	/** Last phase to close, and when — the anchor for grace-window backfill. */
	last_closed_phase: PhaseName | null;
	last_closed_at: string | null;
	phases: PhaseRecord[];
	seams: Seams;
	hitl: Hitl;
	/** Most recent verify result. The gate on A's `pass` verdict reads this. */
	last_verify: Verify | null;
	verify_count: number;
	/** Sum of phase notional costs. See `ModelSpend.notional_cost_usd`. */
	notional_cost_usd?: number;
}

export interface PhaseExitFields {
	security_triggers?: string[];
	blocking_questions?: number;
	afk_hitl_status?: string;
	criteria_provenance?: string;
	counsel_status?: string;
	blocking_findings?: number;
	probe_required?: boolean;
	verdict?: string;
	t_status?: string;
	p0_count?: number;
	non_p0_count?: number;
	docs_touched?: number;
	/**
	 * Implementation choices Render made that the plan did not dictate, and how many
	 * of those departed from it. A deviation is not a defect — it is the subset A
	 * must judge hardest, since a diff alone cannot distinguish a considered choice
	 * from a shortcut.
	 */
	decisions?: number;
	plan_deviations?: number;
	/**
	 * Mutation testing over Render's diff. `mutants_survived` is the count a
	 * reviewer must adjudicate; watching it against A's turn count is how we
	 * learn whether this replaced a reading pass or merely added a step.
	 */
	mutants_tested?: number;
	mutants_survived?: number;
}

export function emptyTokens(): Tokens {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function emptyPhase(name: PhaseName): PhaseRecord {
	return {
		name,
		started_at: null,
		ended_at: null,
		duration_ms: 0,
		agents: [],
		models: [],
		tokens: emptyTokens(),
		cost_usd: 0,
		turns: 0,
		by_model: {},
		tool_calls: 0,
		tool_calls_by_name: {},
		subagent_count: 0,
		conductor_cost_usd: 0,
		child_cost_usd: 0,
		backfilled_cost_usd: 0,
		attribution: { stamped: 0, "open-phase": 0, "agent-map": 0, backfilled: 0, none: 0 },
		quota_errors: 0,
		timeouts: 0,
		failovers: 0,
		blinding_scrubs: 0,
		verify_runs: 0,
		verify_failures: 0,
	};
}

export function emptySeams(): Seams {
	return {
		counsel_family_differs_from_c: null,
		a_family_differs_from_r: null,
		t_family_differs_from_r: null,
	};
}

export function modelFamily(model?: string): string | null {
	if (!model) return null;
	const i = model.indexOf("/");
	return i === -1 ? model : model.slice(0, i);
}

export function familiesDiffer(a?: string[], b?: string[]): boolean | null {
	const af = new Set((a ?? []).map((m) => modelFamily(m)).filter((x): x is string => !!x));
	const bf = new Set((b ?? []).map((m) => modelFamily(m)).filter((x): x is string => !!x));
	if (af.size === 0 || bf.size === 0) return null;
	for (const f of bf) if (!af.has(f)) return true;
	return false;
}

export function computeSeams(run: Run): Seams {
	const byName = new Map(run.phases.map((p) => [p.name, p]));
	const c = byName.get("C");
	const counsel = byName.get("counsel");
	const r = byName.get("R");
	const a = byName.get("A");
	const t = byName.get("T");
	return {
		counsel_family_differs_from_c: familiesDiffer(c?.models, counsel?.models),
		a_family_differs_from_r: familiesDiffer(r?.models, a?.models),
		t_family_differs_from_r: familiesDiffer(r?.models, t?.models),
	};
}

export function phaseByName(run: Run, name: PhaseName): PhaseRecord {
	let p = run.phases.find((x) => x.name === name);
	if (!p) {
		p = emptyPhase(name);
		run.phases.push(p);
	}
	return p;
}
