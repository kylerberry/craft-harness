#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Store,
	defaultStorePath,
	diagnose,
	modelTotals,
	summarize,
	phaseTotals,
	phaseTotalsByVersion,
	type PhaseTotal,
} from "./store.ts";
import { KINDS, PHASES, type Host, type Kind, type Mode, type Outcome, type PhaseName } from "./schema.ts";
import type { PriceTable } from "./pricing.ts";

/**
 * Everything the CLI touches outside itself. Injected rather than reached for so
 * the command surface can be tested at all: a parser that calls `process.exit`
 * on bad input takes the test runner down with it, which is why none of this was
 * covered before.
 */
export interface Io {
	write(s: string): void;
	error(s: string): void;
	cwd(): string;
	now(): number;
	storePath(): string;
	prices?: PriceTable;
}

/** Thrown by `fail` to unwind out of a nested parser. Caught in `run`. */
export class ExitSignal extends Error {
	// Declared and assigned explicitly: parameter properties are a TypeScript
	// transform, and this runs under node's strip-only type removal.
	code: number;
	constructor(code: number) {
		super(`exit ${code}`);
		this.code = code;
	}
}

export const defaultIo: Io = {
	write: (s) => process.stdout.write(s),
	error: (s) => console.error(s),
	cwd: () => process.cwd(),
	now: () => Date.now(),
	storePath: () => process.env.CRAFT_METRICS_PATH ?? defaultStorePath(),
};

function fail(io: Io, message: string, code = 2): never {
	io.error(message);
	throw new ExitSignal(code);
}

const USAGE = `craft-metrics — phase-grained CRAFT run collector

Usage:
  craft-metrics start  --kind feature|bugfix|refactor|scaffold|docs|chore [--run ID] --mode full|hitl|lite|dag [--host pi|claude-code] [--cwd PATH] [--repo NAME] [--craft-version V]
  craft-metrics enter  --run ID --phase C|counsel|R|A|F|T|S [--agent NAME]
  craft-metrics exit   --run ID --phase PHASE [--verdict V] [--blocking-findings N] [--p0 N] [--non-p0 N]
                       [--security-triggers a,b] [--counsel-status S] [--t-status S] [--docs-touched N]
                       [--blocking-questions N] [--afk-hitl-status S] [--criteria-provenance S] [--probe-required]
                       [--decisions N] [--plan-deviations N]
                       [--mutants-tested N] [--mutants-survived N]
  craft-metrics usage  --run ID [--phase P] [--model M] [--provider P] [--cost N] [--input N] [--output N]
                       [--cache-read N] [--cache-write N] [--turns N] [--tool NAME] [--agent NAME]
                       [--subagent] [--quota-error] [--timeout] [--failover] [--blinding-scrubs N]
  craft-metrics verify --run ID --command "npm test" --exit-code N
  craft-metrics pause  --run ID
  craft-metrics resume --run ID
  craft-metrics mode   --run ID --mode MODE
  craft-metrics kind   --run ID --kind KIND
  craft-metrics end    --run ID [--outcome completed|aborted|blocked|hitl-paused]
  craft-metrics current [--cwd PATH]
  craft-metrics show    [--run ID] [--last N]
  craft-metrics totals
  craft-metrics models                     per-model turns and tokens
  craft-metrics doctor  [--stale-hours N]   report data-quality problems
  craft-metrics pin-versions [--apply]      persist inferred workflow versions

Env: CRAFT_METRICS_PATH        override store (default ~/.local/share/craft-metrics/events.jsonl)
     CRAFT_METRICS_BACKFILL_MS attribute late usage to the phase that just closed,
                               within this window. Off by default — see store.ts.
`;

function arg(flag: string, argv: string[]): string | undefined {
	const i = argv.indexOf(flag);
	if (i === -1) return undefined;
	return argv[i + 1];
}

function has(flag: string, argv: string[]): boolean {
	return argv.includes(flag);
}

function num(flag: string, argv: string[]): number | undefined {
	const v = arg(flag, argv);
	return v === undefined ? undefined : Number(v);
}

/** Token counts are only ever read at a glance; six significant digits are noise. */
export function mtok(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`.padStart(6);
	if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`.padStart(6);
	return String(n).padStart(6);
}

function requireArg(flag: string, argv: string[], io: Io): string {
	const v = arg(flag, argv);
	if (!v) fail(io, `missing ${flag}`);
	return v;
}

function parsePhase(argv: string[], io: Io): PhaseName {
	const p = requireArg("--phase", argv, io);
	// `unattributed` and `supervisor` are derived buckets, not gates a caller enters.
	if (!PHASES.includes(p as PhaseName) || p === "unattributed") fail(io, `invalid --phase ${p}`);
	return p as PhaseName;
}

function parseKind(argv: string[], io: Io): Kind {
	const k = requireArg("--kind", argv, io);
	if (!KINDS.includes(k as Kind)) fail(io, `invalid --kind ${k} (use ${KINDS.join("|")})`);
	return k as Kind;
}

function parseMode(argv: string[], io: Io): Mode {
	const m = requireArg("--mode", argv, io);
	if (m !== "full" && m !== "hitl" && m !== "lite" && m !== "dag") {
		fail(io, `invalid --mode ${m} (use full, hitl, lite, or dag)`);
	}
	return m;
}

export function main(argv: string[], io: Io = defaultIo): number {
	const cmd = argv[0];
	if (!cmd || cmd === "-h" || cmd === "--help") {
		io.write(USAGE);
		return 0;
	}
	const rest = argv.slice(1);
	const store = new Store(io.storePath(), io.prices);

	switch (cmd) {
		case "start": {
			const run = store.openRun({
				run_id: arg("--run", rest),
				host: (arg("--host", rest) as Host | undefined) ?? "unknown",
				cwd: arg("--cwd", rest) ?? io.cwd(),
				repo: arg("--repo", rest) ?? basename(arg("--cwd", rest) ?? io.cwd()),
				mode: parseMode(rest, io),
				kind: parseKind(rest, io),
				craft_version: arg("--craft-version", rest),
			});
			io.write(run.run_id + "\n");
			return 0;
		}
		case "enter": {
			const run = store.enterPhase(requireArg("--run", rest, io), parsePhase(rest, io), {
				agent: arg("--agent", rest),
			});
			io.write(run.run_id + "\n");
			return 0;
		}
		case "exit": {
			const run = store.exitPhase(requireArg("--run", rest, io), parsePhase(rest, io), {
				security_triggers: arg("--security-triggers", rest)?.split(",").filter(Boolean),
				blocking_questions: num("--blocking-questions", rest),
				afk_hitl_status: arg("--afk-hitl-status", rest),
				criteria_provenance: arg("--criteria-provenance", rest),
				counsel_status: arg("--counsel-status", rest),
				blocking_findings: num("--blocking-findings", rest),
				probe_required: has("--probe-required", rest) ? true : undefined,
				verdict: arg("--verdict", rest),
				t_status: arg("--t-status", rest),
				p0_count: num("--p0", rest),
				non_p0_count: num("--non-p0", rest),
				docs_touched: num("--docs-touched", rest),
				decisions: num("--decisions", rest),
				plan_deviations: num("--plan-deviations", rest),
				mutants_tested: num("--mutants-tested", rest),
				mutants_survived: num("--mutants-survived", rest),
			});
			io.write(run.run_id + "\n");
			return 0;
		}
		case "usage": {
			const run = store.recordUsage(requireArg("--run", rest, io), {
				phase: has("--phase", rest) ? parsePhase(rest, io) : undefined,
				model: arg("--model", rest),
				provider: arg("--provider", rest),
				thinking: arg("--thinking", rest),
				tokens: {
					input: num("--input", rest) ?? 0,
					output: num("--output", rest) ?? 0,
					cacheRead: num("--cache-read", rest) ?? 0,
					cacheWrite: num("--cache-write", rest) ?? 0,
				},
				cost_usd: num("--cost", rest),
				turns: num("--turns", rest),
				tool_name: arg("--tool", rest),
				agent: arg("--agent", rest),
				subagent: has("--subagent", rest),
				quota_error: has("--quota-error", rest),
				timeout: has("--timeout", rest),
				failover: has("--failover", rest),
				blinding_scrubs: num("--blinding-scrubs", rest),
			});
			io.write(run.run_id + "\n");
			return 0;
		}
		case "verify": {
			const code = num("--exit-code", rest);
			if (code === undefined || Number.isNaN(code)) fail(io, "missing or invalid --exit-code");
			const run = store.recordVerify(requireArg("--run", rest, io), requireArg("--command", rest, io), code);
			io.write(run.run_id + "\n");
			return 0;
		}
		case "pause":
			store.pauseHitl(requireArg("--run", rest, io));
			return 0;
		case "resume":
			store.resumeHitl(requireArg("--run", rest, io));
			return 0;
		case "mode":
			store.setMode(requireArg("--run", rest, io), parseMode(rest, io));
			return 0;
		case "kind":
			store.setKind(requireArg("--run", rest, io), parseKind(rest, io));
			return 0;
		case "end": {
			const outcome = (arg("--outcome", rest) as Outcome | undefined) ?? "completed";
			store.endRun(requireArg("--run", rest, io), outcome);
			return 0;
		}
		case "current": {
			const cwd = arg("--cwd", rest) ?? io.cwd();
			const run = store.latestOpenForCwd(cwd);
			if (!run) return 1;
			io.write(run.run_id + "\n");
			return 0;
		}
		case "show": {
			const id = arg("--run", rest);
			const last = num("--last", rest);
			let runs = store.loadAll();
			if (id) runs = runs.filter((r) => r.run_id === id || r.run_id.startsWith(id));
			if (last) runs = runs.slice(-last);
			io.write(summarize(runs) + "\n");
			return 0;
		}
		case "pin-versions": {
			// Inference is recomputed on every read, so a classifier change silently
			// re-dates historical runs. Pinning freezes what the classifier concluded
			// today. The stored event keeps `source: inferred`, so a pinned guess is
			// never mistaken for something the skill declared.
			const runs = store.loadAll();
			const target = runs.filter((r) => r.craft_version && r.craft_version_source === "inferred");
			if (target.length === 0) {
				io.write("nothing to pin — no run carries an inferred version\n");
				return 0;
			}
			const apply = has("--apply", rest);
			for (const r of target) {
				io.write(`${r.run_id.slice(0, 8)}  v${r.craft_version}  ${r.repo ?? r.cwd}\n`);
				if (apply) store.setCraftVersion(r.run_id, r.craft_version!, "inferred");
			}
			io.write(
				apply
					? `\npinned ${target.length} run${target.length === 1 ? "" : "s"} — still marked inferred, not declared\n`
					: `\n${target.length} run${target.length === 1 ? "" : "s"} would be pinned. Re-run with --apply to write.\n`,
			);
			return 0;
		}
		case "doctor": {
			const complaints = diagnose(store.loadAll(), io.now(), num("--stale-hours", rest) ?? 12);
			if (complaints.length === 0) {
				io.write("no data-quality problems found\n");
				return 0;
			}
			for (const c of complaints) {
				const id = c.run_id ? `${c.run_id.slice(0, 8)} ` : "";
				const cost = c.cost_usd > 0 ? ` [$${c.cost_usd.toFixed(2)}]` : "";
				io.write(`${c.kind.padEnd(15)} ${id}${c.detail}${cost}\n`);
			}
			// Nonzero so `craft-metrics doctor` can gate a script.
			return 1;
		}
		case "totals": {
			const runs = store.loadAll();
			const header = "phase          n     cost     notional      time      turns      in     out   cache\n";
			const writeTable = (totals: Map<PhaseName, PhaseTotal>) => {
				io.write(header);
				for (const [name, t] of totals) {
					io.write(
						`${name.padEnd(14)} ${String(t.n).padStart(3)}  $${t.cost.toFixed(4).padStart(8)}  $${t.notional.toFixed(4).padStart(8)}  ${(t.ms / 1000).toFixed(1).padStart(8)}s  ${String(t.turns).padStart(5)}  ${mtok(t.tokens.input)}  ${mtok(t.tokens.output)}  ${mtok(t.tokens.cacheRead)}\n`,
					);
				}
			};
			// Split by default. A blended table averages workflows that differ in shape
			// — v3's three-agent counsel panel against v4's single reviewer — and reads
			// as one coherent number when it is not. `--all` opts back into the blend.
			if (has("--all", rest)) {
				writeTable(phaseTotals(runs));
			} else {
				const byVersion = phaseTotalsByVersion(runs);
				for (const [version, totals] of byVersion) {
					const n = runs.filter((r) => (r.craft_version ?? "unknown") === version).length;
					const inferred = runs.filter(
						(r) => (r.craft_version ?? "unknown") === version && r.craft_version_source === "inferred",
					).length;
					const mark = inferred > 0 ? ` (${inferred} inferred)` : "";
					io.write(`\n── CRAFTS v${version} — ${n} run${n === 1 ? "" : "s"}${mark}\n`);
					writeTable(totals);
				}
			}
			io.write(
				"\n`cost` is what you paid; `notional` is what the tokens are worth at list price\n" +
					"(fills in $0 subscription phases). Compare phases by notional, not cost.\n" +
					"Split by workflow version — phases changed shape between versions. `--all` blends.\n",
			);
			return 0;
		}
		case "models": {
			const rows = modelTotals(store.loadAll());
			if (rows.length === 0) {
				io.write("no model usage recorded\n");
				return 0;
			}
			io.write(
				"model                          turns      cost   notional      in     out   cache\n",
			);
			for (const m of rows) {
				const cost = m.costless ? "     n/a" : `$${m.cost.toFixed(2).padStart(7)}`;
				const notional = m.unpriced ? "   unpriced" : `  $${m.notional.toFixed(2).padStart(8)}`;
				io.write(
					`${m.model.padEnd(29)} ${String(m.turns).padStart(5)}  ${cost}${notional}  ${mtok(m.tokens.input)}  ${mtok(m.tokens.output)}  ${mtok(m.tokens.cacheRead)}\n`,
				);
			}
			if (rows.some((m) => m.costless)) {
				io.write(
					"\nn/a = subscription-billed, no per-token price reported. Compare tokens, not cost.\n",
				);
			}
			return 0;
		}
		default:
			io.error(`unknown command ${cmd}`);
			io.write(USAGE);
			return 2;
	}
}

/** Entry point: turn an ExitSignal or a thrown error into a process exit code. */
export function run(argv: string[], io: Io = defaultIo): number {
	try {
		return main(argv, io);
	} catch (err) {
		if (err instanceof ExitSignal) return err.code;
		io.error(err instanceof Error ? err.message : String(err));
		return 2;
	}
}

// Self-execute only when run as a program, never when a test imports this file.
// Compared through realpath so the bin shim's resolved path matches.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(run(process.argv.slice(2)));
}
