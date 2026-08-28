#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearReport, runMutate, DEFAULT_MAX_LINES, DEFAULT_TIMEOUT_SEC } from "./mutate.ts";

const USAGE = `craft-mutate — mutation testing scoped to a diff

Usage:
  craft-mutate --base <ref> [--cwd PATH] [--timeout SEC] [--max-lines N]

Runs mutation testing over only the source lines changed since <ref>, and prints
one JSON object describing what survived. Coverage says a line ran; mutation says
whether any test objects when it is wrong. That is the gap a reviewer otherwise
closes by reading.

  --base       git ref to diff against. Capture this before Render edits anything;
               a conductor that commits as it goes will otherwise diff against
               its own work and see nothing.
  --cwd        repository root (default: cwd)
  --timeout    seconds before giving up (default: ${DEFAULT_TIMEOUT_SEC})
  --max-lines  skip if the diff scopes more than this many lines (default: ${DEFAULT_MAX_LINES})

Exits 0 whenever it produced an answer, including "skipped" — a repo without a
Stryker config is not a failure. Exits 1 only when a run was attempted and broke.

Survivors are findings to adjudicate, not a gate. Some are equivalent mutants and
correctly ignored; deciding which is a judgment call left to the reviewer.
`;

function arg(flag: string, argv: string[]): string | undefined {
	const i = argv.indexOf(flag);
	return i === -1 ? undefined : argv[i + 1];
}

function main(argv: string[]): void {
	if (argv.includes("-h") || argv.includes("--help")) {
		process.stdout.write(USAGE);
		return;
	}
	const base = arg("--base", argv);
	if (!base) {
		console.error("missing --base <ref>");
		process.exit(2);
	}
	const cwd = arg("--cwd", argv) ?? process.cwd();
	const timeoutSec = Number(arg("--timeout", argv) ?? DEFAULT_TIMEOUT_SEC);
	const maxLines = Number(arg("--max-lines", argv) ?? DEFAULT_MAX_LINES);

	// A stale report from an earlier run must not be mistaken for this one's.
	clearReport(cwd);

	const result = runMutate({
		cwd,
		base,
		timeoutSec,
		maxLines,
		gitDiff: (dir, ref) => {
			const out = spawnSync("git", ["diff", "--unified=0", ref, "--"], { cwd: dir, encoding: "utf8" });
			if (out.status !== 0) {
				console.error(out.stderr?.trim() || `git diff against ${ref} failed`);
				process.exit(1);
			}
			return out.stdout ?? "";
		},
		untracked: (dir) => {
			const out = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: dir, encoding: "utf8" });
			if (out.status !== 0) return [];
			return (out.stdout ?? "")
				.split("\n")
				.map((f) => f.trim())
				.filter(Boolean)
				.map((file) => {
					try {
						// Count lines rather than assuming: the range must not run past
						// end-of-file or Stryker rejects it.
						const text = readFileSync(join(dir, file), "utf8");
						return { file, lines: text.split("\n").length };
					} catch {
						return { file, lines: 0 };
					}
				});
		},
		runStryker: (dir, mutateArgs, seconds) => {
			const out = spawnSync(
				"npx",
				["stryker", "run", "--mutate", mutateArgs.join(","), "--reporters", "json"],
				{ cwd: dir, encoding: "utf8", timeout: seconds * 1000 },
			);
			// spawnSync reports a killed-by-timeout child via `signal`, not `status`.
			const timedOut = out.error !== undefined && (out.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
			return {
				ok: out.status === 0,
				timedOut: timedOut || out.signal === "SIGTERM",
				detail: out.stderr?.trim().split("\n").slice(-3).join("\n"),
			};
		},
	});

	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
	if (result.status === "error") process.exit(1);
}

try {
	main(process.argv.slice(2));
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
