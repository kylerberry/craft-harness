import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, diagnose, fmtSeam, fmtTokens, pushUnique, summarize } from "../src/store.ts";
import type { PriceTable } from "../src/pricing.ts";

/**
 * The reporting half of the store: what a run looks like when it is read back.
 * These were the least-covered functions in the repo, because the existing tests
 * asserted on folded data structures and only loosely matched the rendered text —
 * so every formatting branch was reachable but unverified.
 */

function tmpStore(prices: PriceTable = new Map()): { store: Store; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "craft-fmt-"));
	return {
		store: new Store(join(dir, "events.jsonl"), prices),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

// --- small helpers ---

test("pushUnique ignores empties and never duplicates", () => {
	const list: string[] = [];
	pushUnique(list, "a");
	pushUnique(list, "a");
	pushUnique(list, "b");
	pushUnique(list, undefined);
	pushUnique(list, "");
	assert.deepEqual(list, ["a", "b"]);
});

test("fmtSeam distinguishes unknown from failed", () => {
	// `?` and `NO` mean very different things: nothing measured versus measured
	// and the same family on both sides.
	assert.equal(fmtSeam(null), "?");
	assert.equal(fmtSeam(true), "yes");
	assert.equal(fmtSeam(false), "NO");
});

test("fmtTokens abbreviates by magnitude and collapses an empty phase to a dash", () => {
	assert.equal(fmtTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), "-");
	assert.equal(fmtTokens({ input: 999, output: 0, cacheRead: 0, cacheWrite: 0 }), "999in/0out/0cache");
	assert.equal(fmtTokens({ input: 1_000, output: 2_500_000, cacheRead: 1_500, cacheWrite: 0 }), "1kin/2.5Mout/2kcache");
	// cacheWrite counts toward "is this empty" even though it is not displayed.
	assert.equal(fmtTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 5 }), "0in/0out/0cache");
});

// --- summarize ---

test("summarize says so plainly when there is nothing to show", () => {
	assert.equal(summarize([]), "no craft runs recorded");
});

test("summarize renders the run header with version, kind, mode and outcome", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/p", repo: "demo", mode: "full", kind: "bugfix", craft_version: "4" });
		s.endRun(run.run_id, "completed");
		const text = summarize(s.loadAll());
		assert.match(text, new RegExp(`^${run.run_id.slice(0, 8)}  v4  bugfix`));
		assert.match(text, /completed/);
		assert.match(text, /pi  demo$/m);
	} finally {
		cleanup();
	}
});

test("an inferred version is marked, a declared one is not", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const inferred = s.openRun({ host: "pi", cwd: "/tmp/i", repo: "i", mode: "full" });
		s.enterPhase(inferred.run_id, "counsel", { agent: "craft-plan-scope" });
		assert.match(summarize(s.loadAll()), /v3~/, "inference carries a tilde");

		const declared = s.openRun({ host: "pi", cwd: "/tmp/d", repo: "d", mode: "full", craft_version: "4" });
		void declared;
		const text = summarize(s.loadAll());
		assert.ok(text.includes(" v4 "), "a declaration has no tilde");
	} finally {
		cleanup();
	}
});

test("a run with no version at all renders v?", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		s.openRun({ host: "pi", cwd: "/tmp/u", repo: "u", mode: "full" });
		assert.match(summarize(s.loadAll()), /v\?/);
	} finally {
		cleanup();
	}
});

test("a subscription phase shows its notional value beside a $0 actual", () => {
	const prices: PriceTable = new Map([["openai-codex/gpt-5.6-terra", { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }]]);
	const { store: s, cleanup } = tmpStore(prices);
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/n", repo: "n", mode: "full" });
		s.enterPhase(run.run_id, "R");
		s.recordUsage(run.run_id, { model: "openai-codex/gpt-5.6-terra", cost_usd: 0, tokens: { input: 1_000_000 }, turns: 1 });
		const text = summarize(s.loadAll());
		assert.match(text, /\$0 \(~\$2\.0000\)/, "$0 paid, priced notionally");
		assert.match(text, /\(notional \$2\.0000\)/, "and rolled into the run header");
	} finally {
		cleanup();
	}
});

test("a phase with tokens but no price at all reads n/a rather than $0", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/na", repo: "na", mode: "full" });
		s.enterPhase(run.run_id, "R");
		s.recordUsage(run.run_id, { model: "unknown/model", cost_usd: 0, tokens: { input: 5000 }, turns: 1 });
		assert.match(summarize(s.loadAll()), /\$ +n\/a/);
	} finally {
		cleanup();
	}
});

test("an ungated run is called out, and a gated one is not", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const bare = s.openRun({ host: "pi", cwd: "/tmp/bare", repo: "bare", mode: "full" });
		void bare;
		assert.match(summarize(s.loadAll()), /! ungated/);

		const gated = s.openRun({ host: "pi", cwd: "/tmp/gated", repo: "gated", mode: "full" });
		s.enterPhase(gated.run_id, "C");
		const onlyGated = summarize(s.loadAll().filter((r) => r.run_id === gated.run_id));
		assert.ok(!onlyGated.includes("ungated"));
	} finally {
		cleanup();
	}
});

test("verify state renders green or red with the command and a count", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/v", repo: "v", mode: "full" });
		s.recordVerify(run.run_id, "npm test", 0);
		assert.match(summarize(s.loadAll()), /verify green {2}`npm test` {2}×1/);
		s.recordVerify(run.run_id, "npm test", 3);
		assert.match(summarize(s.loadAll()), /verify RED \(exit 3\) {2}`npm test` {2}×2/);
	} finally {
		cleanup();
	}
});

test("a run that never verified prints no verify line at all", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		s.openRun({ host: "pi", cwd: "/tmp/nv", repo: "nv", mode: "full" });
		assert.ok(!summarize(s.loadAll()).includes("verify"));
	} finally {
		cleanup();
	}
});

test("blinding scrubs and backfilled cost annotate the phase line only when nonzero", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/b", repo: "b", mode: "full" });
		s.enterPhase(run.run_id, "A");
		s.recordUsage(run.run_id, { blinding_scrubs: 2, turns: 1 });
		assert.match(summarize(s.loadAll()), /\(blinded 2\)/);

		const clean = s.openRun({ host: "pi", cwd: "/tmp/b2", repo: "b2", mode: "full" });
		s.enterPhase(clean.run_id, "A");
		s.recordUsage(clean.run_id, { turns: 1 });
		const onlyClean = summarize(s.loadAll().filter((r) => r.run_id === clean.run_id));
		assert.ok(!onlyClean.includes("blinded"));
	} finally {
		cleanup();
	}
});

test("the empty unattributed bucket is hidden, a funded one is shown", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const quiet = s.openRun({ host: "pi", cwd: "/tmp/q", repo: "q", mode: "full" });
		s.enterPhase(quiet.run_id, "C");
		s.exitPhase(quiet.run_id, "C");
		assert.ok(!summarize(s.loadAll()).includes("unattributed"));

		const leaky = s.openRun({ host: "pi", cwd: "/tmp/l", repo: "l", mode: "full" });
		s.recordUsage(leaky.run_id, { cost_usd: 1, turns: 1 });
		assert.match(summarize(s.loadAll()), /unattributed/);
	} finally {
		cleanup();
	}
});

// --- diagnose ---

test("doctor is silent on a healthy run", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/ok", repo: "ok", mode: "full" });
		s.enterPhase(run.run_id, "C");
		s.recordUsage(run.run_id, { model: "zai/glm-5.2", cost_usd: 0.1, tokens: { input: 10 }, turns: 1 });
		s.exitPhase(run.run_id, "C");
		s.endRun(run.run_id, "completed");
		assert.deepEqual(diagnose(s.loadAll()), []);
	} finally {
		cleanup();
	}
});

test("the stale threshold is honoured in both directions", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/s", repo: "s", mode: "full", at: "2026-04-08T00:00:00.000Z" });
		s.enterPhase(run.run_id, "C", { at: "2026-04-08T00:01:00.000Z" });
		const now = Date.parse("2026-04-08T13:00:00.000Z"); // 13h later
		assert.ok(diagnose(s.loadAll(), now, 12).some((c) => c.kind === "stale-open"), "13h beats a 12h threshold");
		assert.ok(!diagnose(s.loadAll(), now, 14).some((c) => c.kind === "stale-open"), "and not a 14h one");
	} finally {
		cleanup();
	}
});

test("a closed run is never stale however old", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/c", repo: "c", mode: "full", at: "2020-01-01T00:00:00.000Z" });
		s.enterPhase(run.run_id, "C");
		s.endRun(run.run_id, "completed");
		assert.ok(!diagnose(s.loadAll(), Date.now(), 1).some((c) => c.kind === "stale-open"));
	} finally {
		cleanup();
	}
});

test("the unattributed complaint reports a share of total spend", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/u", repo: "u", mode: "full" });
		s.enterPhase(run.run_id, "C");
		s.recordUsage(run.run_id, { cost_usd: 1, turns: 1 });
		s.exitPhase(run.run_id, "C");
		s.recordUsage(run.run_id, { cost_usd: 3, turns: 1 }); // lands unattributed
		const c = diagnose(s.loadAll()).find((x) => x.kind === "unattributed");
		assert.ok(c, "expected an unattributed complaint");
		assert.match(c!.detail, /75%/, "3 of 4 dollars outside any phase");
	} finally {
		cleanup();
	}
});

test("no unattributed complaint when everything landed on a phase", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/all", repo: "all", mode: "full" });
		s.enterPhase(run.run_id, "C");
		s.recordUsage(run.run_id, { cost_usd: 2, turns: 1 });
		assert.ok(!diagnose(s.loadAll()).some((c) => c.kind === "unattributed"));
	} finally {
		cleanup();
	}
});

test("complaints carry the run's cost so the expensive ones can be ranked first", () => {
	const { store: s, cleanup } = tmpStore();
	try {
		const run = s.openRun({ host: "pi", cwd: "/tmp/rank", repo: "rank", mode: "full" });
		s.recordUsage(run.run_id, { cost_usd: 12.5, turns: 1 });
		const c = diagnose(s.loadAll()).find((x) => x.kind === "ungated");
		assert.equal(c!.cost_usd, 12.5);
	} finally {
		cleanup();
	}
});
