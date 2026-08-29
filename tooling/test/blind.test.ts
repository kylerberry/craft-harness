import { test } from "node:test";
import assert from "node:assert/strict";
import { BLIND_TARGETS, EXEMPT_OPEN, scrub, scrubPayload, splitExempt, verbatim } from "../src/blind.ts";

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

// --- verbatim exemption: quoted code must survive scrubbing intact ---

test("splitExempt separates prose from marked regions", () => {
	const text = `before ${verbatim("kept")} after`;
	const parts = splitExempt(text);
	assert.deepEqual(parts.map((p) => p.exempt), [false, true, false]);
	assert.equal(parts[0].text, "before ");
	assert.ok(parts[1].text.includes("kept"));
	assert.equal(parts[2].text, " after");
});

test("text with no markers is one scrubbable segment", () => {
	const parts = splitExempt("plain text");
	assert.deepEqual(parts, [{ text: "plain text", exempt: false }]);
});

test("an unclosed marker leaves the remainder verbatim rather than scrubbing it", () => {
	// Failing to scrub is visible in the breach count; wrongly scrubbing a
	// survivor destroys evidence silently, so the safe default is to skip.
	const parts = splitExempt(`prose ${EXEMPT_OPEN} craft-builder wrote this`);
	assert.equal(parts.length, 2);
	assert.equal(parts[0].exempt, false);
	assert.equal(parts[1].exempt, true);
});

test("a mutant replacement naming an agent survives scrubbing intact", () => {
	// The concrete collision: blind.ts itself contains the literal
	// "craft-evaluator", so a StringLiteral mutant of that line quotes it.
	const survivors = verbatim(
		'src/blind.ts:16  StringLiteral  → "craft-evaluator"  covered_by: test/blind.test.ts',
	);
	const input: Record<string, unknown> = {
		agent: "craft-evaluator",
		task: `Assess the change set. craft-builder made it on zai/glm-5.2.\n\nSurvivors:\n${survivors}`,
	};
	const hits = scrubPayload(input, "craft-evaluator");
	const task = String(input.task);
	// Prose is still scrubbed.
	assert.ok(!task.includes("craft-builder"));
	assert.ok(!task.includes("glm-5.2"));
	assert.ok(hits.length >= 2);
	// The quoted mutant is untouched.
	assert.ok(task.includes('→ "craft-evaluator"'), "the survivor's replacement must read exactly as reported");
	assert.ok(task.includes("src/blind.ts:16"));
});

test("an exempt region does not suppress scrubbing of later prose", () => {
	const input: Record<string, unknown> = {
		task: `${verbatim("craft-planner")}\nthen craft-builder on xai/grok-4.6 did the work`,
	};
	scrubPayload(input, "craft-evaluator");
	const task = String(input.task);
	assert.ok(task.includes("craft-planner"), "inside the markers, kept");
	assert.ok(!task.includes("craft-builder"), "outside them, scrubbed");
	assert.ok(!task.includes("grok-4.6"));
});
