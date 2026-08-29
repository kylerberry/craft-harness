import { test } from "node:test";
import assert from "node:assert/strict";
import {
	countLines,
	filterSourceRanges,
	mergeRanges,
	parseDiffRanges,
	toStrykerMutateArgs,
} from "../src/diff-ranges.ts";

test("parses a normal hunk into an inclusive range", () => {
	const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,3 +10,4 @@", "+one", "+two"].join("\n");
	assert.deepEqual(parseDiffRanges(diff), [{ file: "src/a.ts", start: 10, end: 13 }]);
});

test("an omitted count means exactly one line", () => {
	const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10 +10 @@", "+one"].join("\n");
	assert.deepEqual(parseDiffRanges(diff), [{ file: "src/a.ts", start: 10, end: 10 }]);
});

test("a new file yields a range covering the whole file", () => {
	const diff = ["--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1,50 @@"].join("\n");
	assert.deepEqual(parseDiffRanges(diff), [{ file: "src/new.ts", start: 1, end: 50 }]);
});

test("a pure deletion yields no range — nothing remains to mutate", () => {
	const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,5 +9,0 @@", "-gone"].join("\n");
	assert.deepEqual(parseDiffRanges(diff), []);
});

test("a deleted file yields no range", () => {
	const diff = ["--- a/src/gone.ts", "+++ /dev/null", "@@ -1,20 +0,0 @@"].join("\n");
	assert.deepEqual(parseDiffRanges(diff), []);
});

test("multiple files and hunks are all captured", () => {
	const diff = [
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1,0 +2,1 @@",
		"+x",
		"@@ -20,0 +30,3 @@",
		"+y",
		"--- a/src/b.ts",
		"+++ b/src/b.ts",
		"@@ -5,2 +5,2 @@",
		"+z",
	].join("\n");
	assert.deepEqual(parseDiffRanges(diff), [
		{ file: "src/a.ts", start: 2, end: 2 },
		{ file: "src/a.ts", start: 30, end: 32 },
		{ file: "src/b.ts", start: 5, end: 6 },
	]);
});

test("hunks before any file header are ignored rather than misattributed", () => {
	const diff = ["@@ -1,2 +1,2 @@", "+orphan"].join("\n");
	assert.deepEqual(parseDiffRanges(diff), []);
});

test("filters out test files and anything outside the source globs", () => {
	const ranges = [
		{ file: "src/a.ts", start: 1, end: 2 },
		{ file: "test/a.test.ts", start: 1, end: 2 },
		{ file: "docs/readme.md", start: 1, end: 2 },
	];
	const kept = filterSourceRanges(ranges, { include: [/^src\/.*\.ts$/], exclude: [/\.test\.ts$/] });
	assert.deepEqual(kept, [{ file: "src/a.ts", start: 1, end: 2 }]);
});

test("merges overlapping and abutting ranges, leaves separated ones alone", () => {
	const merged = mergeRanges([
		{ file: "src/a.ts", start: 10, end: 12 },
		{ file: "src/a.ts", start: 13, end: 15 }, // abuts
		{ file: "src/a.ts", start: 14, end: 20 }, // overlaps
		{ file: "src/a.ts", start: 40, end: 41 }, // separate
	]);
	assert.deepEqual(merged, [
		{ file: "src/a.ts", start: 10, end: 20 },
		{ file: "src/a.ts", start: 40, end: 41 },
	]);
});

test("merging keeps files independent", () => {
	const merged = mergeRanges([
		{ file: "src/b.ts", start: 1, end: 2 },
		{ file: "src/a.ts", start: 1, end: 2 },
	]);
	assert.equal(merged.length, 2);
	assert.equal(merged[0].file, "src/a.ts");
});

test("stryker range syntax spans the line inclusively", () => {
	// Column 1 of the line after the range is what makes the last line inclusive.
	assert.deepEqual(toStrykerMutateArgs([{ file: "src/a.ts", start: 70, end: 89 }]), ["src/a.ts:70:1-90:1"]);
});

test("countLines is inclusive of both ends", () => {
	assert.equal(countLines([{ file: "a", start: 10, end: 10 }]), 1);
	assert.equal(countLines([{ file: "a", start: 1, end: 5 }, { file: "b", start: 1, end: 3 }]), 8);
});

// --- gaps found by mutation testing, not by review ---

test("a hunk header with multi-digit counts still parses", () => {
	// `(?:,\d+)?` losing its `+` narrows the old-count to one digit and the whole
	// header stops matching. Every earlier fixture used single-digit old counts,
	// so nothing caught it.
	const diff = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -100,25 +200,30 @@", "+x"].join("\n");
	assert.deepEqual(parseDiffRanges(diff), [{ file: "src/a.ts", start: 200, end: 229 }]);
});

test("a deleted file clears the current file rather than inheriting it", () => {
	// Without matching `+++ /dev/null`, `file` stays pointed at the previous entry
	// and the deleted file's hunks are attributed to it.
	const diff = [
		"--- a/src/kept.ts",
		"+++ b/src/kept.ts",
		"@@ -1,0 +5,2 @@",
		"+x",
		"--- a/src/gone.ts",
		"+++ /dev/null",
		"@@ -1,20 +0,0 @@",
	].join("\n");
	assert.deepEqual(parseDiffRanges(diff), [{ file: "src/kept.ts", start: 5, end: 6 }]);
});

test("include is an any-match, not an all-match", () => {
	// With a single include pattern `some` and `every` behave identically, so a
	// second pattern is what proves the intent.
	const ranges = [{ file: "src/a.ts", start: 1, end: 2 }];
	const kept = filterSourceRanges(ranges, { include: [/^lib\//, /^src\//], exclude: [] });
	assert.deepEqual(kept, ranges, "matching any one include pattern is enough");
});

test("exclude is an any-match: one matching pattern is enough to drop a file", () => {
	const ranges = [{ file: "src/a.test.ts", start: 1, end: 2 }];
	const kept = filterSourceRanges(ranges, {
		include: [/^src\//],
		exclude: [/\.test\.ts$/, /^vendor\//],
	});
	assert.deepEqual(kept, [], "matching one exclude pattern drops it, not all of them");
});

test("ranges arriving out of order are sorted before merging", () => {
	// Earlier fixtures were already ordered, so removing the comparator changed
	// nothing and the mutant lived.
	const merged = mergeRanges([
		{ file: "src/a.ts", start: 40, end: 41 },
		{ file: "src/a.ts", start: 10, end: 12 },
		{ file: "src/a.ts", start: 13, end: 15 },
	]);
	assert.deepEqual(merged, [
		{ file: "src/a.ts", start: 10, end: 15 },
		{ file: "src/a.ts", start: 40, end: 41 },
	]);
});
