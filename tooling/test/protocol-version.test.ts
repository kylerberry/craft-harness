import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_CRAFT_VERSION } from "../src/version.ts";

const root = join(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

test("canonical sequences begin D → C under one declared CRAFT version", () => {
	const craft = read("skills/craft/SKILL.md");
	const lite = read("skills/craft-lite/SKILL.md");
	const hitl = read("skills/craft-hitl/SKILL.md");
	assert.match(craft, /^craft-version: "5"$/m);
	assert.equal(CURRENT_CRAFT_VERSION, "5");
	assert.match(craft, /`--craft-version` 5|craft-version 5|--craft-version 5/);
	assert.match(craft, /Every run is `D → C → counsel → R → A → \[F\] → T → S`/);
	assert.match(lite, /`D → C → R → A → \[F\] → S`/);
	assert.match(hitl, /canonical workflow|D → C/);
	assert.match(craft, /### D — Discovery/);
	assert.match(craft, /before C starts|before Conceptualize|immutable packet before C/i);
});

test("Discovery permits only the evidence packet or a structured blocked result", () => {
	const craft = read("skills/craft/SKILL.md");
	assert.match(craft, /versioned evidence packet|immutable evidence packet/);
	assert.match(craft, /structured blocked/);
	assert.match(craft, /unresolved authority|unresolved evidence/i);
	assert.match(craft, /does not plan|must not plan|forbids Discovery from planning|Discovery must not plan/i);
	assert.match(craft, /reinterpreting canonical criteria|reinterpret canonical criteria/i);
	assert.match(craft, /expanding scope|expand scope/i);
	assert.match(craft, /rebuilding Graphify|rebuild Graphify/i);
});

test("README, execute-dag, and metrics docs agree on D before C and version 5", () => {
	const readme = read("README.md");
	const tooling = read("tooling/metrics/README.md");
	const execute = read("skills/execute-dag/SKILL.md");
	assert.match(readme, /D → C → counsel → R → A → \[F\] → T → S/);
	assert.match(readme, /`D → C → R → A → \[F\] → S`/);
	assert.match(readme, /\*\*D\*\*iscovery|D — Discovery/);
	assert.match(execute, /--craft-version 5/);
	assert.match(tooling, /v5|version 5|marks v5/);
});
