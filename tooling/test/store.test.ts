import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, diagnose, modelTotals, summarize, phaseTotalsByGroup } from "../src/store.ts";
import { computeSeams } from "../src/schema.ts";
import type { PriceTable } from "../src/pricing.ts";

// Empty by default so tests never depend on whatever happens to be in this
// machine's real `~/.pi/agent/models-store.json`. Pass a table explicitly for
// tests about pricing itself.
function tmpStore(prices: PriceTable = new Map()): { store: Store; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "craft-metrics-"));
	return {
		store: new Store(join(dir, "events.jsonl"), prices),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("orchestration failures are bounded run events that do not change phase attempts", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R", { at: "2026-04-08T10:00:00.000Z" });
		const before = s.get(run.run_id)!;
		const phaseState = structuredClone(before.phases);
		s.recordOrchestrationFailure(run.run_id, "dispatch", "worker launch rejected", "2026-04-08T10:00:01.000Z");
		const after = s.get(run.run_id)!;
		assert.deepEqual(after.orchestration_failures, [
			{ kind: "dispatch", evidence: "worker launch rejected", at: "2026-04-08T10:00:01.000Z" },
		]);
		assert.equal(after.phase_entries, before.phase_entries);
		assert.equal(after.open_phase, before.open_phase);
		assert.deepEqual(after.phases, phaseState);

		for (const [kind, evidence] of [["validation", "bad graph"], ["parse", "invalid packet"]] as const) {
			s.recordOrchestrationFailure(run.run_id, kind, evidence);
		}
		assert.deepEqual(s.get(run.run_id)!.orchestration_failures.map((f) => f.kind), ["dispatch", "validation", "parse"]);
		assert.throws(() => s.recordOrchestrationFailure(run.run_id, "compile" as never, "bad"), /invalid orchestration failure kind/);
		for (const evidence of ["", "   ", "line one\nline two", "tab\there", "\u0007", "x".repeat(1025), "é".repeat(513)]) {
			assert.throws(() => s.recordOrchestrationFailure(run.run_id, "parse", evidence), /evidence/);
		}
		s.recordOrchestrationFailure(run.run_id, "parse", "x".repeat(1024));
	} finally {
		cleanup();
	}
});

test("usage between enter/exit lands on that phase", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "C", { agent: "craft-planner", at: "2026-04-08T10:00:00.000Z" });
		s.recordUsage(run.run_id, {
			at: "2026-04-08T10:00:05.000Z",
			model: "zai/glm-5.2",
			cost_usd: 0.01,
			tokens: { input: 100, output: 50 },
			turns: 1,
		});
		s.exitPhase(run.run_id, "C", { security_triggers: ["untrusted-input"] }, "2026-04-08T10:01:00.000Z");
		const got = s.get(run.run_id)!;
		const c = got.phases.find((p) => p.name === "C")!;
		assert.equal(c.cost_usd, 0.01);
		assert.equal(c.tokens.input, 100);
		assert.equal(c.duration_ms, 60_000);
		assert.deepEqual(c.security_triggers, ["untrusted-input"]);
		assert.equal(got.open_phase, null);
	} finally {
		cleanup();
	}
});


test("stamped D usage folds as a gateable phase", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "D", { at: "2026-04-08T10:00:00.000Z" });
		s.recordUsage(run.run_id, {
			phase: "D",
			cost_usd: 0.25,
			tokens: { input: 100, output: 20 },
			turns: 2,
		});
		s.exitPhase(run.run_id, "D", {}, "2026-04-08T10:01:00.000Z");
		const got = s.get(run.run_id)!;
		const d = got.phases.find((p) => p.name === "D")!;
		assert.equal(d.cost_usd, 0.25);
		assert.equal(d.tokens.input, 100);
		assert.equal(d.turns, 2);
		assert.equal(d.attribution.stamped, 1);
		assert.equal(d.cycles, 1);
		assert.equal(got.open_phase, null);
		assert.equal(got.phase_entries, 1);
		assert.ok(!got.phases.some((p) => p.name === "unattributed"));
	} finally {
		cleanup();
	}
});

test("explicit terminal reasons persist and timeout closes an entered phase", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const timedOut = s.openRun({ host: "pi", cwd: "/tmp/timeout", mode: "lite" });
		s.enterPhase(timedOut.run_id, "R", { at: "2026-04-08T10:00:00.000Z" });
		s.exitPhase(
			timedOut.run_id,
			"R",
			{ terminal_reason: "timeout", blocked_detail_ref: "  verify log artifact-17  ", decisions: 2 },
			"2026-04-08T10:01:00.000Z",
		);
		const closed = s.get(timedOut.run_id)!;
		const render = closed.phases.find((p) => p.name === "R")!;
		assert.equal(render.terminal_reason, "timeout");
		assert.equal(render.blocked_detail_ref, "verify log artifact-17");
		assert.equal(render.decisions, 2, "phase-specific fields survive terminal metadata");
		assert.equal(render.ended_at, "2026-04-08T10:01:00.000Z");
		assert.equal(closed.open_phase, null);

		const stillOpen = s.openRun({ host: "pi", cwd: "/tmp/open", mode: "lite" });
		s.enterPhase(stillOpen.run_id, "R", { at: "2026-04-08T10:00:00.000Z" });
		const openRender = s.get(stillOpen.run_id)!.phases.find((p) => p.name === "R")!;
		assert.equal(openRender.terminal_reason, undefined);
		assert.equal(openRender.ended_at, null);	} finally {
		cleanup();
	}
});

test("phase interventions fold without changing usage or transition accounting", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R", { at: "2026-04-08T10:00:00.000Z" });
		s.recordIntervention(run.run_id, "R", "finalization-request", 8, 3, "2026-04-08T10:01:00.000Z");

		const got = s.get(run.run_id)!;
		const r = got.phases.find((p) => p.name === "R")!;
		assert.equal(r.intervention_count, 1);
		assert.deepEqual(r.interventions, [
			{
				at: "2026-04-08T10:01:00.000Z",
				kind: "finalization-request",
				observed_turns: 8,
				observed_tools: 3,
			},
		]);
		assert.equal(got.phase_entries, 1);
		assert.equal(r.cycles, 1);
		assert.equal(r.turns, 0);
		assert.equal(r.tool_calls, 0);
		assert.equal(r.cost_usd, 0);
		assert.deepEqual(r.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.deepEqual(r.by_model, {});
		assert.equal(r.timeouts, 0);
		assert.equal(r.failovers, 0);
		assert.deepEqual(r.attribution, { stamped: 0, "open-phase": 0, "agent-map": 0, backfilled: 0, none: 0 });
		assert.equal(s.openPhase(run.run_id), "R");
	} finally {
		cleanup();
	}
});

test("phase interventions require the named phase to be open and bounded observations", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		assert.throws(() => s.recordIntervention(run.run_id, "R", "finalization-request", 1, 1), /phase R is not open/);
		s.enterPhase(run.run_id, "R");
		assert.throws(() => s.recordIntervention(run.run_id, "A", "finalization-request", 1, 1), /phase A is not open/);
		assert.throws(() => s.recordIntervention(run.run_id, "R", "finalization-request", -1, 1), /observed turns/);
		assert.throws(() => s.recordIntervention(run.run_id, "R", "finalization-request", 1, 1.5), /observed tools/);
	} finally {
		cleanup();
	}
});

test("blocked and timeout terminal reasons require a bounded single-line detail reference", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", mode: "lite" });
		s.enterPhase(run.run_id, "C");
		for (const reason of ["blocked", "timeout"] as const) {
			assert.throws(() => s.exitPhase(run.run_id, "C", { terminal_reason: reason }), /requires --blocked-detail-ref/);
		}
		assert.throws(
			() => s.exitPhase(run.run_id, "C", { terminal_reason: "blocked", blocked_detail_ref: "x".repeat(257) }),
			/at most 256/,
		);
		assert.throws(
			() => s.exitPhase(run.run_id, "C", { terminal_reason: "timeout", blocked_detail_ref: "line one\nline two" }),
			/one line/,
		);
		assert.equal(s.loadEvents().filter((event) => event.t === "phase_exit").length, 0);
		s.exitPhase(run.run_id, "C", { terminal_reason: "blocked", blocked_detail_ref: "x".repeat(256) });
		assert.equal(s.get(run.run_id)!.phases.find((p) => p.name === "C")!.blocked_detail_ref?.length, 256);	} finally {
		cleanup();
	}
});

test("usage with no open phase and no agent is unattributed", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.recordUsage(run.run_id, { cost_usd: 0.5, model: "zai/glm-5.2", turns: 1 });
		const got = s.get(run.run_id)!;
		const u = got.phases.find((p) => p.name === "unattributed")!;
		assert.equal(u.cost_usd, 0.5);
		assert.ok(!got.phases.find((p) => p.name === "C"));
	} finally {
		cleanup();
	}
});

test("named agent maps to phase when skill is late", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.recordUsage(run.run_id, {
			agent: "craft-evaluator",
			model: "xai/grok-4.6",
			cost_usd: 0.2,
			subagent: true,
			turns: 1,
		});
		const got = s.get(run.run_id)!;
		const a = got.phases.find((p) => p.name === "A")!;
		assert.equal(a.cost_usd, 0.2);
		assert.equal(a.child_cost_usd, 0.2);
		assert.equal(a.subagent_count, 1);
		assert.equal(a.model, "xai/grok-4.6");
	} finally {
		cleanup();
	}
});

test("open phase wins over agent map (builder during F)", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "F", { agent: "craft-builder" });
		s.recordUsage(run.run_id, { agent: "craft-builder", cost_usd: 0.03, turns: 1 });
		const got = s.get(run.run_id)!;
		assert.equal(got.phases.find((p) => p.name === "F")!.cost_usd, 0.03);
		assert.ok(!got.phases.find((p) => p.name === "R"));
	} finally {
		cleanup();
	}
});

test("entering a new phase closes the previous one", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R", { at: "2026-04-08T11:00:00.000Z" });
		s.enterPhase(run.run_id, "A", { at: "2026-04-08T11:10:00.000Z" });
		const got = s.get(run.run_id)!;
		assert.equal(got.open_phase, "A");
		assert.equal(got.phases.find((p) => p.name === "R")!.duration_ms, 600_000);
	} finally {
		cleanup();
	}
});

test("concurrent appends from two stores do not clobber", () => {
	const { store: a, cleanup } = tmpStore();
	try {
		const b = new Store(a.path);
		const run = a.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		a.enterPhase(run.run_id, "R");
		b.recordUsage(run.run_id, { cost_usd: 0.07, turns: 1, tool_name: "bash" });
		const r = a.get(run.run_id)!.phases.find((p) => p.name === "R")!;
		assert.equal(r.cost_usd, 0.07);
		assert.equal(r.tool_calls_by_name.bash, 1);
	} finally {
		cleanup();
	}
});

test("seams detect same-family collapse and cross-family pass", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "C");
		s.recordUsage(run.run_id, { model: "zai/glm-5.2" });
		s.exitPhase(run.run_id, "C");
		s.enterPhase(run.run_id, "counsel");
		s.recordUsage(run.run_id, { model: "zai/glm-5.2" });
		s.exitPhase(run.run_id, "counsel");
		s.enterPhase(run.run_id, "R");
		s.recordUsage(run.run_id, { model: "zai/glm-5.2" });
		s.exitPhase(run.run_id, "R");
		s.enterPhase(run.run_id, "A");
		s.recordUsage(run.run_id, { model: "xai/grok-4.6" });
		s.exitPhase(run.run_id, "A", { verdict: "pass" });
		const got = s.get(run.run_id)!;
		assert.equal(got.seams.counsel_family_differs_from_c, false);
		assert.equal(got.seams.a_family_differs_from_r, true);
		assert.equal(got.seams.t_family_differs_from_r, null);
		assert.deepEqual(computeSeams(got), got.seams);
	} finally {
		cleanup();
	}
});

test("HITL pause accumulates wall time", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "hitl" });
		s.pauseHitl(run.run_id, "2026-04-08T12:00:00.000Z");
		s.resumeHitl(run.run_id, "2026-04-08T12:05:00.000Z");
		const got = s.get(run.run_id)!;
		assert.equal(got.hitl.pause_ms, 300_000);
		assert.equal(got.outcome, "open");
	} finally {
		cleanup();
	}
});

test("mode switch full → hitl", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.setMode(run.run_id, "hitl");
		assert.equal(s.get(run.run_id)!.mode, "hitl");
	} finally {
		cleanup();
	}
});

test("mode lite is recorded", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "lite" });
		assert.equal(s.get(run.run_id)!.mode, "lite");
	} finally {
		cleanup();
	}
});

test("tool counts and quota errors stay on the open phase", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R");
		s.recordUsage(run.run_id, { tool_name: "read" });
		s.recordUsage(run.run_id, { tool_name: "read" });
		s.recordUsage(run.run_id, { tool_name: "bash", quota_error: true, failover: true });
		const r = s.get(run.run_id)!.phases.find((p) => p.name === "R")!;
		assert.equal(r.tool_calls, 3);
		assert.equal(r.tool_calls_by_name.read, 2);
		assert.equal(r.quota_errors, 1);
		assert.equal(r.failovers, 1);
	} finally {
		cleanup();
	}
});

test("kind is set on start and filled in on reuse if missing", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const opened = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		assert.equal(opened.kind, undefined);
		const filled = s.openRun({
			host: "pi",
			cwd: "/tmp/demo",
			repo: "demo",
			mode: "full",
			kind: "bugfix",
		});
		assert.equal(filled.run_id, opened.run_id);
		assert.equal(filled.kind, "bugfix");
	} finally {
		cleanup();
	}
});

test("kind can be corrected after start", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full", kind: "scaffold" });
		assert.equal(run.kind, "scaffold");
		s.setKind(run.run_id, "feature");
		assert.equal(s.get(run.run_id)!.kind, "feature");
	} finally {
		cleanup();
	}
});

test("latestOpenForCwd returns the newest open run", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const first = s.openRun({ host: "pi", cwd: "/tmp/a", repo: "a", mode: "full" });
		const reused = s.openRun({ host: "pi", cwd: "/tmp/a", repo: "a", mode: "full" });
		assert.equal(reused.run_id, first.run_id);
		const other = s.openRun({ host: "pi", cwd: "/tmp/b", repo: "b", mode: "full" });
		assert.equal(s.latestOpenForCwd("/tmp/a")?.run_id, first.run_id);
		assert.equal(s.latestOpenForCwd("/tmp/b")?.run_id, other.run_id);
	} finally {
		cleanup();
	}
});

test("lite mode refuses counsel and T phase_enter", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/lite", repo: "demo", mode: "lite" });
		assert.throws(() => s.enterPhase(run.run_id, "counsel"), /mode=lite/);
		assert.throws(() => s.enterPhase(run.run_id, "T"), /mode=lite/);
		// C is unaffected — the guard is scoped to counsel/T only.
		s.enterPhase(run.run_id, "C", { agent: "craft-planner" });
		assert.equal(s.get(run.run_id)!.open_phase, "C");
	} finally {
		cleanup();
	}
});

test("a stamped phase beats the phase that happens to be open", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		// The exact shape that lost $41.80: work done under R, reported after A opened.
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R");
		s.enterPhase(run.run_id, "A");
		s.recordUsage(run.run_id, { phase: "R", cost_usd: 2.5, turns: 40, model: "xai/grok-4.6" });
		const got = s.get(run.run_id)!;
		assert.equal(got.phases.find((p) => p.name === "R")!.cost_usd, 2.5);
		assert.equal(got.phases.find((p) => p.name === "A")!.cost_usd, 0);
		assert.equal(got.phases.find((p) => p.name === "R")!.attribution.stamped, 1);
	} finally {
		cleanup();
	}
});

test("a stamped phase rescues usage arriving after run_end", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "S", { at: "2026-04-08T10:00:00.000Z" });
		s.exitPhase(run.run_id, "S", {}, "2026-04-08T10:01:00.000Z");
		s.endRun(run.run_id, "completed", "2026-04-08T10:01:01.000Z");
		s.recordUsage(run.run_id, { at: "2026-04-08T10:01:30.000Z", phase: "S", cost_usd: 1.5, turns: 3 });
		const got = s.get(run.run_id)!;
		assert.equal(got.phases.find((p) => p.name === "S")!.cost_usd, 1.5);
		assert.ok(!got.phases.find((p) => p.name === "unattributed"));
	} finally {
		cleanup();
	}
});

test("backfill is off by default so late lumps stay unattributed", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "S", { at: "2026-04-08T10:00:00.000Z" });
		s.exitPhase(run.run_id, "S", {}, "2026-04-08T10:01:00.000Z");
		s.recordUsage(run.run_id, { at: "2026-04-08T10:01:30.000Z", cost_usd: 15.76, turns: 181 });
		const got = s.get(run.run_id)!;
		assert.equal(got.phases.find((p) => p.name === "S")!.cost_usd, 0);
		assert.equal(got.phases.find((p) => p.name === "unattributed")!.cost_usd, 15.76);
	} finally {
		cleanup();
	}
});

test("backfill within the window is recorded and flagged as a guess", () => {
	const { store: s, cleanup } = tmpStore();
	const prev = process.env.CRAFT_METRICS_BACKFILL_MS;
	process.env.CRAFT_METRICS_BACKFILL_MS = "120000";
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "A", { at: "2026-04-08T10:00:00.000Z" });
		s.exitPhase(run.run_id, "A", {}, "2026-04-08T10:01:00.000Z");
		s.recordUsage(run.run_id, { at: "2026-04-08T10:01:20.000Z", cost_usd: 0.4, turns: 2 });
		// Beyond the window it must not be guessed at.
		s.recordUsage(run.run_id, { at: "2026-04-08T10:30:00.000Z", cost_usd: 0.9, turns: 2 });
		const got = s.get(run.run_id)!;
		const a = got.phases.find((p) => p.name === "A")!;
		assert.equal(a.cost_usd, 0.4);
		assert.equal(a.backfilled_cost_usd, 0.4);
		assert.equal(a.attribution.backfilled, 1);
		assert.equal(got.phases.find((p) => p.name === "unattributed")!.cost_usd, 0.9);
	} finally {
		if (prev === undefined) delete process.env.CRAFT_METRICS_BACKFILL_MS;
		else process.env.CRAFT_METRICS_BACKFILL_MS = prev;
		cleanup();
	}
});

test("openPhase reads the current gate without folding the log", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		assert.equal(s.openPhase(run.run_id), undefined);
		s.enterPhase(run.run_id, "R");
		assert.equal(s.openPhase(run.run_id), "R");
		s.recordUsage(run.run_id, { tool_name: "read" });
		assert.equal(s.openPhase(run.run_id), "R");
		s.exitPhase(run.run_id, "R");
		assert.equal(s.openPhase(run.run_id), undefined);
		// A sibling run's transitions must not leak across.
		const other = s.openRun({ host: "pi", cwd: "/tmp/other", repo: "other", mode: "full" });
		s.enterPhase(other.run_id, "A");
		assert.equal(s.openPhase(run.run_id), undefined);
		assert.equal(s.openPhase(other.run_id), "A");
	} finally {
		cleanup();
	}
});

test("exit field casing is normalized", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "C");
		s.exitPhase(run.run_id, "C", { afk_hitl_status: "AFK", verdict: "PASS" });
		const c = s.get(run.run_id)!.phases.find((p) => p.name === "C")!;
		assert.equal(c.afk_hitl_status, "afk");
		assert.equal(c.verdict, "pass");
	} finally {
		cleanup();
	}
});

test("doctor flags a run that was started but never gated", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const ungated = s.openRun({ host: "pi", cwd: "/tmp/ungated", repo: "ungated", mode: "full" });
		s.recordUsage(ungated.run_id, { cost_usd: 36.06, turns: 400 });
		const gated = s.openRun({ host: "pi", cwd: "/tmp/gated", repo: "gated", mode: "full" });
		s.enterPhase(gated.run_id, "C");
		s.exitPhase(gated.run_id, "C");
		s.endRun(gated.run_id, "completed");

		const runs = s.loadAll();
		assert.equal(runs.find((r) => r.run_id === ungated.run_id)!.phase_entries, 0);
		assert.equal(runs.find((r) => r.run_id === gated.run_id)!.phase_entries, 1);

		const kinds = diagnose(runs).map((c) => c.kind);
		assert.ok(kinds.includes("ungated"));
		assert.ok(kinds.includes("unattributed"));
		const ung = diagnose(runs).find((c) => c.kind === "ungated")!;
		assert.equal(ung.run_id, ungated.run_id);
		assert.equal(ung.cost_usd, 36.06);
	} finally {
		cleanup();
	}
});

test("doctor flags models that burn tokens but report no cost", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R");
		s.recordUsage(run.run_id, {
			model: "openai-codex/gpt-5.6-terra",
			tokens: { input: 1000, output: 500, cacheRead: 8_200_000 },
			cost_usd: 0,
			turns: 18,
		});
		s.exitPhase(run.run_id, "R");
		const c = diagnose(s.loadAll()).find((x) => x.kind === "costless-model");
		assert.ok(c, "expected a costless-model complaint");
		assert.match(c!.detail, /gpt-5\.6-terra/);
	} finally {
		cleanup();
	}
});

test("doctor flags runs left open past the stale threshold", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({
			host: "pi",
			cwd: "/tmp/demo",
			repo: "demo",
			mode: "full",
			at: "2026-04-08T00:00:00.000Z",
		});
		s.enterPhase(run.run_id, "C", { at: "2026-04-08T00:01:00.000Z" });
		const now = Date.parse("2026-04-09T12:00:00.000Z");
		assert.ok(diagnose(s.loadAll(), now, 12).some((c) => c.kind === "stale-open"));
		assert.ok(!diagnose(s.loadAll(), now, 72).some((c) => c.kind === "stale-open"));
	} finally {
		cleanup();
	}
});

test("full and hitl modes allow counsel and T phase_enter", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const full = s.openRun({ host: "pi", cwd: "/tmp/full", repo: "demo", mode: "full" });
		s.enterPhase(full.run_id, "counsel", { agent: "craft-counsel" });
		assert.equal(s.get(full.run_id)!.open_phase, "counsel");
		const hitl = s.openRun({ host: "pi", cwd: "/tmp/hitl", repo: "demo", mode: "hitl" });
		s.enterPhase(hitl.run_id, "T", { agent: "craft-security-review" });
		assert.equal(s.get(hitl.run_id)!.open_phase, "T");
	} finally {
		cleanup();
	}
});

test("verify result lands on the open phase and on the run", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/v", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R", { agent: "craft-builder" });
		s.recordVerify(run.run_id, "npm test", 1);
		s.recordVerify(run.run_id, "npm test", 0);
		const got = s.get(run.run_id)!;
		assert.equal(got.verify_count, 2);
		assert.equal(got.last_verify!.exit_code, 0);
		assert.equal(got.last_verify!.command, "npm test");
		const r = got.phases.find((p) => p.name === "R")!;
		assert.equal(r.verify_runs, 2);
		assert.equal(r.verify_failures, 1);
	} finally {
		cleanup();
	}
});

test("A cannot report pass while verification is red", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/red", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "A", { agent: "craft-evaluator" });
		s.recordVerify(run.run_id, "npm test", 1);
		assert.throws(() => s.exitPhase(run.run_id, "A", { verdict: "pass" }), /verification is red/);
		// fail is always allowed — the gate blocks blessing, not reporting.
		s.exitPhase(run.run_id, "A", { verdict: "fail", blocking_findings: 1 });
		assert.equal(s.get(run.run_id)!.phases.find((p) => p.name === "A")!.verdict, "fail");
	} finally {
		cleanup();
	}
});

test("A passes once verification goes green again", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/green", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "A", { agent: "craft-evaluator" });
		s.recordVerify(run.run_id, "npm test", 1);
		s.recordVerify(run.run_id, "npm test", 0);
		s.exitPhase(run.run_id, "A", { verdict: "pass" });
		assert.equal(s.get(run.run_id)!.phases.find((p) => p.name === "A")!.verdict, "pass");
	} finally {
		cleanup();
	}
});

test("other phases are not gated by a red verify", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/other", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R");
		s.recordVerify(run.run_id, "npm test", 1);
		s.exitPhase(run.run_id, "R");
		s.enterPhase(run.run_id, "T");
		s.exitPhase(run.run_id, "T", { t_status: "pass" });
		assert.equal(s.get(run.run_id)!.phases.find((p) => p.name === "T")!.t_status, "pass");
	} finally {
		cleanup();
	}
});

test("doctor flags A passing with no verify ever recorded", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/unver", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "A", { agent: "craft-evaluator" });
		s.exitPhase(run.run_id, "A", { verdict: "pass" });
		assert.ok(diagnose(s.loadAll()).some((c) => c.kind === "unverified-pass"));
	} finally {
		cleanup();
	}
});

test("a multi-model phase splits tokens per model instead of dropping them", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		// The realistic shape: conductor plus a subagent on a different model, same phase.
		const run = s.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "A");
		s.recordUsage(run.run_id, {
			model: "xai/grok-4.6",
			cost_usd: 2.0,
			turns: 40,
			tokens: { input: 100, output: 20, cacheRead: 5000 },
		});
		s.recordUsage(run.run_id, {
			model: "openai-codex/gpt-5.6-terra",
			cost_usd: 0,
			turns: 60,
			tokens: { input: 300, output: 40, cacheRead: 9000 },
			subagent: true,
		});
		s.exitPhase(run.run_id, "A");

		const a = s.get(run.run_id)!.phases.find((p) => p.name === "A")!;
		assert.equal(a.turns, 100, "phase keeps the full turn count");
		assert.equal(a.by_model["xai/grok-4.6"].turns, 40);
		assert.equal(a.by_model["openai-codex/gpt-5.6-terra"].turns, 60);

		const totals = modelTotals(s.loadAll());
		const grok = totals.find((m) => m.model === "xai/grok-4.6")!;
		const codex = totals.find((m) => m.model === "openai-codex/gpt-5.6-terra")!;
		// Nothing may be silently dropped just because the phase ran two models.
		assert.equal(grok.turns + codex.turns, 100);
		assert.equal(grok.tokens.cacheRead, 5000);
		assert.equal(codex.tokens.cacheRead, 9000);
		// Subscription billing reports real tokens and no price — that must be visible,
		// not rendered as a free $0.00.
		assert.equal(codex.costless, true);
		assert.equal(grok.costless, false);
	} finally {
		cleanup();
	}
});

test("R records decision counts and deviations surface in the summary", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/dec", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R", { agent: "craft-builder" });
		s.exitPhase(run.run_id, "R", { decisions: 4, plan_deviations: 1 });
		const r = s.get(run.run_id)!.phases.find((p) => p.name === "R")!;
		assert.equal(r.decisions, 4);
		assert.equal(r.plan_deviations, 1);
		assert.match(summarize([s.get(run.run_id)!]), /decisions 4, 1 deviating from plan/);
	} finally {
		cleanup();
	}
});

test("a Render with decisions but no deviations stays quiet about them", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/dec2", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R");
		s.exitPhase(run.run_id, "R", { decisions: 2, plan_deviations: 0 });
		const out = summarize([s.get(run.run_id)!]);
		assert.match(out, /decisions 2/);
		assert.ok(!out.includes("deviating"));
	} finally {
		cleanup();
	}
});

test("dag supervisor cost lands on the supervisor phase, not unattributed", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/dag", repo: "demo", mode: "dag" });
		// A supervisor never enters a phase — it dispatches conductors and merges.
		s.recordUsage(run.run_id, { cost_usd: 4.2, model: "zai/glm-5.2", turns: 3, tool_name: "subagent" });
		const got = s.get(run.run_id)!;
		const sup = got.phases.find((p) => p.name === "supervisor")!;
		assert.equal(sup.cost_usd, 4.2);
		assert.ok(!got.phases.find((p) => p.name === "unattributed"));
	} finally {
		cleanup();
	}
});

test("a non-dag run with no open phase still falls to unattributed", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/nodag", repo: "demo", mode: "full" });
		s.recordUsage(run.run_id, { cost_usd: 1.5, turns: 1 });
		const got = s.get(run.run_id)!;
		assert.equal(got.phases.find((p) => p.name === "unattributed")!.cost_usd, 1.5);
		assert.ok(!got.phases.find((p) => p.name === "supervisor"));
	} finally {
		cleanup();
	}
});

test("doctor does not call a phaseless dag run ungated", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const dag = s.openRun({ host: "pi", cwd: "/tmp/d1", repo: "demo", mode: "dag" });
		s.recordUsage(dag.run_id, { cost_usd: 1, turns: 1 });
		assert.ok(!diagnose(s.loadAll()).some((c) => c.kind === "ungated"));
		// ...but a CRAFTS run that never gated is still a defect.
		const full = s.openRun({ host: "pi", cwd: "/tmp/d2", repo: "demo", mode: "full" });
		s.recordUsage(full.run_id, { cost_usd: 1, turns: 1 });
		assert.ok(diagnose(s.loadAll()).some((c) => c.kind === "ungated" && c.run_id === full.run_id));
	} finally {
		cleanup();
	}
});

test("a priced model gets notional cost and is not flagged unpriced", () => {
	const prices: PriceTable = new Map([
		["openai-codex/gpt-5.6-terra", { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 }],
	]);
	const { store: s, cleanup } = tmpStore(prices);
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/priced", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R");
		s.recordUsage(run.run_id, {
			model: "openai-codex/gpt-5.6-terra",
			tokens: { input: 1000, output: 500, cacheRead: 8_000_000 },
			cost_usd: 0, // subscription-billed: real tokens, no marginal charge
			turns: 3,
		});
		s.exitPhase(run.run_id, "R");
		const got = s.get(run.run_id)!;
		const r = got.phases.find((p) => p.name === "R")!;
		// (1000*2 + 500*12 + 8_000_000*0.2) / 1e6
		assert.equal(r.cost_usd, 0);
		assert.ok(r.notional_cost_usd! > 1.6 && r.notional_cost_usd! < 1.61);
		assert.equal(got.notional_cost_usd, r.notional_cost_usd);
		assert.ok(!diagnose(s.loadAll()).some((c) => c.kind === "costless-model"));
		const mt = modelTotals(s.loadAll()).find((m) => m.model === "openai-codex/gpt-5.6-terra")!;
		assert.equal(mt.costless, true); // still true — cost_usd is genuinely $0
		assert.equal(mt.unpriced, false); // but notional filled in, so not unpriced
	} finally {
		cleanup();
	}
});

test("an unpriced model falls back to actual cost and shows n/a notional", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/unpriced", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "C");
		s.recordUsage(run.run_id, {
			model: "some-provider/unknown-model",
			tokens: { input: 100, output: 50, cacheRead: 0 },
			cost_usd: 0,
			turns: 1,
		});
		s.exitPhase(run.run_id, "C");
		const c = s.get(run.run_id)!.phases.find((p) => p.name === "C")!;
		assert.equal(c.notional_cost_usd, 0);
		const mt = modelTotals(s.loadAll()).find((m) => m.model === "some-provider/unknown-model")!;
		assert.equal(mt.unpriced, true);
		assert.ok(diagnose(s.loadAll()).some((c2) => c2.kind === "costless-model"));
	} finally {
		cleanup();
	}
});

test("a metered model's notional equals its actual cost (no subscription gap)", () => {
	const prices: PriceTable = new Map([["xai/grok-4.6", { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }]]);
	const { store: s, cleanup } = tmpStore(prices);
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/metered", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "A");
		s.recordUsage(run.run_id, {
			model: "xai/grok-4.6",
			tokens: { input: 1_000_000, output: 0, cacheRead: 0 },
			cost_usd: 2, // matches the priced rate exactly
			turns: 1,
		});
		s.exitPhase(run.run_id, "A", { verdict: "pass" });
		const a = s.get(run.run_id)!.phases.find((p) => p.name === "A")!;
		assert.equal(a.cost_usd, 2);
		assert.equal(a.notional_cost_usd, 2);
	} finally {
		cleanup();
	}
});

test("declared craft version wins over inference", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/v", repo: "demo", mode: "full", craft_version: "9" });
		// Spawns a v3-only agent, but the declaration is authoritative.
		s.enterPhase(run.run_id, "counsel", { agent: "craft-plan-feasibility" });
		const got = s.get(run.run_id)!;
		assert.equal(got.craft_version, "9");
		assert.equal(got.craft_version_source, "declared");
	} finally {
		cleanup();
	}
});

test("v3 is inferred from the three-agent counsel panel", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/v3", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "counsel", { agent: "craft-plan-feasibility,craft-plan-scope,craft-plan-security" });
		const got = s.get(run.run_id)!;
		assert.equal(got.craft_version, "3");
		assert.equal(got.craft_version_source, "inferred");
	} finally {
		cleanup();
	}
});

test("v3 is also inferred from a spawned simplifier or sharpener", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/v3b", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "S", { agent: "craft-sharpener" });
		assert.equal(s.get(run.run_id)!.craft_version, "3");
	} finally {
		cleanup();
	}
});

test("v5 is inferred from an entered Discovery phase", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/v5", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "D");
		s.enterPhase(run.run_id, "C", { agent: "craft-planner" });
		assert.equal(s.get(run.run_id)!.craft_version, "5");
		assert.equal(s.get(run.run_id)!.craft_version_source, "inferred");
	} finally {
		cleanup();
	}
});

test("v4 is inferred from the merged counsel agent", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/v4", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "counsel", { agent: "craft-counsel" });
		assert.equal(s.get(run.run_id)!.craft_version, "4");
	} finally {
		cleanup();
	}
});

test("v4 is inferred from structural markers alone, with no telltale agent", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/v4b", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R");
		s.recordVerify(run.run_id, "npm test", 0); // verify gate is v4-only
		s.exitPhase(run.run_id, "R", { decisions: 2, plan_deviations: 0 });
		assert.equal(s.get(run.run_id)!.craft_version, "4");
	} finally {
		cleanup();
	}
});

test("a run with no distinguishing marks stays unknown rather than guessing", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/vx", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "C");
		s.exitPhase(run.run_id, "C");
		const got = s.get(run.run_id)!;
		assert.equal(got.craft_version, undefined);
		assert.equal(got.craft_version_source, "unknown");
	} finally {
		cleanup();
	}
});

test("conflicting version signals refuse to resolve", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/vc", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "counsel", { agent: "craft-plan-scope" }); // v3 signal
		s.enterPhase(run.run_id, "S", { agent: "craft-counsel" }); // v4 signal
		const got = s.get(run.run_id)!;
		assert.equal(got.craft_version, undefined);
		assert.equal(got.craft_version_source, "unknown");
	} finally {
		cleanup();
	}
});

test("phaseTotalsByGroup keeps v3 and v4 counsel apart", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const old = s.openRun({ host: "pi", cwd: "/tmp/old", repo: "demo", mode: "full" });
		s.enterPhase(old.run_id, "counsel", { agent: "craft-plan-feasibility", at: "2026-04-01T00:00:00.000Z" });
		s.recordUsage(old.run_id, { cost_usd: 1, model: "zai/glm-5.2", turns: 1 });
		s.exitPhase(old.run_id, "counsel", {}, "2026-04-01T00:12:00.000Z");

		const fresh = s.openRun({ host: "pi", cwd: "/tmp/new", repo: "demo", mode: "full" });
		s.enterPhase(fresh.run_id, "counsel", { agent: "craft-counsel", at: "2026-04-02T00:00:00.000Z" });
		s.recordUsage(fresh.run_id, { cost_usd: 0.25, model: "zai/glm-5.2", turns: 1 });
		s.exitPhase(fresh.run_id, "counsel", {}, "2026-04-02T00:03:00.000Z");

		const groups = phaseTotalsByGroup(s.loadAll());
		const v3 = groups.find((g) => g.craft_version === "3")!;
		const v4 = groups.find((g) => g.craft_version === "4")!;
		assert.equal(v3.totals.get("counsel")!.cost, 1);
		assert.equal(v3.totals.get("counsel")!.ms, 720_000);
		assert.equal(v4.totals.get("counsel")!.cost, 0.25);
		assert.equal(v4.totals.get("counsel")!.ms, 180_000);
		// Both runs are pi, so the harness axis must not fragment them further.
		assert.equal(groups.length, 2);
		assert.equal(v3.inferred, 1, "version was recovered from the agents, not declared");
	} finally {
		cleanup();
	}
});

test("phaseTotalsByGroup separates the same version on two harnesses", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		for (const [host, cwd, cost] of [
			["pi", "/tmp/on-pi", 2],
			["claude-code", "/tmp/on-cc", 0],
		] as const) {
			const run = s.openRun({ host, cwd, repo: "demo", mode: "full", craft_version: "4" });
			s.enterPhase(run.run_id, "R", { agent: "craft-builder", at: "2026-04-02T00:00:00.000Z" });
			s.recordUsage(run.run_id, { cost_usd: cost, model: "anthropic/claude-opus-5", turns: 1, tokens: { input: 10 } });
			s.exitPhase(run.run_id, "R", {}, "2026-04-02T00:05:00.000Z");
		}

		const groups = phaseTotalsByGroup(s.loadAll());
		assert.equal(groups.length, 2, "same version, two harnesses, two populations");
		const pi = groups.find((g) => g.host === "pi")!;
		const cc = groups.find((g) => g.host === "claude-code")!;
		assert.equal(pi.craft_version, "4");
		assert.equal(cc.craft_version, "4");
		assert.equal(pi.totals.get("R")!.cost, 2);
		// The whole point: Claude Code reports no cost, so blending would have shown
		// $2 across two runs and made the harness look half price rather than unpriced.
		assert.equal(cc.totals.get("R")!.cost, 0);

		// The same model on two harnesses is two rows, never one.
		const rows = modelTotals(s.loadAll()).filter((m) => m.model === "anthropic/claude-opus-5");
		assert.equal(rows.length, 2);
		assert.deepEqual(rows.map((r) => r.host).sort(), ["claude-code", "pi"]);
	} finally {
		cleanup();
	}
});

test("setHost corrects a run that was opened without a harness", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "unknown", cwd: "/tmp/nohost", repo: "demo", mode: "full" });
		// A later opener that does know the harness fills the gap in place.
		s.openRun({ host: "claude-code", cwd: "/tmp/nohost", repo: "demo", mode: "full" });
		assert.equal(s.get(run.run_id)!.host, "claude-code", "unknown is a gap to fill, not a stated value");

		s.setHost(run.run_id, "unknown");
		assert.ok(
			diagnose(s.loadAll()).some((c) => c.kind === "unknown-host"),
			"a run belonging to no harness compares against nothing",
		);

		s.setHost(run.run_id, "claude-code");
		assert.equal(s.get(run.run_id)!.host, "claude-code");
		assert.ok(!diagnose(s.loadAll()).some((c) => c.kind === "unknown-host"));

		// A second opener declaring a different harness does not get to overwrite a
		// host that is already stated — only `setHost` settles a real disagreement.
		s.openRun({ host: "pi", cwd: "/tmp/nohost", repo: "demo", mode: "full" });
		assert.equal(s.get(run.run_id)!.host, "claude-code");
	} finally {
		cleanup();
	}
});

test("R records mutation counts alongside its decision counts", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/mut", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R", { agent: "craft-builder" });
		s.exitPhase(run.run_id, "R", { decisions: 3, plan_deviations: 1, mutants_tested: 199, mutants_survived: 37 });
		const r = s.get(run.run_id)!.phases.find((p) => p.name === "R")!;
		assert.equal(r.mutants_tested, 199);
		assert.equal(r.mutants_survived, 37);
		assert.equal(r.decisions, 3);
	} finally {
		cleanup();
	}
});

test("a run where mutation was skipped records no mutation counts at all", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/skip", repo: "demo", mode: "full" });
		s.enterPhase(run.run_id, "R");
		s.exitPhase(run.run_id, "R", { decisions: 2 });
		const r = s.get(run.run_id)!.phases.find((p) => p.name === "R")!;
		assert.equal(r.mutants_tested, undefined, "absent, not zero — a skip is not a clean sweep");
		assert.equal(r.mutants_survived, undefined);
	} finally {
		cleanup();
	}
});

test("a version declared after the run was already opened is backfilled", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		// The pi extension opens a run from the prompt before the skill reaches its
		// own `start`, so the declared version always arrives second.
		const opened = s.openRun({ host: "pi", cwd: "/tmp/late", repo: "late", mode: "full" });
		assert.equal(opened.craft_version, undefined);
		const filled = s.openRun({ host: "pi", cwd: "/tmp/late", repo: "late", mode: "full", kind: "feature", craft_version: "4" });
		assert.equal(filled.run_id, opened.run_id, "the same run, not a second one");
		assert.equal(filled.craft_version, "4");
		assert.equal(filled.craft_version_source, "declared");
		assert.equal(filled.kind, "feature");
	} finally {
		cleanup();
	}
});

test("a declared version is not overwritten by a later, different declaration", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const first = s.openRun({ host: "pi", cwd: "/tmp/keep", repo: "keep", mode: "full", craft_version: "4" });
		const second = s.openRun({ host: "pi", cwd: "/tmp/keep", repo: "keep", mode: "full", craft_version: "9" });
		assert.equal(second.run_id, first.run_id);
		assert.equal(second.craft_version, "4", "first declaration wins; a later one is not authoritative");
	} finally {
		cleanup();
	}
});

test("a declared version beats what inference would have concluded", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/beat", repo: "beat", mode: "full" });
		// A v3-only agent would otherwise date this run to v3.
		s.enterPhase(run.run_id, "counsel", { agent: "craft-plan-scope" });
		assert.equal(s.get(run.run_id)!.craft_version, "3");
		s.openRun({ host: "pi", cwd: "/tmp/beat", repo: "beat", mode: "full", craft_version: "4" });
		const after = s.get(run.run_id)!;
		assert.equal(after.craft_version, "4");
		assert.equal(after.craft_version_source, "declared");
	} finally {
		cleanup();
	}
});

test("switching a run to dag moves its already-recorded cost to supervisor", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		// The real sequence: a supervisor session is opened as `full` by the host,
		// spends, and is corrected afterwards.
		const run = s.openRun({ host: "pi", cwd: "/tmp/sup", repo: "sup", mode: "full" });
		s.recordUsage(run.run_id, { cost_usd: 36.06, turns: 40, tool_name: "subagent" });
		assert.equal(
			s.get(run.run_id)!.phases.find((p) => p.name === "unattributed")!.cost_usd,
			36.06,
			"before the correction it is orphaned",
		);

		s.setMode(run.run_id, "dag");
		const after = s.get(run.run_id)!;
		assert.equal(after.mode, "dag");
		assert.equal(after.phases.find((p) => p.name === "supervisor")!.cost_usd, 36.06);
		assert.ok(!after.phases.find((p) => p.name === "unattributed"), "and nothing is left behind");
	} finally {
		cleanup();
	}
});

test("switching away from dag moves supervisor cost back out", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/back", repo: "back", mode: "dag" });
		s.recordUsage(run.run_id, { cost_usd: 5, turns: 1 });
		assert.equal(s.get(run.run_id)!.phases.find((p) => p.name === "supervisor")!.cost_usd, 5);
		s.setMode(run.run_id, "full");
		const after = s.get(run.run_id)!;
		assert.ok(!after.phases.find((p) => p.name === "supervisor"));
		assert.equal(after.phases.find((p) => p.name === "unattributed")!.cost_usd, 5);
	} finally {
		cleanup();
	}
});

test("the last mode wins when a run is corrected more than once", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/multi", repo: "multi", mode: "full" });
		s.recordUsage(run.run_id, { cost_usd: 2, turns: 1 });
		s.setMode(run.run_id, "dag");
		s.setMode(run.run_id, "hitl");
		const after = s.get(run.run_id)!;
		assert.equal(after.mode, "hitl");
		assert.equal(after.phases.find((p) => p.name === "unattributed")!.cost_usd, 2);
	} finally {
		cleanup();
	}
});

test("a mode correction does not disturb usage that was stamped with a phase", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/stamp", repo: "stamp", mode: "full" });
		s.enterPhase(run.run_id, "R");
		s.recordUsage(run.run_id, { cost_usd: 1, turns: 1 });
		s.exitPhase(run.run_id, "R");
		s.setMode(run.run_id, "dag");
		const after = s.get(run.run_id)!;
		assert.equal(after.phases.find((p) => p.name === "R")!.cost_usd, 1, "phase attribution still wins over mode");
		assert.ok(!after.phases.find((p) => p.name === "supervisor"));
	} finally {
		cleanup();
	}
});

test("the lite guard reads the corrected mode, not the one at open", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/guard", repo: "guard", mode: "full" });
		s.enterPhase(run.run_id, "counsel"); // legal under full
		s.setMode(run.run_id, "lite");
		assert.throws(() => s.enterPhase(run.run_id, "T"), /mode=lite/, "the correction is what the guard enforces");
	} finally {
		cleanup();
	}
});

test("a persisted inference stays marked inferred, not laundered into a declaration", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/pin", repo: "pin", mode: "full" });
		s.enterPhase(run.run_id, "counsel", { agent: "craft-plan-scope" });
		const before = s.get(run.run_id)!;
		assert.equal(before.craft_version, "3");
		assert.equal(before.craft_version_source, "inferred");

		s.setCraftVersion(run.run_id, "3", "inferred");
		const after = s.get(run.run_id)!;
		assert.equal(after.craft_version, "3");
		assert.equal(after.craft_version_source, "inferred", "pinning must not promote a guess");
	} finally {
		cleanup();
	}
});

test("a pinned version survives a classifier that would now conclude otherwise", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/frozen", repo: "frozen", mode: "full" });
		s.setCraftVersion(run.run_id, "3", "inferred");
		// Later evidence that inference alone would read as v4. The pin is what the
		// classifier concluded at the time, and freezing it is the entire point.
		s.enterPhase(run.run_id, "counsel", { agent: "craft-counsel" });
		assert.equal(s.get(run.run_id)!.craft_version, "3");
	} finally {
		cleanup();
	}
});

test("a real declaration still overrides a pinned inference", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/over", repo: "over", mode: "full" });
		s.setCraftVersion(run.run_id, "3", "inferred");
		s.openRun({ host: "pi", cwd: "/tmp/over", repo: "over", mode: "full", craft_version: "4" });
		const after = s.get(run.run_id)!;
		assert.equal(after.craft_version, "4", "the skill knows better than the classifier");
		assert.equal(after.craft_version_source, "declared");
	} finally {
		cleanup();
	}
});

test("a version declared at open is recorded as declared, not inferred", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/dec", repo: "dec", mode: "full", craft_version: "4" });
		assert.equal(s.get(run.run_id)!.craft_version_source, "declared");
	} finally {
		cleanup();
	}
});
