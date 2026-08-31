import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { portAgent, renderAgent } from "../src/agent-port.ts";

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents", "node-conductor.md");
const source = readFileSync(sourcePath, "utf8");

test("node-conductor awaits one terminal result through subagent_wait", () => {
	assert.match(source, /^  - subagent_wait$/m);
	assert.match(source, /subagent_wait/);
	assert.match(source, /one awaited terminal result/i);
	assert.doesNotMatch(source, /poll(?:ing)? phase status/i);
	assert.match(source, /finalization-request/);
	assert.match(source, /without disabling inspection tools/i);
	assert.match(source, /timeout|blocked/i);
	assert.match(source, /Claude Code[\s\S]*subagent_wait[\s\S]*unavailab/i);
});

test("the generated Claude Code definition stays valid without subagent_wait", () => {
	const ported = portAgent(source);
	assert.equal(ported.name, "node-conductor");
	assert.equal(ported.tools.includes("Agent"), true);
	assert.equal(ported.tools.some((tool) => /wait/i.test(tool)), false);
	assert.match(ported.body, /Claude Code[\s\S]*subagent_wait[\s\S]*unavailab/i);
	assert.match(renderAgent(ported), /^tools: /m);
});
