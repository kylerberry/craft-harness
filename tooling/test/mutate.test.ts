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

// --- gaps found by mutation testing, not by review ---

test("a diff exactly at the line cap runs; one line over is skipped", () => {
	// `>` vs `>=` at the boundary. Nothing previously tested the exact limit, so
	// the off-by-one was invisible.
	const at = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,0 +1,100 @@"].join("\n");
	const over = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,0 +1,101 @@"].join("\n");
	for (const [diff, expected] of [
		[at, "ran"],
		[over, "skipped"],
	] as const) {
		const { dir, cleanup } = tmpRepo();
		try {
			writeReport(dir, { files: {}, testFiles: {} });
			const r = runMutate({
				cwd: dir,
				base: "HEAD",
				maxLines: 100,
				gitDiff: () => diff,
				runStryker: () => ({ ok: true, timedOut: false }),
			});
			assert.equal(r.status, expected, `${r.lines_scoped} lines against a cap of 100`);
		} finally {
			cleanup();
		}
	}
});

test("the default excludes drop a test file that lives under src/", () => {
	// The end-to-end fixture used `test/a.test.ts`, which DEFAULT_INCLUDE rejects on
	// its own — so DEFAULT_EXCLUDE was never actually exercised. A test file inside
	// src/ passes the include and can only be dropped by the exclude.
	assert.deepEqual(computeRanges(["--- a/src/a.test.ts", "+++ b/src/a.test.ts", "@@ -1,0 +1,9 @@"].join("\n")), []);
	assert.deepEqual(computeRanges(["--- a/src/a.spec.ts", "+++ b/src/a.spec.ts", "@@ -1,0 +1,9 @@"].join("\n")), []);
});

test("duration is measured forward, not backward", () => {
	const { dir, cleanup } = tmpRepo();
	try {
		writeReport(dir, { files: {}, testFiles: {} });
		const r = runMutate({ cwd: dir, base: "HEAD", gitDiff: () => DIFF, runStryker: () => ({ ok: true, timedOut: false }) });
		// `>= 0` alone proves nothing: adding the two timestamps instead of
		// subtracting them also clears zero. An upper bound is what makes this an
		// assertion about an interval rather than about a number being positive.
		assert.ok(r.duration_ms !== undefined, "duration must be reported");
		assert.ok(r.duration_ms! >= 0 && r.duration_ms! < 60_000, `elapsed ms out of range: ${r.duration_ms}`);
	} finally {
		cleanup();
	}
});

test("a survivor covered by an unknown test id reports no test file rather than undefined", () => {
	const parsed = parseStrykerReport({
		files: { "src/a.ts": { mutants: [{ mutatorName: "M", replacement: "x", status: "Survived", coveredBy: ["99"], location: { start: { line: 5 } } }] } },
		testFiles: { "test/a.test.ts": { tests: [{ id: "0" }] } },
	});
	assert.deepEqual(parsed.survivors[0].covered_by, []);
});

// --- survivor cap: a reviewer gets a list it can actually rule on ---

function reportWith(n: number) {
	return {
		files: {
			"src/a.ts": {
				mutants: Array.from({ length: n }, (_, i) => ({
					mutatorName: "StringLiteral",
					replacement: `"m${i}"`,
					status: "Survived",
					coveredBy: ["0"],
					location: { start: { line: n - i } }, // reverse order, to prove sorting
				})),
			},
		},
		testFiles: { "test/a.test.ts": { tests: [{ id: "0" }] } },
	};
}

test("survivors are capped, and the remainder is counted rather than dropped silently", () => {
	const parsed = parseStrykerReport(reportWith(57), 20);
	assert.equal(parsed.survived, 57, "the true count is still reported");
	assert.equal(parsed.survivors.length, 20);
	assert.equal(parsed.survivors_omitted, 37);
});

test("a list under the cap reports nothing omitted", () => {
	const parsed = parseStrykerReport(reportWith(5), 20);
	assert.equal(parsed.survivors.length, 5);
	assert.equal(parsed.survivors_omitted, 0);
});

test("survivors are sorted by file and line before capping, so the kept set is stable", () => {
	const parsed = parseStrykerReport(reportWith(30), 3);
	assert.deepEqual(parsed.survivors.map((s) => s.line), [1, 2, 3]);
});

test("the cap flows through runMutate into the reported result", () => {
	const { dir, cleanup } = tmpRepo();
	try {
		writeReport(dir, reportWith(25));
		const r = runMutate({ cwd: dir, base: "HEAD", gitDiff: () => DIFF, runStryker: () => ({ ok: true, timedOut: false }) });
		assert.equal(r.survived, 25);
		assert.equal(r.survivors!.length, 20);
		assert.equal(r.survivors_omitted, 5);
	} finally {
		cleanup();
	}
});
