import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeRanges, parseStrykerReport, runMutate } from "../src/mutate.ts";

function tmpRepo(withConfig = true): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "craft-mutate-"));
	if (withConfig) writeFileSync(join(dir, "stryker.config.json"), "{}");
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeReport(dir: string, report: unknown): void {
	mkdirSync(join(dir, "reports", "mutation"), { recursive: true });
	writeFileSync(join(dir, "reports", "mutation", "mutation.json"), JSON.stringify(report));
}

const DIFF = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,2 +10,3 @@", "+x"].join("\n");

test("skips silently when the repo has no stryker config", () => {
	const { dir, cleanup } = tmpRepo(false);
	try {
		const r = runMutate({ cwd: dir, base: "HEAD", gitDiff: () => DIFF, runStryker: () => ({ ok: true, timedOut: false }) });
		assert.equal(r.status, "skipped");
		assert.equal(r.reason, "no-backend");
	} finally {
		cleanup();
	}
});

test("skips when the diff touches no source lines", () => {
	const { dir, cleanup } = tmpRepo();
	try {
		const testOnly = ["--- a/test/a.test.ts", "+++ b/test/a.test.ts", "@@ -1,0 +2,3 @@", "+x"].join("\n");
		const r = runMutate({ cwd: dir, base: "HEAD", gitDiff: () => testOnly, runStryker: () => ({ ok: true, timedOut: false }) });
		assert.equal(r.status, "skipped");
		assert.equal(r.reason, "no-changes");
	} finally {
		cleanup();
	}
});

test("skips an oversize diff without running anything", () => {
	const { dir, cleanup } = tmpRepo();
	try {
		let ran = false;
		const big = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,0 +1,5000 @@"].join("\n");
		const r = runMutate({
			cwd: dir,
			base: "HEAD",
			maxLines: 2000,
			gitDiff: () => big,
			runStryker: () => {
				ran = true;
				return { ok: true, timedOut: false };
			},
		});
		assert.equal(r.status, "skipped");
		assert.equal(r.reason, "oversize");
		assert.equal(r.lines_scoped, 5000);
		assert.equal(ran, false, "must not invoke the backend for an oversize diff");
	} finally {
		cleanup();
	}
});

test("reports a timeout as skipped rather than an error", () => {
	const { dir, cleanup } = tmpRepo();
	try {
		const r = runMutate({
			cwd: dir,
			base: "HEAD",
			gitDiff: () => DIFF,
			runStryker: () => ({ ok: false, timedOut: true }),
		});
		assert.equal(r.status, "skipped");
		assert.equal(r.reason, "timeout");
	} finally {
		cleanup();
	}
});

test("errors when the backend ran but produced no report", () => {
	const { dir, cleanup } = tmpRepo();
	try {
		const r = runMutate({
			cwd: dir,
			base: "HEAD",
			gitDiff: () => DIFF,
			runStryker: () => ({ ok: false, timedOut: false, detail: "boom" }),
		});
		assert.equal(r.status, "error");
		assert.equal(r.reason, "failed");
	} finally {
		cleanup();
	}
});

test("parses a real report shape into counts and survivors", () => {
	const { dir, cleanup } = tmpRepo();
	try {
		writeReport(dir, {
			files: {
				"src/a.ts": {
					mutants: [
						{ mutatorName: "ConditionalExpression", replacement: "false", status: "Killed", coveredBy: ["0"], location: { start: { line: 12 } } },
						{ mutatorName: "StringLiteral", replacement: '""', status: "Survived", coveredBy: ["0"], location: { start: { line: 59 } } },
						{ mutatorName: "BlockStatement", replacement: "{}", status: "NoCoverage", location: { start: { line: 80 } } },
						{ mutatorName: "ArithmeticOperator", replacement: "-", status: "Timeout", coveredBy: ["0"], location: { start: { line: 90 } } },
					],
				},
			},
			testFiles: { "test/a.test.ts": { tests: [{ id: "0", name: "does a thing" }] } },
		});
		const r = runMutate({ cwd: dir, base: "HEAD", gitDiff: () => DIFF, runStryker: () => ({ ok: true, timedOut: false }) });
		assert.equal(r.status, "ran");
		assert.equal(r.backend, "stryker");
		assert.equal(r.tested, 4);
		assert.equal(r.killed, 2, "a timeout counts as killed — behaviour changed detectably");
		assert.equal(r.survived, 1);
		assert.equal(r.no_coverage, 1);
		assert.deepEqual(r.survivors, [
			{ file: "src/a.ts", line: 59, mutator: "StringLiteral", replacement: '""', covered_by: ["test/a.test.ts"] },
		]);
	} finally {
		cleanup();
	}
});

test("statuses that say nothing about test quality are excluded from the count", () => {
	const parsed = parseStrykerReport({
		files: {
			"src/a.ts": {
				mutants: [
					{ mutatorName: "M", replacement: "x", status: "CompileError", location: { start: { line: 1 } } },
					{ mutatorName: "M", replacement: "x", status: "Ignored", location: { start: { line: 2 } } },
					{ mutatorName: "M", replacement: "x", status: "Killed", location: { start: { line: 3 } } },
				],
			},
		},
	});
	assert.equal(parsed.tested, 1);
	assert.equal(parsed.killed, 1);
});

test("a survivor nothing covered reports an empty test list, not a missing field", () => {
	const parsed = parseStrykerReport({
		files: { "src/a.ts": { mutants: [{ mutatorName: "M", replacement: "x", status: "Survived", location: { start: { line: 5 } } }] } },
	});
	assert.deepEqual(parsed.survivors[0].covered_by, []);
});

test("computeRanges merges and filters end to end", () => {
	const diff = [
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1,0 +10,2 @@",
		"+x",
		"@@ -1,0 +12,2 @@",
		"+y",
		"--- a/test/a.test.ts",
		"+++ b/test/a.test.ts",
		"@@ -1,0 +1,9 @@",
		"+z",
	].join("\n");
	assert.deepEqual(computeRanges(diff), [{ file: "src/a.ts", start: 10, end: 13 }]);
});

test("an untracked source file is scoped in full — git diff cannot see it", () => {
	const { dir, cleanup } = tmpRepo();
	try {
		writeReport(dir, { files: {}, testFiles: {} });
		let mutateArgs: string[] = [];
		const r = runMutate({
			cwd: dir,
			base: "HEAD",
			gitDiff: () => "", // a brand-new file produces no diff output at all
			untracked: () => [
				{ file: "src/brand-new.ts", lines: 40 },
				{ file: "test/brand-new.test.ts", lines: 20 }, // excluded: it is a test
				{ file: "README.md", lines: 10 }, // excluded: not source
			],
			runStryker: (_d, args) => {
				mutateArgs = args;
				return { ok: true, timedOut: false };
			},
		});
		assert.equal(r.status, "ran");
		assert.equal(r.lines_scoped, 40);
		assert.deepEqual(mutateArgs, ["src/brand-new.ts:1:1-41:1"]);
	} finally {
		cleanup();
	}
});

test("an empty untracked file scopes nothing rather than an invalid range", () => {
	assert.deepEqual(computeRanges("", [{ file: "src/empty.ts", lines: 0 }]), []);
});

test("tracked edits and new files combine into one scope", () => {
	const ranges = computeRanges(DIFF, [{ file: "src/new.ts", lines: 5 }]);
	assert.deepEqual(ranges, [
		{ file: "src/a.ts", start: 10, end: 12 },
		{ file: "src/new.ts", start: 1, end: 5 },
	]);
});
