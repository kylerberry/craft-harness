import { test } from "node:test";
import assert from "node:assert/strict";
import { BLIND_TARGETS, scrub, scrubPayload } from "../src/blind.ts";

test("strips phase agent names but keeps the sentence readable", () => {
	const { text, hits } = scrub("craft-builder implemented the retry loop per craft-planner's plan.");
	assert.ok(!text.includes("craft-builder"));
	assert.ok(!text.includes("craft-planner"));
	assert.match(text, /the implementation step implemented the retry loop/);
	assert.deepEqual(hits.sort(), ["craft-builder", "craft-planner"]);
});

test("strips provider-qualified and bare model ids", () => {
	const { text, hits } = scrub("Rendered on zai/glm-5.2, reviewed by grok-4.6.");
	assert.ok(!text.includes("glm-5.2"));
	assert.ok(!text.includes("grok-4.6"));
	assert.equal(text, "Rendered on a model, reviewed by a model.");
	assert.equal(hits.length, 2);
});

test("strips DAG node, branch, and worktree identity", () => {
	const { text } = scrub("[n3] add limiter\nbranch dag/n3 at tmp/worktree-n3");
	assert.ok(!text.includes("[n3]"));
	assert.ok(!text.includes("dag/n3"));
	assert.ok(!text.includes("worktree-n3"));
	assert.match(text, /^add limiter/);
});

test("leaves the reviewer's own name alone — identity is not an authorship leak", () => {
	const { text } = scrub("You are craft-evaluator. craft-builder wrote this.", "craft-evaluator");
	assert.ok(text.includes("craft-evaluator"));
	assert.ok(!text.includes("craft-builder"));
});

test("clean payload is untouched and reports no hits", () => {
	const input = "Assess the change set against the approved plan.";
	const { text, hits } = scrub(input);
	assert.equal(text, input);
	assert.deepEqual(hits, []);
});

test("scrubPayload mutates in place across known fields", () => {
	const input: Record<string, unknown> = {
		agent: "craft-evaluator",
		task: "Review craft-builder's diff on zai/glm-5.2.",
		prompt: "Commit [n7] fix parser",
		unrelated: "craft-builder stays here — not a payload field",
	};
	const hits = scrubPayload(input, "craft-evaluator");
	assert.ok(!String(input.task).includes("craft-builder"));
	assert.ok(!String(input.task).includes("glm-5.2"));
	assert.equal(input.prompt, "Commit fix parser");
	assert.equal(input.unrelated, "craft-builder stays here — not a payload field");
	assert.ok(hits.length >= 3);
});

test("both adversarial reviewers are blind targets; builders are not", () => {
	assert.ok(BLIND_TARGETS.has("craft-evaluator"));
	assert.ok(BLIND_TARGETS.has("craft-security-review"));
	assert.ok(!BLIND_TARGETS.has("craft-builder"));
	assert.ok(!BLIND_TARGETS.has("craft-counsel"));
});
