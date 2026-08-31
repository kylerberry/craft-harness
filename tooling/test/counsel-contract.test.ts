import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

const counselPrompt = await readFile(new URL("../../agents/craft-counsel.md", import.meta.url), "utf8");
const outputSection = counselPrompt.slice(counselPrompt.indexOf("# Output"));

type TerminalOutput = Record<string, unknown> | string | null;

function isCounselTerminalOutput(value: TerminalOutput): boolean {
	if (value === null || typeof value === "string" || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	if (keys.length === 0) return false;

	if (value.status === "pass" || value.status === "needs-replan") {
		return Array.isArray(value.findings) && Array.isArray(value.residual_risks);
	}
	if (value.status === "blocked") {
		return (
			Array.isArray(value.missing_required_input) &&
			value.missing_required_input.length > 0 &&
			typeof value.unblock_requirement === "string" &&
			value.unblock_requirement.length > 0 &&
			Array.isArray(value.reviewed_so_far)
		);
	}
	return false;
}

test("counsel defines report and blocked as its only terminal shapes", () => {
	assert.match(outputSection, /exactly one of two terminal shapes/i);
	assert.match(
		outputSection,
		/\*\*Report\*\*.*required fields:[\s\S]*`status: pass \| needs-replan`[\s\S]*`findings`[\s\S]*`residual_risks`/i,
	);
	assert.match(
		outputSection,
		/\*\*Blocked\*\*.*required fields:[\s\S]*`status: blocked`[\s\S]*`missing_required_input`[\s\S]*`unblock_requirement`[\s\S]*`reviewed_so_far`/i,
	);
	assert.match(outputSection, /`probe_required` is a finding field, never a status/i);
});

test("counsel treats a turn-health check as a check-in, not a completion deadline", () => {
	assert.match(outputSection, /turn-health check[\s\S]*not a completion deadline/i);
	assert.match(outputSection, /next concrete inspection action/i);
	assert.match(outputSection, /do not guess/i);
	assert.match(outputSection, /use the blocked shape only when required input/i);
});

test("terminal fixtures accept only complete report or blocked shapes", () => {
	const valid: TerminalOutput[] = [
		{ status: "pass", findings: [], residual_risks: [] },
		{
			status: "blocked",
			missing_required_input: ["repository evidence for the named API"],
			unblock_requirement: "supply the API definition",
			reviewed_so_far: ["scope mapping"],
		},
	];
	const invalid: TerminalOutput[] = [
		{},
		"The plan looks good overall.",
		{ status: "probe_required", hypothesis: "the API may exist" },
	];

	for (const fixture of valid) assert.equal(isCounselTerminalOutput(fixture), true);
	for (const fixture of invalid) assert.equal(isCounselTerminalOutput(fixture), false);
});

test("counsel retains its lenses and one-pass gate semantics", () => {
	assert.match(counselPrompt, /One reviewer, one pass, three lenses/);
	for (const lens of ["Feasibility", "Coherence", "Scope", "Security — only when `security_triggers` is non-empty"]) {
		assert.match(counselPrompt, new RegExp(`\\*\\*${lens.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\*\\*`));
	}
	assert.match(counselPrompt, /use `needs-replan` when any finding blocks/i);
});
