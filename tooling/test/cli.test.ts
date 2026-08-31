import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { main, mtok, run, type Io } from "../src/cli.ts";
import type { PriceTable } from "../src/pricing.ts";

/**
 * The CLI reaches for `process` for output, exit codes, cwd and the clock. All of
 * it is injected here so a command that rejects bad input can be asserted on
 * instead of taking the test runner down with it.
 *
 * An empty price table by default: notional pricing must not depend on whatever
 * happens to be in this machine's pi model registry.
 */
function harness(prices: PriceTable = new Map()) {
	const dir = mkdtempSync(join(tmpdir(), "craft-cli-"));
	const out: string[] = [];
	const err: string[] = [];
	const io: Io = {
		write: (s) => out.push(s),
		error: (s) => err.push(s),
		cwd: () => "/tmp/project",
		now: () => Date.parse("2026-04-08T12:00:00.000Z"),
		storePath: () => join(dir, "events.jsonl"),
		prices,
	};
	return {
		io,
		out: () => out.join(""),
		err: () => err.join(""),
		events: () => {
			try {
				return readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
			} catch {
				return [];
			}
		},
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("no command prints usage and succeeds", () => {
	const h = harness();
	try {
		assert.equal(main([], h.io), 0);
		assert.match(h.out(), /^craft-metrics —/);
	} finally {
		h.cleanup();
	}
});

test("--help and -h both print usage", () => {
	for (const flag of ["--help", "-h"]) {
		const h = harness();
		try {
			assert.equal(main([flag], h.io), 0);
			assert.match(h.out(), /Usage:/);
		} finally {
			h.cleanup();
		}
	}
});

test("an unknown command exits 2 and shows usage", () => {
	const h = harness();
	try {
		assert.equal(main(["frobnicate"], h.io), 2);
		assert.match(h.err(), /unknown command frobnicate/);
		assert.match(h.out(), /Usage:/);
	} finally {
		h.cleanup();
	}
});

test("start writes a run and echoes its id", () => {
	const h = harness();
	try {
		assert.equal(main(["start", "--kind", "feature", "--mode", "full"], h.io), 0);
		const id = h.out().trim();
		assert.match(id, /^[0-9a-f-]{36}$/);
		const opened = h.events().find((e) => e.t === "run_open");
		assert.equal(opened.kind, "feature");
		assert.equal(opened.mode, "full");
		// cwd and repo both fall back to the injected working directory.
		assert.equal(opened.cwd, "/tmp/project");
		assert.equal(opened.repo, "project");
	} finally {
		h.cleanup();
	}
});

test("start records an explicit craft version", () => {
	const h = harness();
	try {
		main(["start", "--kind", "docs", "--mode", "lite", "--craft-version", "4"], h.io);
		assert.equal(h.events().find((e) => e.t === "run_open").craft_version, "4");
	} finally {
		h.cleanup();
	}
});

test("an invalid kind, mode, or phase exits 2 with a specific message", () => {
	const cases: Array<[string[], RegExp]> = [
		[["start", "--kind", "wat", "--mode", "full"], /invalid --kind wat/],
		[["start", "--kind", "feature", "--mode", "wat"], /invalid --mode wat/],
		[["enter", "--run", "x", "--phase", "wat"], /invalid --phase wat/],
		// Derived buckets are not gates a caller may enter.
		[["enter", "--run", "x", "--phase", "unattributed"], /invalid --phase unattributed/],
		// Host decides which population a run is compared within, so a near-miss
		// spelling must fail rather than quietly open a third harness.
		[["start", "--kind", "feature", "--mode", "full", "--host", "claude"], /invalid --host claude/],
	];
	for (const [argv, expected] of cases) {
		const h = harness();
		try {
			assert.equal(run(argv, h.io), 2, argv.join(" "));
			assert.match(h.err(), expected);
		} finally {
			h.cleanup();
		}
	}
});

test("a missing required flag exits 2 and names the flag", () => {
	const h = harness();
	try {
		assert.equal(run(["enter", "--phase", "C"], h.io), 2);
		assert.match(h.err(), /missing --run/);
	} finally {
		h.cleanup();
	}
});

test("enter and exit round-trip a phase with its fields", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		assert.equal(main(["enter", "--run", id, "--phase", "C", "--agent", "craft-planner"], h.io), 0);
		assert.equal(
			main(["exit", "--run", id, "--phase", "C", "--security-triggers", "untrusted-input,secrets-sensitive-data", "--blocking-questions", "2"], h.io),
			0,
		);
		const exit = h.events().find((e) => e.t === "phase_exit");
		assert.deepEqual(exit.fields.security_triggers, ["untrusted-input", "secrets-sensitive-data"]);
		assert.equal(exit.fields.blocking_questions, 2);
	} finally {
		h.cleanup();
	}
});

test("intervene records a finalization request and show exposes its observations", () => {
	const h = harness();
	try {
		main(["start", "--kind", "chore", "--mode", "lite"], h.io);
		const id = h.out().trim();
		main(["enter", "--run", id, "--phase", "R"], h.io);
		assert.equal(
			main([
				"intervene", "--run", id, "--phase", "R", "--kind", "finalization-request",
				"--observed-turns", "8", "--observed-tools", "3",
			], h.io),
			0,
		);
		const event = h.events().find((e) => e.t === "phase_intervention");
		assert.equal(event.phase, "R");
		assert.equal(event.kind, "finalization-request");
		assert.equal(event.observed_turns, 8);
		assert.equal(event.observed_tools, 3);
		assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/);
		main(["show", "--run", id], h.io);
		assert.match(h.out(), /finalization-request.*8t \/ 3tools/);
	} finally {
		h.cleanup();
	}
});

test("intervene rejects invalid kinds, observations, and closed phases", () => {
	for (const [tail, expected] of [
		[["--kind", "wat", "--observed-turns", "1", "--observed-tools", "1"], /invalid --kind wat/],
		[["--kind", "finalization-request", "--observed-turns", "-1", "--observed-tools", "1"], /invalid --observed-turns/],
		[["--kind", "finalization-request", "--observed-turns", "1", "--observed-tools", "1.5"], /invalid --observed-tools/],
	] as Array<[string[], RegExp]>) {
		const h = harness();
		try {
			main(["start", "--kind", "chore", "--mode", "lite"], h.io);
			const id = h.out().trim();
			main(["enter", "--run", id, "--phase", "R"], h.io);
			assert.equal(run(["intervene", "--run", id, "--phase", "R", ...tail], h.io), 2);
			assert.match(h.err(), expected);
		} finally {
			h.cleanup();
		}
	}

	const h = harness();
	try {
		main(["start", "--kind", "chore", "--mode", "lite"], h.io);
		const id = h.out().trim();
		assert.equal(run([
			"intervene", "--run", id, "--phase", "R", "--kind", "finalization-request",
			"--observed-turns", "1", "--observed-tools", "1",
		], h.io), 2);
		assert.match(h.err(), /phase R is not open/);
	} finally {
		h.cleanup();
	}
});

test("an empty --security-triggers yields an empty list, not a list of one empty string", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		main(["enter", "--run", id, "--phase", "C"], h.io);
		main(["exit", "--run", id, "--phase", "C", "--security-triggers", ""], h.io);
		assert.deepEqual(h.events().find((e) => e.t === "phase_exit").fields.security_triggers, []);
	} finally {
		h.cleanup();
	}
});

test("lite mode refuses a counsel phase, surfacing the store's guard as exit 2", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "lite"], h.io);
		const id = h.out().trim();
		assert.equal(run(["enter", "--run", id, "--phase", "counsel"], h.io), 2);
		assert.match(h.err(), /mode=lite/);
	} finally {
		h.cleanup();
	}
});

test("verify requires a numeric exit code", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		assert.equal(run(["verify", "--run", id, "--command", "npm test"], h.io), 2);
		assert.match(h.err(), /missing or invalid --exit-code/);
	} finally {
		h.cleanup();
	}
});

test("verify records the command and its exit code", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		assert.equal(main(["verify", "--run", id, "--command", "npm test", "--exit-code", "1"], h.io), 0);
		const v = h.events().find((e) => e.t === "verify");
		assert.equal(v.command, "npm test");
		assert.equal(v.exit_code, 1);
	} finally {
		h.cleanup();
	}
});

test("A cannot exit with a pass verdict while verification is red", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		main(["enter", "--run", id, "--phase", "A"], h.io);
		main(["verify", "--run", id, "--command", "npm test", "--exit-code", "1"], h.io);
		assert.equal(run(["exit", "--run", id, "--phase", "A", "--verdict", "pass"], h.io), 2);
		assert.match(h.err(), /verification is red/);
	} finally {
		h.cleanup();
	}
});

test("current exits 1 when no run is open for the directory", () => {
	const h = harness();
	try {
		assert.equal(main(["current", "--cwd", "/tmp/nothing-here"], h.io), 1);
		assert.equal(h.out(), "");
	} finally {
		h.cleanup();
	}
});

test("current prints the open run for a directory", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full", "--cwd", "/tmp/proj"], h.io);
		const id = h.out().trim();
		assert.equal(main(["current", "--cwd", "/tmp/proj"], h.io), 0);
		assert.ok(h.out().includes(id));
	} finally {
		h.cleanup();
	}
});

test("doctor exits 0 on clean data and 1 when it finds a problem", () => {
	const clean = harness();
	try {
		assert.equal(main(["doctor"], clean.io), 0);
		assert.match(clean.out(), /no data-quality problems found/);
	} finally {
		clean.cleanup();
	}

	const dirty = harness();
	try {
		// A run that never entered a phase is the "ungated" complaint.
		main(["start", "--kind", "feature", "--mode", "full"], dirty.io);
		const id = dirty.out().trim();
		main(["usage", "--run", id, "--cost", "1", "--turns", "1"], dirty.io);
		assert.equal(main(["doctor"], dirty.io), 1, "a complaint must produce a nonzero exit");
		assert.match(dirty.out(), /ungated/);
	} finally {
		dirty.cleanup();
	}
});

test("show reports nothing gracefully when there are no runs", () => {
	const h = harness();
	try {
		assert.equal(main(["show"], h.io), 0);
		assert.match(h.out(), /no craft runs recorded/);
	} finally {
		h.cleanup();
	}
});

test("show --run accepts an id prefix", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		assert.equal(main(["show", "--run", id.slice(0, 8)], h.io), 0);
		assert.ok(h.out().includes(id.slice(0, 8)));
	} finally {
		h.cleanup();
	}
});

test("models reports nothing gracefully when no model usage exists", () => {
	const h = harness();
	try {
		assert.equal(main(["models"], h.io), 0);
		assert.match(h.out(), /no model usage recorded/);
	} finally {
		h.cleanup();
	}
});

test("models marks a subscription model n/a and prices it notionally", () => {
	const prices: PriceTable = new Map([["openai-codex/gpt-5.6-terra", { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 }]]);
	const h = harness(prices);
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		main(["enter", "--run", id, "--phase", "R"], h.io);
		main(["usage", "--run", id, "--model", "openai-codex/gpt-5.6-terra", "--cost", "0", "--input", "1000000", "--turns", "1"], h.io);
		main(["models"], h.io);
		const text = h.out();
		assert.match(text, /n\/a/, "a $0 subscription model reads n/a, not $0.00");
		assert.match(text, /\$\s*2\.00/, "its tokens still price at list rate");
		assert.match(text, /subscription-billed/);
	} finally {
		h.cleanup();
	}
});

test("totals splits by workflow version and labels inferred ones", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full", "--cwd", "/tmp/v3run"], h.io);
		const id = h.out().trim();
		// A craft-plan-* agent dates this run to v3 without any declaration.
		main(["enter", "--run", id, "--phase", "counsel", "--agent", "craft-plan-scope"], h.io);
		main(["totals"], h.io);
		const text = h.out();
		assert.match(text, /CRAFTS v3/);
		assert.match(text, /1 inferred/);
		assert.match(text, /Compare phases by notional, not cost/);
	} finally {
		h.cleanup();
	}
});

test("totals headings name the harness, and host corrects a mislabelled run", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full", "--craft-version", "4"], h.io);
		const id = h.out().trim();
		main(["enter", "--run", id, "--phase", "R", "--agent", "craft-builder"], h.io);
		main(["totals"], h.io);
		assert.match(h.out(), /CRAFTS v4 · unknown/, "a run with no declared host says so");

		assert.equal(main(["host", "--run", id, "--host", "claude-code"], h.io), 0);
		assert.equal(h.events().find((e) => e.t === "host").host, "claude-code");
		main(["totals"], h.io);
		assert.match(h.out(), /CRAFTS v4 · claude-code/);
		assert.match(h.out(), /Compare across hosts by notional or tokens only/);
	} finally {
		h.cleanup();
	}
});

test("doctor names a run that belongs to no harness", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		main(["enter", "--run", id, "--phase", "R"], h.io);
		assert.equal(main(["doctor"], h.io), 1);
		assert.match(h.out(), /unknown-host/);
		assert.match(h.out(), /cannot be compared against pi or claude-code/);
	} finally {
		h.cleanup();
	}
});

test("totals --all blends versions into a single table", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		main(["enter", "--run", id, "--phase", "counsel", "--agent", "craft-plan-scope"], h.io);
		main(["totals", "--all"], h.io);
		assert.ok(!h.out().includes("CRAFTS v"), "the blended table carries no version headings");
	} finally {
		h.cleanup();
	}
});

test("run turns an unexpected store error into exit 2 rather than a stack trace", () => {
	const h = harness();
	try {
		// No such run: the store throws, and `run` is what keeps it off the terminal.
		assert.equal(run(["enter", "--run", "does-not-exist", "--phase", "C"], h.io), 2);
		assert.match(h.err(), /unknown run does-not-exist/);
	} finally {
		h.cleanup();
	}
});

// --- gaps found by mutation testing, not by review ---

test("mtok abbreviates at each magnitude and pads to a fixed width", () => {
	// Boundaries in both directions: the thresholds are `>=`, so the value at the
	// threshold must abbreviate and the one below it must not.
	assert.equal(mtok(999).trim(), "999");
	assert.equal(mtok(1_000).trim(), "1k");
	assert.equal(mtok(999_999).trim(), "1000k", "just under a million still reads in k");
	assert.equal(mtok(1_000_000).trim(), "1.0M");
	assert.equal(mtok(2_500_000).trim(), "2.5M");
	assert.equal(mtok(0).trim(), "0");
	for (const n of [0, 999, 1_000, 1_000_000]) {
		assert.equal(mtok(n).length, 6, `every column is the same width: ${n}`);
	}
});

test("every valid mode and kind is accepted", () => {
	for (const mode of ["full", "hitl", "lite", "dag"]) {
		const h = harness();
		try {
			assert.equal(main(["start", "--kind", "feature", "--mode", mode], h.io), 0, mode);
			assert.equal(h.events().find((e) => e.t === "run_open").mode, mode);
		} finally {
			h.cleanup();
		}
	}
	for (const kind of ["feature", "bugfix", "refactor", "scaffold", "docs", "chore"]) {
		const h = harness();
		try {
			assert.equal(main(["start", "--kind", kind, "--mode", "full"], h.io), 0, kind);
			assert.equal(h.events().find((e) => e.t === "run_open").kind, kind);
		} finally {
			h.cleanup();
		}
	}
});

test("every gateable phase is accepted by enter", () => {
	for (const phase of ["C", "counsel", "R", "A", "F", "T", "S"]) {
		const h = harness();
		try {
			main(["start", "--kind", "feature", "--mode", "full"], h.io);
			const id = h.out().trim();
			assert.equal(main(["enter", "--run", id, "--phase", phase], h.io), 0, phase);
		} finally {
			h.cleanup();
		}
	}
});

test("pause and resume bracket a HITL wait", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "hitl"], h.io);
		const id = h.out().trim();
		assert.equal(main(["pause", "--run", id], h.io), 0);
		assert.equal(main(["resume", "--run", id], h.io), 0);
		const kinds = h.events().map((e) => e.t);
		assert.ok(kinds.includes("hitl_pause") && kinds.includes("hitl_resume"));
	} finally {
		h.cleanup();
	}
});

test("mode and kind can be corrected after start", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		assert.equal(main(["mode", "--run", id, "--mode", "hitl"], h.io), 0);
		assert.equal(main(["kind", "--run", id, "--kind", "bugfix"], h.io), 0);
		const evs = h.events();
		assert.equal(evs.find((e) => e.t === "mode").mode, "hitl");
		assert.equal(evs.find((e) => e.t === "kind").kind, "bugfix");
	} finally {
		h.cleanup();
	}
});

test("end defaults to completed and accepts an explicit outcome", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		assert.equal(main(["end", "--run", id], h.io), 0);
		assert.equal(h.events().find((e) => e.t === "run_end").outcome, "completed");
	} finally {
		h.cleanup();
	}

	const h2 = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h2.io);
		const id = h2.out().trim();
		main(["end", "--run", id, "--outcome", "blocked"], h2.io);
		assert.equal(h2.events().find((e) => e.t === "run_end").outcome, "blocked");
	} finally {
		h2.cleanup();
	}
});

test("usage records tokens, flags, and an explicit phase stamp", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		assert.equal(
			main(
				["usage", "--run", id, "--phase", "A", "--model", "xai/grok-4.6", "--provider", "xai",
					"--input", "100", "--output", "50", "--cache-read", "7", "--cache-write", "3",
					"--cost", "0.25", "--turns", "2", "--tool", "read", "--agent", "craft-evaluator",
					"--subagent", "--quota-error", "--timeout", "--failover", "--blinding-scrubs", "3"],
				h.io,
			),
			0,
		);
		const u = h.events().find((e) => e.t === "usage");
		assert.equal(u.phase, "A");
		assert.deepEqual(u.tokens, { input: 100, output: 50, cacheRead: 7, cacheWrite: 3 });
		assert.equal(u.cost_usd, 0.25);
		assert.equal(u.blinding_scrubs, 3);
		// Presence flags must be booleans, not the string that followed them.
		assert.equal(u.subagent, true);
		assert.equal(u.quota_error, true);
		assert.equal(u.failover, true);
	} finally {
		h.cleanup();
	}
});

test("usage without token flags records zeros rather than NaN", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		main(["usage", "--run", id, "--turns", "1"], h.io);
		const u = h.events().find((e) => e.t === "usage");
		assert.deepEqual(u.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	} finally {
		h.cleanup();
	}
});

test("show --last keeps only the most recent runs", () => {
	const h = harness();
	try {
		const ids: string[] = [];
		for (const cwd of ["/tmp/a", "/tmp/b", "/tmp/c"]) {
			main(["start", "--kind", "feature", "--mode", "full", "--cwd", cwd], h.io);
			ids.push(h.out().trim().split("\n").at(-1)!);
		}
		const before = h.out().length;
		main(["show", "--last", "1"], h.io);
		const shown = h.out().slice(before);
		assert.ok(shown.includes(ids[2].slice(0, 8)), "the newest run is shown");
		assert.ok(!shown.includes(ids[0].slice(0, 8)), "older runs are dropped");
	} finally {
		h.cleanup();
	}
});

test("pin-versions writes nothing without --apply", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		main(["enter", "--run", id, "--phase", "counsel", "--agent", "craft-plan-scope"], h.io);
		assert.equal(main(["pin-versions"], h.io), 0);
		assert.match(h.out(), /would be pinned/);
		assert.equal(h.events().filter((e) => e.t === "craft_version").length, 0, "a dry run must not write");
	} finally {
		h.cleanup();
	}
});

test("pin-versions --apply persists the inference with its provenance", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full"], h.io);
		const id = h.out().trim();
		main(["enter", "--run", id, "--phase", "counsel", "--agent", "craft-plan-scope"], h.io);
		assert.equal(main(["pin-versions", "--apply"], h.io), 0);
		const ev = h.events().filter((e) => e.t === "craft_version");
		assert.equal(ev.length, 1);
		assert.equal(ev[0].craft_version, "3");
		assert.equal(ev[0].source, "inferred");
		assert.match(h.out(), /still marked inferred, not declared/);
	} finally {
		h.cleanup();
	}
});

test("pin-versions leaves declared runs alone and says so when there is nothing to do", () => {
	const h = harness();
	try {
		main(["start", "--kind", "feature", "--mode", "full", "--craft-version", "4"], h.io);
		assert.equal(main(["pin-versions", "--apply"], h.io), 0);
		assert.match(h.out(), /nothing to pin/);
		assert.equal(h.events().filter((e) => e.t === "craft_version").length, 0);
	} finally {
		h.cleanup();
	}
});
