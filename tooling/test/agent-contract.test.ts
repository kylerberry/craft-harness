import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { portAgent } from "../src/agent-port.ts";

const promptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agents", "craft-security-review.md");
const prompt = portAgent(readFileSync(promptPath, "utf8")).body;

test("security review declares exactly two terminal shapes with required fields", () => {
	assert.match(prompt, /exactly one of two terminal shapes/i);
	assert.match(prompt, /`security-report`[\s\S]*`terminal: security-report`/);
	assert.match(prompt, /`security-report`[\s\S]*`mode: tighten`[\s\S]*`status: passed \| needs-fix`/);
	for (const field of ["trust_boundaries_reviewed", "blocking_findings", "non_blocking_findings", "residual_risk"]) {
		assert.match(prompt, new RegExp("`" + field + "`"));
	}
	assert.match(prompt, /`blocked`[\s\S]*`terminal: blocked`[\s\S]*`mode: tighten`[\s\S]*`status: blocked`/);
	assert.match(prompt, /`blocked`[\s\S]*`missing_requirements`[\s\S]*exact missing evidence or decision/i);
	assert.match(prompt, /There is no third terminal shape/i);
});

test("soft inspection warnings require finalization without weakening review", () => {
	assert.match(prompt, /soft inspection warning[\s\S]*stop further inspection[\s\S]*finalize[\s\S]*current evidence/i);
	assert.match(prompt, /Independently review the final changed surface/);
	assert.match(prompt, /Your payload is blinded/);
	assert.match(
		prompt,
		/Map each declared C trust boundary to implementation evidence, a P0 finding, or explicit non-applicability\./,
	);
});

type TerminalOutput = Record<string, unknown> | string | null;

function isTerminalOutput(output: TerminalOutput): boolean {
	if (output === null || typeof output !== "object") return false;
	if (output.terminal === "security-report") {
		return (
			output.mode === "tighten" &&
			(output.status === "passed" || output.status === "needs-fix") &&
			Array.isArray(output.trust_boundaries_reviewed) &&
			Array.isArray(output.blocking_findings) &&
			Array.isArray(output.non_blocking_findings) &&
			typeof output.residual_risk === "string"
		);
	}
	if (output.terminal === "blocked") {
		return (
			output.mode === "tighten" &&
			output.status === "blocked" &&
			Array.isArray(output.trust_boundaries_reviewed) &&
			Array.isArray(output.missing_requirements) &&
			output.missing_requirements.length > 0 &&
			output.missing_requirements.every((item) => typeof item === "string" && item.trim().length > 0)
		);
	}
	return false;
}

const validSecurityReport = {
	terminal: "security-report",
	mode: "tighten",
	status: "passed",
	trust_boundaries_reviewed: [],
	blocking_findings: [],
	non_blocking_findings: [],
	residual_risk: "none",
};

const validBlockedReport = {
	terminal: "blocked",
	mode: "tighten",
	status: "blocked",
	trust_boundaries_reviewed: [],
	missing_requirements: ["Decision required: whether credential rotation is in scope."],
};

test("security review contract accepts only its two complete terminal shapes", () => {
	assert.equal(isTerminalOutput(validSecurityReport), true);
	assert.equal(isTerminalOutput(validBlockedReport), true);

	for (const invalid of [
		"",
		"The review looks safe.",
		{ terminal: "deferred", status: "waiting" },
		{ ...validSecurityReport, trust_boundaries_reviewed: undefined },
		{ ...validBlockedReport, missing_requirements: [] },
	]) {
		assert.equal(isTerminalOutput(invalid), false);
	}
});
