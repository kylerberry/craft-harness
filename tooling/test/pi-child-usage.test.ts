import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSubagentUsage } from "../extensions/pi-child-usage.ts";

test("extracts model and tokens from a nested subagent result", () => {
	const got = extractSubagentUsage({
		details: {
			results: [
				{
					model: "zai/glm-5.2",
					usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, cost: 0.05, turns: 3 },
					attemptedModels: ["zai/glm-5.2"],
				},
			],
		},
	});
	assert.equal(got?.model, "zai/glm-5.2");
	assert.equal(got?.provider, "zai");
	assert.equal(got?.turns, 3);
	assert.equal(got?.cost_usd, 0.05);
	assert.deepEqual(got?.tokens, { input: 10, output: 4, cacheRead: 2, cacheWrite: 0 });
	assert.equal(got?.failover, false);
});

test("extracts top-level meta.json shape and flags failover", () => {
	const got = extractSubagentUsage({
		model: "openai-codex/gpt-5.6-sol",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		attemptedModels: ["openai-codex/gpt-5.6-sol", "xai/grok-4.6"],
	});
	assert.equal(got?.model, "openai-codex/gpt-5.6-sol");
	assert.equal(got?.failover, true);
});

test("returns null when the result has no model or usage", () => {
	assert.equal(extractSubagentUsage({ content: "ok" }), null);
	assert.equal(extractSubagentUsage("plain"), null);
});
