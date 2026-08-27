#!/usr/bin/env node
import { basename } from "node:path";
import { Store, defaultStorePath, diagnose, modelTotals, summarize, phaseTotals } from "./store.ts";
import { KINDS, PHASES, type Host, type Kind, type Mode, type Outcome, type PhaseName } from "./schema.ts";

const USAGE = `craft-metrics — phase-grained CRAFT run collector

Usage:
  craft-metrics start  --kind feature|bugfix|refactor|scaffold|docs|chore [--run ID] --mode full|hitl|lite|dag [--host pi|claude-code] [--cwd PATH] [--repo NAME]
  craft-metrics enter  --run ID --phase C|counsel|R|A|F|T|S [--agent NAME]
  craft-metrics exit   --run ID --phase PHASE [--verdict V] [--blocking-findings N] [--p0 N] [--non-p0 N]
                       [--security-triggers a,b] [--counsel-status S] [--t-status S] [--docs-touched N]
                       [--blocking-questions N] [--afk-hitl-status S] [--criteria-provenance S] [--probe-required]
                       [--decisions N] [--plan-deviations N]
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
function mtok(n: number): string {
	if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`.padStart(6);
	if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`.padStart(6);
	return String(n).padStart(6);
}

function requireArg(flag: string, argv: string[]): string {
	const v = arg(flag, argv);
	if (!v) {
		console.error(`missing ${flag}`);
		process.exit(2);
	}
	return v;
}

function parsePhase(argv: string[]): PhaseName {
	const p = requireArg("--phase", argv);
	if (!PHASES.includes(p as PhaseName) || p === "unattributed") {
		console.error(`invalid --phase ${p}`);
		process.exit(2);
	}
	return p as PhaseName;
}

function parseKind(argv: string[]): Kind {
	const k = requireArg("--kind", argv);
	if (!KINDS.includes(k as Kind)) {
		console.error(`invalid --kind ${k} (use ${KINDS.join("|")})`);
		process.exit(2);
	}
	return k as Kind;
}

function parseMode(argv: string[]): Mode {
	const m = requireArg("--mode", argv);
	if (m !== "full" && m !== "hitl" && m !== "lite" && m !== "dag") {
		console.error(`invalid --mode ${m} (use full, hitl, lite, or dag)`);
		process.exit(2);
	}
	return m;
}

function main(argv: string[]): void {
	const cmd = argv[0];
	if (!cmd || cmd === "-h" || cmd === "--help") {
		process.stdout.write(USAGE);
		return;
	}
	const rest = argv.slice(1);
	const store = new Store(process.env.CRAFT_METRICS_PATH ?? defaultStorePath());

	switch (cmd) {
		case "start": {
			const run = store.openRun({
				run_id: arg("--run", rest),
				host: (arg("--host", rest) as Host | undefined) ?? "unknown",
				cwd: arg("--cwd", rest) ?? process.cwd(),
				repo: arg("--repo", rest) ?? basename(arg("--cwd", rest) ?? process.cwd()),
				mode: parseMode(rest),
				kind: parseKind(rest),
			});
			process.stdout.write(run.run_id + "\n");
			return;
		}
		case "enter": {
			const run = store.enterPhase(requireArg("--run", rest), parsePhase(rest), {
				agent: arg("--agent", rest),
			});
			process.stdout.write(run.run_id + "\n");
			return;
		}
		case "exit": {
			const run = store.exitPhase(requireArg("--run", rest), parsePhase(rest), {
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
			});
			process.stdout.write(run.run_id + "\n");
			return;
		}
		case "usage": {
			const run = store.recordUsage(requireArg("--run", rest), {
				phase: has("--phase", rest) ? parsePhase(rest) : undefined,
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
			process.stdout.write(run.run_id + "\n");
			return;
		}
		case "verify": {
			const code = num("--exit-code", rest);
			if (code === undefined || Number.isNaN(code)) {
				console.error("missing or invalid --exit-code");
				process.exit(2);
			}
			const run = store.recordVerify(requireArg("--run", rest), requireArg("--command", rest), code);
			process.stdout.write(run.run_id + "\n");
			return;
		}
		case "pause":
			store.pauseHitl(requireArg("--run", rest));
			return;
		case "resume":
			store.resumeHitl(requireArg("--run", rest));
			return;
		case "mode":
			store.setMode(requireArg("--run", rest), parseMode(rest));
			return;
		case "kind":
			store.setKind(requireArg("--run", rest), parseKind(rest));
			return;
		case "end": {
			const outcome = (arg("--outcome", rest) as Outcome | undefined) ?? "completed";
			store.endRun(requireArg("--run", rest), outcome);
			return;
		}
		case "current": {
			const cwd = arg("--cwd", rest) ?? process.cwd();
			const run = store.latestOpenForCwd(cwd);
			if (!run) process.exit(1);
			process.stdout.write(run.run_id + "\n");
			return;
		}
		case "show": {
			const id = arg("--run", rest);
			const last = num("--last", rest);
			let runs = store.loadAll();
			if (id) runs = runs.filter((r) => r.run_id === id || r.run_id.startsWith(id));
			if (last) runs = runs.slice(-last);
			process.stdout.write(summarize(runs) + "\n");
			return;
		}
		case "doctor": {
			const complaints = diagnose(store.loadAll(), Date.now(), num("--stale-hours", rest) ?? 12);
			if (complaints.length === 0) {
				process.stdout.write("no data-quality problems found\n");
				return;
			}
			for (const c of complaints) {
				const id = c.run_id ? `${c.run_id.slice(0, 8)} ` : "";
				const cost = c.cost_usd > 0 ? ` [$${c.cost_usd.toFixed(2)}]` : "";
				process.stdout.write(`${c.kind.padEnd(15)} ${id}${c.detail}${cost}\n`);
			}
			process.exitCode = 1;
			return;
		}
		case "totals": {
			const totals = phaseTotals(store.loadAll());
			process.stdout.write(
				"phase          n     cost        time      turns      in     out   cache\n",
			);
			for (const [name, t] of totals) {
				process.stdout.write(
					`${name.padEnd(14)} ${String(t.n).padStart(3)}  $${t.cost.toFixed(4).padStart(8)}  ${(t.ms / 1000).toFixed(1).padStart(8)}s  ${String(t.turns).padStart(5)}  ${mtok(t.tokens.input)}  ${mtok(t.tokens.output)}  ${mtok(t.tokens.cacheRead)}\n`,
				);
			}
			return;
		}
		case "models": {
			const rows = modelTotals(store.loadAll());
			if (rows.length === 0) {
				process.stdout.write("no model usage recorded\n");
				return;
			}
			process.stdout.write(
				"model                          turns      cost      in     out   cache\n",
			);
			for (const m of rows) {
				const cost = m.costless ? "     n/a" : `$${m.cost.toFixed(2).padStart(7)}`;
				process.stdout.write(
					`${m.model.padEnd(29)} ${String(m.turns).padStart(5)}  ${cost}  ${mtok(m.tokens.input)}  ${mtok(m.tokens.output)}  ${mtok(m.tokens.cacheRead)}\n`,
				);
			}
			if (rows.some((m) => m.costless)) {
				process.stdout.write(
					"\nn/a = subscription-billed, no per-token price reported. Compare tokens, not cost.\n",
				);
			}
			return;
		}
		default:
			console.error(`unknown command ${cmd}`);
			process.stdout.write(USAGE);
			process.exit(2);
	}
}

try {
	main(process.argv.slice(2));
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(2);
}
