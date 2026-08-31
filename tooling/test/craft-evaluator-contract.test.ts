import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const prompt = readFileSync(new URL("../../agents/craft-evaluator.md", import.meta.url), "utf8");
const output = prompt.slice(prompt.indexOf("# Output"));

const assessmentFields = ["verdict", "blocking_findings", "verification_gaps", "non_blocking_rationale"] as const;
const blockedFields = ["status", "missing_evidence", "unresolved_decision"] as const;

type Report = string | Record<string, unknown>;

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

// This reference grammar protects the prompt contract; it is not a claim that
// the host parses or validates evaluator output at runtime.
function acceptsTerminalReport(report: Report): boolean {
	if (typeof report === "string" || Object.keys(report).length === 0) return false;

	const hasAssessmentShape = "verdict" in report;
	const hasBlockedShape = report.status === "blocked";
	if (hasAssessmentShape === hasBlockedShape) return false;

	if (hasAssessmentShape) {
		if (report.verdict !== "pass" && report.verdict !== "needs-fix") return false;
		return assessmentFields.every((field) => field in report && (field === "verdict" || isStringArray(report[field])));
	}

	if (!blockedFields.every((field) => field in report)) return false;
	if (!isStringArray(report.missing_evidence) || !isStringArray(report.unresolved_decision)) return false;
	return [...report.missing_evidence, ...report.unresolved_decision].some((entry) => entry.trim().length > 0);
}

test("the evaluator prompt defines exactly two structured terminal shapes", () => {
	assert.match(output, /exactly one of two terminal shapes/);
	assert.match(output, /Assessment/);
	assert.match(output, /Blocked/);
	for (const field of assessmentFields) assert.match(output, new RegExp(`\\b${field}\\b`));
	for (const field of blockedFields) assert.match(output, new RegExp(`\\b${field}\\b`));
	assert.match(output, /never return an empty response, unstructured prose, or a third terminal shape/i);
	assert.match(output, /exact unavailable artifact/);
	assert.match(output, /exact decision/);
});

test("soft inspection warnings finalize without weakening independent final-diff review", () => {
	assert.match(prompt, /soft inspection warning/);
	assert.match(prompt, /finalize the assessment from the evidence in hand/);
	assert.match(prompt, /never excuses skipping the independent review of the final diff/);
	assert.match(prompt, /Independently review the current diff and evidence/);
	assert.match(prompt, /Your payload is blinded/);
});

test("the terminal grammar accepts both supported shapes", () => {
	const reports: Report[] = [
		{ verdict: "pass", blocking_findings: [], verification_gaps: [], non_blocking_rationale: [] },
		{ verdict: "needs-fix", blocking_findings: ["criterion gap"], verification_gaps: [], non_blocking_rationale: [] },
		{ status: "blocked", missing_evidence: ["final diff: unavailable"], unresolved_decision: [] },
		{ status: "blocked", missing_evidence: [], unresolved_decision: ["release behavior: owner must choose strict or permissive"] },
	];
	for (const report of reports) assert.equal(acceptsTerminalReport(report), true);
});

test("the terminal grammar rejects empty, prose-only, and third shapes", () => {
	const reports: Array<{ name: string; report: Report }> = [
		{ name: "empty", report: {} },
		{ name: "prose-only", report: "Everything looks good." },
		{ name: "blocked verdict", report: { verdict: "blocked", blocking_findings: [], verification_gaps: [], non_blocking_rationale: [] } },
		{ name: "third status", report: { status: "needs-fix", missing_evidence: [], unresolved_decision: ["decision"] } },
		{ name: "mixed", report: { verdict: "pass", status: "blocked", blocking_findings: [], verification_gaps: [], non_blocking_rationale: [], missing_evidence: ["diff"], unresolved_decision: [] } },
	];
	for (const { name, report } of reports) assert.equal(acceptsTerminalReport(report), false, name);
});

test("the terminal grammar rejects incomplete assessment and blocked reports", () => {
	const reports: Report[] = [
		{ verdict: "pass", blocking_findings: [], verification_gaps: [] },
		{ status: "blocked", missing_evidence: [], unresolved_decision: [] },
		{ status: "blocked", missing_evidence: ["   "], unresolved_decision: [] },
	];
	for (const report of reports) assert.equal(acceptsTerminalReport(report), false);
});
