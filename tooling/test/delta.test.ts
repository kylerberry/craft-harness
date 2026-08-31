import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const cli = join(import.meta.dirname, "../src/delta-cli.ts");

function repo() {
	const root = mkdtempSync(join(tmpdir(), "craft-delta-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	writeFileSync(join(root, "src.ts"), "export const a = 1;\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
	const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
	writeFileSync(join(root, "src.ts"), "export const a = 2;\n");
	writeFileSync(join(root, "new.ts"), "export const b = 1;\n");
	return { root, base };
}

function run(root: string, args: string[], env?: NodeJS.ProcessEnv) {
	return spawnSync(process.execPath, ["--experimental-strip-types", cli, "--cwd", root, ...args], {
		encoding: "utf8",
		env: env ?? process.env,
	});
}

test("is deterministic and omits identity metadata", () => {
	const { root, base } = repo();
	try {
		const a = readFileSync(run(root, ["--base", base]).stdout.trim(), "utf8");
		const b = readFileSync(run(root, ["--base", base]).stdout.trim(), "utf8");
		assert.equal(a, b);
		assert.doesNotMatch(a, /\b(author|model|agent|workflow|branch|dag)\b/i);
		assert.doesNotMatch(a, /\bI\s+(chose|decided)\b/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("does not invoke Graphify or rewrite a discovery packet", () => {
	const { root, base } = repo();
	try {
		const packet = join(root, "evidence.yaml");
		writeFileSync(packet, "schema_version: 1\n");
		const before = statSync(packet).mtimeMs;
		const bin = join(root, "bin");
		const marker = join(root, "graphify-invoked");
		mkdirSync(bin);
		writeFileSync(join(bin, "graphify"), `#!/bin/sh\necho invoked > "${marker}"\n`, { mode: 0o755 });
		const result = run(
			root,
			["--base", base, "--packet", packet],
			{ ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(statSync(packet).mtimeMs, before);
		assert.equal(existsSync(marker), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("records R_BASE, changed files, validation, and source locations", () => {
	const { root, base } = repo();
	try {
		const result = run(root, ["--base", base, "--verify-command", "npm test", "--exit-code", "0"]);
		assert.equal(result.status, 0, result.stderr);
		const yaml = readFileSync(result.stdout.trim(), "utf8");
		assert.match(yaml, new RegExp(`^r_base: "${base}"$`, "m"));
		assert.match(yaml, /src\.ts/);
		assert.match(yaml, /new\.ts/);
		assert.match(yaml, /command: "npm test"/);
		assert.match(yaml, /exit_code: 0/);
		assert.match(yaml, /src\.ts:1/);
		assert.ok(result.stdout.trim().startsWith(tmpdir()));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
