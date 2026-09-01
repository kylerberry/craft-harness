import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { portAgent, renderAgent } from "../src/agent-port.ts";

const sourcePath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents", "craft-node-writer.md");
const source = readFileSync(sourcePath, "utf8");

test("craft-node-writer is a sole writer with no subagent fanout", () => {
	assert.match(source, /^  - write$/m);
	assert.match(source, /^  - edit$/m);
	assert.match(source, /^  - bash$/m);
	assert.doesNotMatch(source, /^  - subagent$/m);
	assert.doesNotMatch(source, /subagent_wait/);
	assert.match(source, /Do not spawn|you do not spawn/i);
	assert.match(source, /\[n3\]/);
	assert.match(source, /Simplify the Render diff yourself/);
});

test("the generated Claude Code definition keeps write tools and drops nothing required", () => {
	const ported = portAgent(source);
	assert.equal(ported.name, "craft-node-writer");
	assert.equal(ported.tools.includes("Write"), true);
	assert.equal(ported.tools.includes("Edit"), true);
	assert.equal(ported.tools.includes("Bash"), true);
	assert.equal(ported.tools.some((tool) => /agent/i.test(tool)), false);
	assert.match(renderAgent(ported), /^tools: /m);
});
