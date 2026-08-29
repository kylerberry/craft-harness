/**
 * Changed-line ranges from a git diff, in the form mutation testing needs.
 *
 * Scoping mutation to the lines Render actually touched is what makes it cheap
 * enough to run every time — a 20-line range costs ~2s against ~44s for a whole
 * source tree — and, more importantly, what makes the result readable. Mutating
 * whole files surfaces pre-existing survivors that Render did not cause, and
 * those drown the ones it did.
 *
 * The parsing is small but the edge cases are not, so it lives apart from the
 * runner and is tested directly: an off-by-one here silently mutates the wrong
 * code and reports confidently about it.
 */

export interface LineRange {
	file: string;
	start: number;
	end: number;
}

/** `@@ -oldStart,oldCount +newStart,newCount @@` — counts are omitted when 1. */
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
// `b/` is optional so that `+++ /dev/null` matches too. It must: a deleted file
// needs to clear the current file, and if the header does not match at all the
// previous file stays current and the deletion's hunks are attributed to it.
// Deletions happen to carry `+0,0` hunks that are dropped anyway, so this was
// previously correct only by luck.
const FILE_HEADER = /^\+\+\+ (?:b\/)?(.+)$/;

/**
 * Parse `git diff --unified=0` output into per-file added/modified line ranges.
 *
 * Only `+` side lines matter: a mutation range must point at code that exists in
 * the working tree. A pure deletion (`+0,0`) yields no range — there is nothing
 * left to mutate — which is correct, not an omission.
 */
export function parseDiffRanges(diff: string): LineRange[] {
	const ranges: LineRange[] = [];
	let file: string | null = null;
	for (const line of diff.split("\n")) {
		const header = FILE_HEADER.exec(line);
		if (header) {
			// `/dev/null` on the + side means the file was deleted; nothing to mutate.
			file = header[1] === "/dev/null" ? null : header[1];
			continue;
		}
		if (!file) continue;
		const hunk = HUNK.exec(line);
		if (!hunk) continue;
		const start = Number(hunk[1]);
		// An absent count means exactly one line. A count of zero means the change
		// was a deletion anchored after `start`, so there is no new line to mutate.
		const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
		if (count === 0) continue;
		ranges.push({ file, start, end: start + count - 1 });
	}
	return ranges;
}

/**
 * Keep only ranges in files worth mutating: source, not tests, and matching the
 * caller's source globs. Mutating a test file is meaningless — the mutant would
 * be "killed" by definition or break the run.
 */
export function filterSourceRanges(
	ranges: LineRange[],
	opts: { include: RegExp[]; exclude: RegExp[] },
): LineRange[] {
	return ranges.filter(
		(r) => opts.include.some((re) => re.test(r.file)) && !opts.exclude.some((re) => re.test(r.file)),
	);
}

/**
 * Merge ranges that touch or overlap within a file. Adjacent diff hunks often
 * abut after filtering, and collapsing them keeps the `--mutate` argument short
 * enough to stay under argv limits on a large diff.
 */
export function mergeRanges(ranges: LineRange[]): LineRange[] {
	const byFile = new Map<string, LineRange[]>();
	for (const r of ranges) {
		const list = byFile.get(r.file) ?? [];
		list.push(r);
		byFile.set(r.file, list);
	}
	const out: LineRange[] = [];
	for (const [file, list] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
		list.sort((a, b) => a.start - b.start);
		let cur = { ...list[0] };
		for (const r of list.slice(1)) {
			// `<= cur.end + 1` merges abutting ranges, not just overlapping ones.
			if (r.start <= cur.end + 1) {
				cur.end = Math.max(cur.end, r.end);
			} else {
				out.push(cur);
				cur = { ...r };
			}
		}
		out.push(cur);
		void file;
	}
	return out;
}

/**
 * Stryker's mutation-range syntax: `file:startLine:startCol-endLine:endCol`.
 * Column 1 to column 1 of the following line covers a whole line inclusively.
 */
export function toStrykerMutateArgs(ranges: LineRange[]): string[] {
	return ranges.map((r) => `${r.file}:${r.start}:1-${r.end + 1}:1`);
}

/** Total lines covered, for the size cap that decides whether to run at all. */
export function countLines(ranges: LineRange[]): number {
	return ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
}
