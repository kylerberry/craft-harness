import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { portAgent, renderAgent } from "../src/agent-port.ts";

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents", "node-conductor.md");
const source = readFileSync(sourcePath, "utf8");

test("node-conductor awaits one terminal result and uses health checks without a completion deadline", () => {
	assert.match(source, /^  - subagent_wait$/m);
	assert.match(source, /subagent_wait/);
	assert.match(source, /one awaited terminal result/i);
	assert.doesNotMatch(source, /poll(?:ing)? phase status/i);
	assert.match(source, /health-check/);
	assert.match(source, /Do not impose a wall-clock completion deadline/i);
	assert.match(source, /long no-activity watchdog/i);
	assert.doesNotMatch(source, /short finalization deadline/i);
	assert.match(source, /Claude Code[\s\S]*subagent_wait[\s\S]*unavailab/i);
});

test("node-conductor composes Discovery before C and slices the evidence packet", () => {
	assert.match(source, /D before C|run deterministic D before C|Discovery before C/i);
	assert.match(source, /craft-discover/);
	assert.match(source, /structured blocked/);
	assert.match(source, /packet slices|role-relevant/);
	assert.match(source, /blocking-context/);
	assert.match(source, /Render delta/);
	assert.match(source, /inspect the final diff independently/i);
});

test("node-conductor separates launch defects from the one terminal phase retry", () => {
	assert.match(source, /before.*phase|before.*enter/i);
	assert.match(source, /launch receipt/i);
	assert.match(source, /host-configured fallback chain/i);
	assert.match(source, /Do not select, invent, or pass a model id/);
	assert.match(source, /terminal.*phase failure/i);
	assert.match(source, /launch defects are not that retry/i);
});

test("the generated Claude Code definition stays valid without subagent_wait", () => {
	const ported = portAgent(source);
	assert.equal(ported.name, "node-conductor");
	assert.equal(ported.tools.includes("Agent"), true);
	assert.equal(ported.tools.some((tool) => /wait/i.test(tool)), false);
	assert.match(ported.body, /Claude Code[\s\S]*subagent_wait[\s\S]*unavailab/i);
	assert.match(renderAgent(ported), /^tools: /m);
});
