import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const plannerPrompt = await readFile(new URL("../../agents/craft-planner.md", import.meta.url), "utf8");
const outputSection = plannerPrompt.slice(plannerPrompt.indexOf("# Output"));

type TerminalOutput = Record<string, unknown> | string | null;

const REPORT_FIELDS = [
	"status",
	"scope",
	"acceptance_criteria",
	"criteria_provenance",
	"afk_hitl_status",
	"files",
	"test_strategy",
	"risks",
	"render_plan",
	"blocking_questions",
	"security_triggers",
	"trust_boundaries",
] as const;

function isPlannerTerminalOutput(value: TerminalOutput): boolean {
	if (value === null || typeof value === "string" || Array.isArray(value)) return false;
	if (value.status === "blocked") {
		return Array.isArray(value.missing_requirements) && value.missing_requirements.length > 0;
	}
	if (typeof value.status !== "string" || value.status.length === 0) return false;
	return REPORT_FIELDS.every((field) => field in value);
}

test("planner defines report and blocked as its only terminal shapes", () => {
	assert.match(plannerPrompt, /exactly one of two terminal shapes/i);
	assert.match(plannerPrompt, /There is no third terminal shape/i);
	for (const field of REPORT_FIELDS) {
		assert.match(outputSection, new RegExp("`" + field + "`"));
	}
	assert.match(outputSection, /`status: blocked`[\s\S]*`missing_requirements`/);
});

test("planner finalizes from current evidence after a soft inspection warning", () => {
	assert.match(plannerPrompt, /soft inspection warning[\s\S]*finalize immediately from the current evidence/i);
	assert.match(plannerPrompt, /Do not continue inspecting indefinitely/i);
});

test("planner contract accepts only complete report or blocked shapes", () => {
	const report: Record<string, unknown> = Object.fromEntries(REPORT_FIELDS.map((f) => [f, f === "status" ? "ok" : []]));
	assert.equal(isPlannerTerminalOutput(report), true);
	assert.equal(isPlannerTerminalOutput({ status: "blocked", missing_requirements: ["exact missing criterion"] }), true);

	const invalid: TerminalOutput[] = [
		null,
		"",
		"The plan is ready.",
		{},
		{ status: "blocked" },
		{ status: "blocked", missing_requirements: [] },
		{ status: "escalate", reason: "third shape" },
		{ status: "ok", scope: [] },
	];
	for (const fixture of invalid) assert.equal(isPlannerTerminalOutput(fixture), false);
});

test("planner keeps completionGuard disabled for the read-only role", () => {
	assert.match(plannerPrompt, /^completionGuard: false$/m);
	assert.match(outputSection, /Pi's completion guard checks implementation mutation/i);
});
