import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { main, run, numFlag, type MutateIo } from "../src/mutate-cli.ts";
import { makeGitDiff, makeRunStryker, makeUntracked, type Exec, type ExecResult } from "../src/mutate-shell.ts";

const OK: ExecResult = { status: 0, stdout: "", stderr: "" };

function harness(opts: { withConfig?: boolean; exec?: Exec; files?: Record<string, string> } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "craft-mutate-cli-"));
	if (opts.withConfig !== false) writeFileSync(join(dir, "stryker.config.json"), "{}");
	const out: string[] = [];
	const err: string[] = [];
	const io: MutateIo = {
		write: (s) => out.push(s),
		error: (s) => err.push(s),
		cwd: () => dir,
		exec: opts.exec ?? (() => OK),
		readFile: (p) => {
			const key = Object.keys(opts.files ?? {}).find((k) => p.endsWith(k));
			if (key === undefined) throw new Error(`no such file: ${p}`);
			return opts.files![key];
		},
	};
	return {
		io,
		dir,
		out: () => out.join(""),
		err: () => err.join(""),
		json: () => JSON.parse(out.join("")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("--help prints usage and succeeds", () => {
	const h = harness();
	try {
		assert.equal(main(["--help"], h.io), 0);
		assert.match(h.out(), /^craft-mutate —/);
	} finally {
		h.cleanup();
	}
});

test("a missing --base exits 2 rather than diffing against nothing", () => {
	const h = harness();
	try {
		assert.equal(main([], h.io), 2);
		assert.match(h.err(), /missing --base/);
	} finally {
		h.cleanup();
	}
});

test("a repo with no stryker config skips and still exits 0", () => {
	const h = harness({ withConfig: false });
	try {
		assert.equal(main(["--base", "HEAD"], h.io), 0, "no backend is not a failure");
		assert.deepEqual(h.json(), { status: "skipped", reason: "no-backend" });
	} finally {
		h.cleanup();
	}
});

test("an unparseable numeric flag is rejected, not silently defaulted", () => {
	for (const flag of ["--timeout", "--max-lines"]) {
		const h = harness();
		try {
			assert.equal(run(["--base", "HEAD", flag, "abc"], h.io), 2, flag);
			assert.match(h.err(), new RegExp(`invalid ${flag} abc`));
		} finally {
			h.cleanup();
		}
	}
});

test("a non-positive numeric flag is rejected", () => {
	const h = harness();
	try {
		assert.equal(run(["--base", "HEAD", "--timeout", "0"], h.io), 2);
	} finally {
		h.cleanup();
	}
});

test("an absent numeric flag falls back without complaint", () => {
	const h = harness();
	try {
		assert.equal(numFlag("--timeout", ["--base", "HEAD"], 60, h.io), 60);
		assert.equal(h.err(), "");
	} finally {
		h.cleanup();
	}
});

test("a failing git diff exits 1 rather than reporting no changes", () => {
	// The dangerous failure: an unresolvable base scoping nothing is
	// indistinguishable from a clean diff unless it is treated as fatal.
	const exec: Exec = (cmd, args) =>
		cmd === "git" && args[0] === "diff"
			? { status: 128, stdout: "", stderr: "fatal: bad revision 'nope'" }
			: OK;
	const h = harness({ exec });
	try {
		assert.equal(run(["--base", "nope"], h.io), 1);
		assert.match(h.err(), /bad revision/);
	} finally {
		h.cleanup();
	}
});

test("the shell adapters compose into a scoped stryker invocation", () => {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	const exec: Exec = (cmd, args) => {
		calls.push({ cmd, args });
		if (cmd === "git" && args[0] === "diff") {
			return { status: 0, stdout: ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,0 +10,3 @@", "+x"].join("\n"), stderr: "" };
		}
		return OK;
	};
	const h = harness({ exec });
	try {
		// Stryker writes no report here, so the run reports an error — the point is
		// the arguments it was invoked with.
		run(["--base", "main"], h.io);
		const stryker = calls.find((c) => c.cmd === "npx");
		assert.ok(stryker, "stryker must be invoked");
		assert.deepEqual(stryker!.args, ["stryker", "run", "--mutate", "src/a.ts:10:1-13:1", "--reporters", "json"]);
	} finally {
		h.cleanup();
	}
});

// --- shell adapters, unit level ---

test("git diff failure calls fail rather than returning empty", () => {
	let failed = "";
	const gitDiff = makeGitDiff(() => ({ status: 1, stdout: "", stderr: "boom" }), (m) => {
		failed = m;
		throw new Error("failed");
	});
	assert.throws(() => gitDiff("/tmp", "HEAD"));
	assert.equal(failed, "boom");
});

test("git diff with an empty stderr still reports which ref failed", () => {
	let failed = "";
	const gitDiff = makeGitDiff(() => ({ status: 1, stdout: "", stderr: "   " }), (m) => {
		failed = m;
		throw new Error("failed");
	});
	assert.throws(() => gitDiff("/tmp", "deadbeef"));
	assert.match(failed, /deadbeef/);
});

test("untracked counts lines per file and drops unreadable ones", () => {
	const untracked = makeUntracked(
		() => ({ status: 0, stdout: "src/a.ts\nsrc/gone.ts\n\n  src/b.ts  \n", stderr: "" }),
		(p) => {
			if (p.endsWith("gone.ts")) throw new Error("ENOENT");
			return p.endsWith("a.ts") ? "one\ntwo\nthree" : "solo";
		},
		(a, b) => `${a}/${b}`,
	);
	assert.deepEqual(untracked("/repo"), [
		{ file: "src/a.ts", lines: 3 },
		{ file: "src/gone.ts", lines: 0 },
		{ file: "src/b.ts", lines: 1 },
	]);
});

test("untracked treats a non-repo as having nothing untracked", () => {
	const untracked = makeUntracked(() => ({ status: 128, stdout: "", stderr: "not a git repo" }), () => "", (a, b) => `${a}/${b}`);
	assert.deepEqual(untracked("/tmp"), []);
});

test("a timeout is detected from ETIMEDOUT or a kill signal, not from exit status", () => {
	// All three shapes mean "we ran out of time", and none of them is a nonzero
	// status — treating them as ordinary failures would report a broken run.
	for (const result of [
		{ status: null, stdout: "", stderr: "", error: { code: "ETIMEDOUT" } },
		{ status: null, stdout: "", stderr: "", signal: "SIGTERM" },
		{ status: null, stdout: "", stderr: "", signal: "SIGKILL" },
	] as ExecResult[]) {
		const outcome = makeRunStryker(() => result)("/repo", ["src/a.ts:1:1-2:1"], 60);
		assert.equal(outcome.timedOut, true, JSON.stringify(result));
		assert.equal(outcome.ok, false);
	}
});

test("a clean stryker run is neither failed nor timed out", () => {
	const outcome = makeRunStryker(() => OK)("/repo", ["src/a.ts:1:1-2:1"], 60);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.timedOut, false);
});

test("stryker failure keeps only the tail of its stderr", () => {
	const stderr = ["line one", "line two", "line three", "line four", "line five"].join("\n");
	const outcome = makeRunStryker(() => ({ status: 1, stdout: "", stderr }))("/repo", [], 60);
	assert.equal(outcome.ok, false);
	assert.equal(outcome.detail, "line three\nline four\nline five");
});

test("the timeout is passed through to exec in milliseconds", () => {
	let seen: number | undefined;
	const outcome = makeRunStryker((_c, _a, opts) => {
		seen = opts.timeoutMs;
		return OK;
	})("/repo", [], 45);
	assert.equal(seen, 45_000, "seconds on the flag, milliseconds to the child");
	assert.equal(outcome.ok, true);
});
