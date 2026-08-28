import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	countLines,
	filterSourceRanges,
	mergeRanges,
	parseDiffRanges,
	toStrykerMutateArgs,
	type LineRange,
} from "./diff-ranges.ts";

/**
 * Mutation testing scoped to what Render actually changed.
 *
 * Coverage answers "did anything execute this line". It cannot answer "does any
 * test *object* when this line is wrong" — a loosened matcher or a fixture edited
 * to match wrong output keeps coverage at 100%. That gap is the failure mode A
 * spends turns hunting by reading, and mutation answers it mechanically.
 *
 * This is a signal, not a gate. A survived mutant is sometimes an equivalent
 * mutant — semantically identical, unkillable, and correctly ignored. Deciding
 * which is which is a judgment, so survivors are handed to the reviewer to
 * adjudicate rather than blocking the phase.
 */

export type MutateStatus = "ran" | "skipped" | "error";

export interface Survivor {
	file: string;
	line: number;
	mutator: string;
	replacement: string;
	/** Test files that executed this line and still passed. Empty means nothing covered it. */
	covered_by: string[];
}

export interface MutateResult {
	status: MutateStatus;
	/** Why nothing ran. Absent when `status` is "ran". */
	reason?: "no-backend" | "no-changes" | "oversize" | "timeout" | "failed";
	backend?: "stryker";
	tested?: number;
	killed?: number;
	survived?: number;
	no_coverage?: number;
	/** Capped at `SURVIVOR_LIMIT`; `survivors_omitted` says how many were dropped. */
	survivors?: Survivor[];
	/**
	 * Survivors beyond the cap. Always reported, never silent: a truncated list
	 * that looks complete would tell a reviewer the diff is cleaner than it is.
	 */
	survivors_omitted?: number;
	lines_scoped?: number;
	duration_ms?: number;
	detail?: string;
}

/**
 * How many survivors to hand a reviewer.
 *
 * The point of this signal is to replace a reading pass, not to relocate it. A
 * real diff can produce dozens of survivors — 57 on a 302-line change in this
 * repo — and adjudicating that many costs more than the hunting it displaces.
 * Twenty is a list a reviewer can actually rule on; the rest are counted.
 */
export const SURVIVOR_LIMIT = 20;

/** Stryker's JSON report, narrowed to the fields consumed here. */
interface StrykerReport {
	files: Record<string, { mutants: Array<{ mutatorName: string; replacement: string; status: string; coveredBy?: string[]; location: { start: { line: number } } }> }>;
	testFiles?: Record<string, { tests: Array<{ id: string; name?: string }> }>;
}

export const DEFAULT_TIMEOUT_SEC = 60;
const REPORT_PATH = join("reports", "mutation", "mutation.json");

/** Source globs to mutate, and the test patterns to keep out of the mutation set. */
export const DEFAULT_INCLUDE = [/^src\/.*\.(ts|tsx|js|jsx|mjs|cjs)$/];
export const DEFAULT_EXCLUDE = [/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/, /^test\//, /^tests\//, /^__tests__\//];

/**
 * Map Stryker test ids back to the files that own them. Survivors are far more
 * actionable when the reviewer can see which suite ran and still passed.
 */
function testFileById(report: StrykerReport): Map<string, string> {
	const map = new Map<string, string>();
	for (const [file, entry] of Object.entries(report.testFiles ?? {})) {
		for (const t of entry.tests ?? []) map.set(t.id, file);
	}
	return map;
}

export function parseStrykerReport(
	report: StrykerReport,
	limit = SURVIVOR_LIMIT,
): {
	tested: number;
	killed: number;
	survived: number;
	no_coverage: number;
	survivors: Survivor[];
	survivors_omitted: number;
} {
	const byId = testFileById(report);
	let killed = 0;
	let survived = 0;
	let noCoverage = 0;
	const survivors: Survivor[] = [];
	for (const [file, entry] of Object.entries(report.files ?? {})) {
		for (const m of entry.mutants ?? []) {
			// Timeouts count as killed: the mutant changed behaviour enough to hang the
			// suite, which is detection, just an ugly form of it.
			if (m.status === "Killed" || m.status === "Timeout") killed += 1;
			else if (m.status === "NoCoverage") noCoverage += 1;
			else if (m.status === "Survived") {
				survived += 1;
				const files = [...new Set((m.coveredBy ?? []).map((id) => byId.get(id)).filter((f): f is string => !!f))];
				survivors.push({
					file,
					line: m.location.start.line,
					mutator: m.mutatorName,
					replacement: m.replacement,
					covered_by: files,
				});
			}
			// Ignored / CompileError / RuntimeError are counted in neither: they say
			// nothing about test quality, only about the mutant being unrunnable.
		}
	}
	// Sorted before capping so the kept twenty are stable and grouped by file,
	// rather than whichever order the report happened to serialise.
	survivors.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
	return {
		tested: killed + survived + noCoverage,
		killed,
		survived,
		no_coverage: noCoverage,
		survivors: survivors.slice(0, limit),
		survivors_omitted: Math.max(0, survivors.length - limit),
	};
}

export interface RunOptions {
	cwd: string;
	base: string;
	timeoutSec?: number;
	maxLines?: number;
	/** Injected so the runner is testable without a git repo or a real Stryker run. */
	gitDiff?: (cwd: string, base: string) => string;
	/**
	 * Untracked files and their line counts. `git diff` does not report untracked
	 * files at all, so without this a brand-new source file — the code most likely
	 * to have thin tests — would scope to nothing and skip silently.
	 */
	untracked?: (cwd: string) => Array<{ file: string; lines: number }>;
	runStryker?: (cwd: string, mutateArgs: string[], timeoutSec: number) => { ok: boolean; timedOut: boolean; detail?: string };
}

/**
 * Cap on scoped lines. Mutation cost scales with mutant count, and mutant count
 * with changed lines — past a point the run stops being the cheap signal it is
 * meant to be. A diff this large is usually a rename or a generated file, where
 * the result would be noise anyway.
 */
export const DEFAULT_MAX_LINES = 2000;

export function computeRanges(diff: string, untracked: Array<{ file: string; lines: number }> = []): LineRange[] {
	const fromDiff = parseDiffRanges(diff);
	// An untracked file is entirely new, so every line of it is in scope.
	const fromNew = untracked.filter((u) => u.lines > 0).map((u) => ({ file: u.file, start: 1, end: u.lines }));
	return mergeRanges(filterSourceRanges([...fromDiff, ...fromNew], { include: DEFAULT_INCLUDE, exclude: DEFAULT_EXCLUDE }));
}

export function runMutate(opts: RunOptions): MutateResult {
	const { cwd, base } = opts;
	const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
	const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;

	// No Stryker config means this repo has not opted in. Silence, not failure:
	// most repos have not, and Render must not break because of it.
	if (!existsSync(join(cwd, "stryker.config.json")) && !existsSync(join(cwd, "stryker.conf.json"))) {
		return { status: "skipped", reason: "no-backend" };
	}

	const diff = opts.gitDiff!(cwd, base);
	const ranges = computeRanges(diff, opts.untracked?.(cwd) ?? []);
	if (ranges.length === 0) return { status: "skipped", reason: "no-changes" };

	const lines = countLines(ranges);
	if (lines > maxLines) {
		return { status: "skipped", reason: "oversize", lines_scoped: lines };
	}

	const started = Date.now();
	const outcome = opts.runStryker!(cwd, toStrykerMutateArgs(ranges), timeoutSec);
	const duration = Date.now() - started;

	if (outcome.timedOut) {
		return { status: "skipped", reason: "timeout", lines_scoped: lines, duration_ms: duration };
	}

	const reportPath = join(cwd, REPORT_PATH);
	if (!existsSync(reportPath)) {
		return { status: "error", reason: "failed", detail: outcome.detail ?? "no mutation report produced", duration_ms: duration };
	}
	let report: StrykerReport;
	try {
		report = JSON.parse(readFileSync(reportPath, "utf8")) as StrykerReport;
	} catch (err) {
		return { status: "error", reason: "failed", detail: `unreadable report: ${String(err)}`, duration_ms: duration };
	}
	const parsed = parseStrykerReport(report);
	return { status: "ran", backend: "stryker", lines_scoped: lines, duration_ms: duration, ...parsed };
}

/** Remove a stale report so a failed run cannot be read as the current one. */
export function clearReport(cwd: string): void {
	rmSync(join(cwd, REPORT_PATH), { force: true });
}
