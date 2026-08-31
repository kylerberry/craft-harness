import { test } from "node:test";
import assert from "node:assert/strict";
import { supervisePhase } from "../src/phase-health.ts";

test("an early blocked report produces one terminal result and no intervention", () => {
	const result = supervisePhase([
		{ type: "tick", turns: 3, tools: 4, atMs: 800 },
		{ type: "terminal", shape: "blocked", atMs: 900 },
	]);
	assert.deepEqual(result.terminal, { reason: "blocked" });
	assert.equal(result.interventions.length, 0);
});

test("deadline exhaustion synthesizes one timeout after a single finalization request", () => {
	const result = supervisePhase([
		{ type: "tick", turns: 8, tools: 2, atMs: 5_000 },
		{ type: "tick", turns: 9, tools: 3, atMs: 40_000 },
	]);
	assert.equal(result.terminal.reason, "timeout");
	assert.equal(result.interventions.length, 1);
	assert.equal(result.interventions[0].kind, "finalization-request");
	assert.equal(result.interventions[0].observed_turns, 8);
	assert.equal(result.interventions[0].observed_tools, 2);
});

test("a timely report produces one terminal result and no intervention", () => {
	const result = supervisePhase([
		{ type: "tick", turns: 2, tools: 1, atMs: 1_000 },
		{ type: "terminal", shape: "report", atMs: 1_500 },
	]);
	assert.deepEqual(result.terminal, { reason: "report" });
	assert.equal(result.interventions.length, 0);
});
