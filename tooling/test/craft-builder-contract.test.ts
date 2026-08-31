import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../agents/craft-builder.md", import.meta.url), "utf8");
const [frontmatter = "", body = ""] = source.split("---\n").slice(1);
const outputSection = body.split("# Output\n")[1] ?? "";

const guidanceFields = [
	"tests",
	"implementation_steps",
	"files",
	"verification",
	"scope_guardrails",
	"open_decisions",
	"blockers_or_handoff_notes",
];
const blockedFields = ["missing_evidence_or_decision", "return_to_c", "handoff_reason"];
const terminalTags = ["guidance-report", "blocked"] as const;

function terminalShape(output: string): (typeof terminalTags)[number] | undefined {
	const blocks = [...output.matchAll(/```([^\s`]+)\n([\s\S]*?)```/g)];
	if (blocks.length !== 1 || !terminalTags.includes(blocks[0][1] as (typeof terminalTags)[number])) return undefined;
	const tag = blocks[0][1] as (typeof terminalTags)[number];
	const fields = tag === "guidance-report" ? guidanceFields : blockedFields;
	const report = blocks[0][2];
	if (!fields.every((field) => new RegExp(`^${field}:[^\\S\\r\\n]*\\S`, "m").test(report))) return undefined;
	return tag;
}

test("builder remains a read-only advisor without a completion guard", () => {
	assert.match(frontmatter, /^acceptanceRole: read-only$/m);
	assert.match(frontmatter, /^completionGuard: false$/m);
	assert.deepEqual([...frontmatter.matchAll(/^  - (\w+)$/gm)].map((match) => match[1]), ["read", "grep", "find"]);
	assert.doesNotMatch(frontmatter, /^  - (write|edit|bash)$/m);
});

test("builder prompt declares exactly two terminal shapes and all required fields", () => {
	assert.match(outputSection, /exactly one of two terminal shapes/i);
	assert.match(outputSection, /no third (?:shape|outcome)/i);
	for (const tag of terminalTags) assert.match(outputSection, new RegExp(`\\b${tag}\\b`));
	for (const field of [...guidanceFields, ...blockedFields]) assert.match(outputSection, new RegExp(`\\b${field}\\b`));
	assert.match(outputSection, /turn-health check is not a completion deadline/i);
});

test("terminal fixtures accept only complete guidance-report or blocked shapes", () => {
	const valid = [
		`\`\`\`guidance-report\ntests: test first\nimplementation_steps: minimum change\nfiles: agents/craft-builder.md\nverification: npm test\nscope_guardrails: prompt and tests only\nopen_decisions: none\nblockers_or_handoff_notes: none\n\`\`\``,
		`\`\`\`blocked\nmissing_evidence_or_decision: the plan does not choose the required API\nreturn_to_c: required\nhandoff_reason: C must decide the API before safe guidance is possible\n\`\`\``,
	];
	assert.deepEqual(valid.map(terminalShape), ["guidance-report", "blocked"]);

	const invalid = [
		"",
		"The implementation guidance is ready.",
		"```escalation\nreason: ask someone\n```",
		`${valid[0]}\n${valid[1]}`,
		"```blocked\nmissing_evidence_or_decision:\nreturn_to_c: required\nhandoff_reason: exact evidence is absent\n```",
		"```blocked\nmissing_evidence_or_decision: missing plan evidence\nhandoff_reason: send it back\n```",
		"```guidance-report\ntests: test first\nimplementation_steps: minimum change\nfiles: one file\nverification: npm test\nscope_guardrails: prompt only\nopen_decisions: none\n```",
	];
	assert.deepEqual(invalid.map(terminalShape), invalid.map(() => undefined));
});
