/**
 * The shell-facing half of `craft-mutate`: talking to git and to Stryker.
 *
 * Kept apart from the runner and expressed over an injected `Exec` so the
 * fiddly parts can be tested without a git repository or a real mutation run.
 * The fiddly parts are not obvious — how a timeout actually surfaces, and how
 * many lines an untracked file has — and both were previously reachable only by
 * running the binary for real.
 */

export interface ExecResult {
	status: number | null;
	stdout: string;
	stderr: string;
	signal?: string | null;
	error?: { code?: string };
}

export type Exec = (cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number }) => ExecResult;

export type ReadFile = (path: string) => string;

/**
 * Changed lines against a ref. A failing `git diff` is fatal rather than empty:
 * an unresolvable base silently scoping nothing would report "no changes" and
 * skip mutation altogether, which looks identical to a clean result.
 */
export function makeGitDiff(exec: Exec, fail: (message: string) => never) {
	return (cwd: string, base: string): string => {
		const out = exec("git", ["diff", "--unified=0", base, "--"], { cwd });
		if (out.status !== 0) fail(out.stderr?.trim() || `git diff against ${base} failed`);
		return out.stdout ?? "";
	};
}

/**
 * Untracked files with their line counts. `git diff` does not mention untracked
 * files at all, so without this a brand-new source file scopes to nothing.
 *
 * Line counts are read rather than assumed: a range running past end-of-file is
 * rejected by Stryker, and an unreadable file yields 0 so it is dropped rather
 * than scoped wrongly.
 */
export function makeUntracked(exec: Exec, readFile: ReadFile, joinPath: (a: string, b: string) => string) {
	return (cwd: string): Array<{ file: string; lines: number }> => {
		const out = exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd });
		// A repo-less directory is not an error here — it simply has nothing untracked.
		if (out.status !== 0) return [];
		return (out.stdout ?? "")
			.split("\n")
			.map((f) => f.trim())
			.filter(Boolean)
			.map((file) => {
				try {
					return { file, lines: readFile(joinPath(cwd, file)).split("\n").length };
				} catch {
					return { file, lines: 0 };
				}
			});
	};
}

/**
 * Run Stryker over the given mutation ranges.
 *
 * Timeouts are the subtle case: a child killed for exceeding its limit reports
 * through `error.code` or a signal rather than a nonzero exit status, and
 * treating that as an ordinary failure would surface a timeout as a broken run.
 */
export function makeRunStryker(exec: Exec) {
	return (cwd: string, mutateArgs: string[], timeoutSec: number) => {
		const out = exec("npx", ["stryker", "run", "--mutate", mutateArgs.join(","), "--reporters", "json"], {
			cwd,
			timeoutMs: timeoutSec * 1000,
		});
		const timedOut = out.error?.code === "ETIMEDOUT" || out.signal === "SIGTERM" || out.signal === "SIGKILL";
		return {
			ok: out.status === 0,
			timedOut,
			// Only the tail is useful; Stryker's stderr is long and the last lines
			// carry the actual failure.
			detail: out.stderr?.trim().split("\n").slice(-3).join("\n"),
		};
	};
}
