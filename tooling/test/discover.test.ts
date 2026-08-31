import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const cli = join(import.meta.dirname, "../src/discover-cli.ts");

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "craft-discover-test-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
	writeFileSync(join(root, "AGENTS.md"), "root rules\n");
	mkdirSync(join(root, "pkg", "sub"), { recursive: true });
	writeFileSync(join(root, "pkg", "AGENTS.md"), "nested rules\n");
	writeFileSync(join(root, "pkg", "sub", "task.txt"), "the supported fact lives here\n");
	execFileSync("git", ["add", "."], { cwd: root });
	execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
	return root;
}

function run(root: string, args: string[]) {
	return spawnSync(process.execPath, ["--experimental-strip-types", cli, "--cwd", root, ...args], { encoding: "utf8" });
}

function packet(result: ReturnType<typeof run>) {
	assert.ok(result.stdout.trim(), result.stderr);
	return readFileSync(result.stdout.trim(), "utf8");
}

test("emits the exact packet shape with nested instructions, hashes, and verified citations", () => {
	const root = fixture();
	try {
		mkdirSync(join(root, "docs", "wiki"), { recursive: true });
		mkdirSync(join(root, "docs", "raw"), { recursive: true });
		writeFileSync(join(root, "docs", "wiki", "index.md"), "[current authority](../raw/current.md)\n");
		writeFileSync(join(root, "docs", "raw", "current.md"), "binding authority\n");
		const result = run(root, ["--task-source", "pkg/sub/task.txt", "--fact", "the supported fact::pkg/sub/task.txt:1", "--fact", "unsupported::pkg/sub/task.txt:1"]);
		assert.equal(result.status, 0, result.stderr);
		const yaml = packet(result);
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		const taskBytes = readFileSync(join(root, "pkg", "sub", "task.txt"));
		const digest = createHash("sha256").update(taskBytes).digest("hex");
		assert.deepEqual([...yaml.matchAll(/^([a-z_]+):/gm)].map((m) => m[1]), ["schema_version", "base_commit", "graph_status", "authority_sources", "task_sources", "graph_candidates", "verified_facts", "evidence_gaps"]);
		assert.match(yaml, /^schema_version: 1$/m);
		assert.match(yaml, new RegExp(`^base_commit: "${head}"$`, "m"));
		assert.match(yaml, /"AGENTS.md"/);
		assert.match(yaml, /"pkg\/AGENTS.md"/);
		assert.match(yaml, /"docs\/wiki\/index.md"/);
		assert.match(yaml, /"docs\/raw\/current.md"/);
		assert.match(yaml, new RegExp(`content_hash: "sha256:${digest}"`));
		assert.ok(yaml.includes('- fact: "the supported fact"\n    source: "pkg/sub/task.txt:1"'));
		assert.doesNotMatch(yaml, /fact: "unsupported"/);
		assert.match(yaml, /unsupported fact/);
		assert.ok(result.stdout.trim().startsWith(tmpdir()));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("multiple current raw authorities block and name every conflicting source", () => {
	const root = fixture();
	try {
		mkdirSync(join(root, "docs", "wiki"), { recursive: true });
		mkdirSync(join(root, "docs", "raw"), { recursive: true });
		writeFileSync(join(root, "docs", "wiki", "index.md"), "[current one](../raw/one.md)\n[current two](../raw/two.md)\n");
		writeFileSync(join(root, "docs", "raw", "one.md"), "one\n");
		writeFileSync(join(root, "docs", "raw", "two.md"), "two\n");
		const result = run(root, ["--task-source", "pkg/sub/task.txt"]);
		assert.equal(result.status, 1);
		const yaml = packet(result);
		assert.ok(yaml.includes('  - "authority conflict: docs/raw/one.md, docs/raw/two.md"'), yaml);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects task sources that escape the repository", () => {
	const root = fixture();
	const outer = mkdtempSync(join(tmpdir(), "craft-discover-outer-"));
	try {
		const outside = join(outer, "outside.txt");
		writeFileSync(outside, "outside bytes\n");
		const result = run(root, ["--task-source", outside]);
		assert.equal(result.status, 2);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /source is not a repository file/);
	} finally {
		rmSync(outer, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
