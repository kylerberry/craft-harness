import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { handleLaunch, modelForAttempt, phaseRetry } from "../src/phase-launch.ts";

function tmp() {
	const dir = mkdtempSync(join(tmpdir(), "craft-launch-"));
	return { dir, store: new Store(join(dir, "events.jsonl"), new Map()), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const routes = {
	"craft-planner": { model: "openai-codex/gpt-5.6-sol", fallbackModels: ["moonshot/kimi-k3"] },
};

test("timeout and model failure retry the same role through host fallbacks only", () => {
	assert.equal(modelForAttempt("craft-planner", routes, 0), "openai-codex/gpt-5.6-sol");
	assert.equal(modelForAttempt("craft-planner", routes, 1), "moonshot/kimi-k3");
	assert.equal(modelForAttempt("craft-planner", routes, 2), undefined);
	assert.throws(() => modelForAttempt("craft-planner", routes, 0, "xai/grok-4.3"), /must not select a model/);
});

test("the one-retry limit applies to terminal phase failures, not launch defects", () => {
	assert.deepEqual(phaseRetry({ used: 0, kind: "orchestration" }), { action: "relaunch", retryConsumed: false });
	assert.deepEqual(phaseRetry({ used: 0, kind: "terminal" }), { action: "retry", retryConsumed: true });
	assert.deepEqual(phaseRetry({ used: 1, kind: "terminal" }), { action: "blocked", retryConsumed: false });
	assert.deepEqual(phaseRetry({ used: 1, kind: "orchestration" }), { action: "relaunch", retryConsumed: false });
});

test("orchestration defects record before phase_enter and do not consume the phase retry", () => {
	const { store, cleanup } = tmp();
	try {
		const run = store.openRun({ host: "pi", cwd: "/tmp/demo", repo: "demo", mode: "full" });
		const fail = handleLaunch(store, run.run_id, "C", "craft-planner", {
			kind: "orchestration-failure",
			failureKind: "dispatch",
			evidence: "worker launch rejected",
		});
		assert.equal(fail.entered, false);
		assert.equal(fail.awaitTerminal, false);
		assert.equal(fail.retryConsumed, false);
		const afterFail = store.get(run.run_id)!;
		assert.equal(afterFail.phase_entries, 0);
		assert.equal(afterFail.open_phase, null);
		assert.equal(afterFail.orchestration_failures[0]?.kind, "dispatch");

		const ok = handleLaunch(store, run.run_id, "C", "craft-planner", { kind: "receipt", launchId: "launch-1" });
		assert.equal(ok.entered, true);
		assert.equal(ok.awaitTerminal, true);
		assert.equal(ok.retryConsumed, false);
		const afterOk = store.get(run.run_id)!;
		assert.equal(afterOk.phase_entries, 1);
		assert.equal(afterOk.open_phase, "C");
		assert.equal(afterOk.phases.find((p) => p.name === "C")?.cycles, 1);
	} finally {
		cleanup();
	}
});
