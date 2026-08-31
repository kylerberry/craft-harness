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

test("turn health checks do not synthesize a timeout", () => {
	const result = supervisePhase([
		{ type: "tick", turns: 12, tools: 2, atMs: 5_000 },
		{ type: "tick", turns: 24, tools: 8, atMs: 3_600_000 },
	]);
	assert.equal(result.terminal, undefined);
	assert.deepEqual(result.interventions, [
		{ kind: "health-check", observed_turns: 12, observed_tools: 2 },
		{ kind: "health-check", observed_turns: 24, observed_tools: 8 },
	]);
});

test("a timely report produces one terminal result and no intervention", () => {
	const result = supervisePhase([
		{ type: "tick", turns: 2, tools: 1, atMs: 1_000 },
		{ type: "terminal", shape: "report", atMs: 1_500 },
	]);
	assert.deepEqual(result.terminal, { reason: "report" });
	assert.equal(result.interventions.length, 0);
});
