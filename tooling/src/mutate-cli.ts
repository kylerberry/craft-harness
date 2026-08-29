#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { clearReport, runMutate, DEFAULT_MAX_LINES, DEFAULT_TIMEOUT_SEC } from "./mutate.ts";
import { makeGitDiff, makeRunStryker, makeUntracked, type Exec, type ReadFile } from "./mutate-shell.ts";

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

/** Everything outside the process, injected so the wiring can be tested. */
export interface MutateIo {
	write(s: string): void;
	error(s: string): void;
	cwd(): string;
	exec: Exec;
	readFile: ReadFile;
}

/** Thrown to unwind out of a nested adapter. Caught in `run`. */
export class ExitSignal extends Error {
	code: number;
	constructor(code: number) {
		super(`exit ${code}`);
		this.code = code;
	}
}

export const defaultMutateIo: MutateIo = {
	write: (s) => process.stdout.write(s),
	error: (s) => console.error(s),
	cwd: () => process.cwd(),
	exec: (cmd, args, opts) => {
		const out = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", timeout: opts.timeoutMs });
		return {
			status: out.status,
			stdout: out.stdout ?? "",
			stderr: out.stderr ?? "",
			signal: out.signal,
			error: out.error as { code?: string } | undefined,
		};
	},
	readFile: (p) => readFileSync(p, "utf8"),
};

export function arg(flag: string, argv: string[]): string | undefined {
	const i = argv.indexOf(flag);
	return i === -1 ? undefined : argv[i + 1];
}

/**
 * A numeric flag that is present but unparseable is a mistake worth reporting,
 * not something to silently replace with the default — `--timeout abc` would
 * otherwise run for the default duration and look like it honoured the flag.
 */
export function numFlag(flag: string, argv: string[], fallback: number, io: MutateIo): number {
	const raw = arg(flag, argv);
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		io.error(`invalid ${flag} ${raw}`);
		throw new ExitSignal(2);
	}
	return n;
}

export function main(argv: string[], io: MutateIo = defaultMutateIo): number {
	if (argv.includes("-h") || argv.includes("--help")) {
		io.write(USAGE);
		return 0;
	}
	const base = arg("--base", argv);
	if (!base) {
		io.error("missing --base <ref>");
		return 2;
	}
	const cwd = arg("--cwd", argv) ?? io.cwd();
	const timeoutSec = numFlag("--timeout", argv, DEFAULT_TIMEOUT_SEC, io);
	const maxLines = numFlag("--max-lines", argv, DEFAULT_MAX_LINES, io);

	// A stale report from an earlier run must not be mistaken for this one's.
	clearReport(cwd);

	const fail = (message: string): never => {
		io.error(message);
		throw new ExitSignal(1);
	};

	const result = runMutate({
		cwd,
		base,
		timeoutSec,
		maxLines,
		gitDiff: makeGitDiff(io.exec, fail),
		untracked: makeUntracked(io.exec, io.readFile, join),
		runStryker: makeRunStryker(io.exec),
	});

	io.write(JSON.stringify(result, null, 2) + "\n");
	return result.status === "error" ? 1 : 0;
}

export function run(argv: string[], io: MutateIo = defaultMutateIo): number {
	try {
		return main(argv, io);
	} catch (err) {
		if (err instanceof ExitSignal) return err.code;
		io.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
}

// Self-execute only as a program, never when a test imports this file.
//
// Mutation testing reports the mutants on this line as RuntimeError rather than
// Killed. That is the guard working: weakening it makes the module call
// process.exit during import, which takes the test runner down instead of
// failing an assertion. A dead test process is detection, just an ugly form.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(run(process.argv.slice(2)));
}
