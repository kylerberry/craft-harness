import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupPackets, writeNodePackets } from "../src/dag-launch.ts";

const staticScript = join(import.meta.dirname, "../src/dag-workflow.static.js");

test("writes packets under the OS temp dir and keeps the workflow script static", () => {
	const dir = mkdtempSync(join(tmpdir(), "craft-dag-"));
	try {
		const task = "use `code` and ${process.exit(1)} and \"quotes\"\nand more";
		const { packetDir, scriptPath } = writeNodePackets(
			[{ id: "n1", intent: task, change_spec: task, acceptance_criteria: [task], depends_on: [] }],
			dir,
		);
		assert.ok(packetDir.startsWith(tmpdir()));
		assert.equal(scriptPath, staticScript);
		const js = readFileSync(scriptPath, "utf8");
		assert.doesNotMatch(js, /process\.exit\(1\)/);
		assert.doesNotMatch(js, /and more/);
		const parsed = spawnSync(process.execPath, ["--check", scriptPath], { encoding: "utf8" });
		assert.equal(parsed.status, 0, parsed.stderr);
		const packet = JSON.parse(readFileSync(join(packetDir, "n1.json"), "utf8"));
		assert.equal(packet.intent, task);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("strips secrets from packets and honors terminal cleanup", () => {
	const dir = mkdtempSync(join(tmpdir(), "craft-dag-"));
	try {
		const { packetDir } = writeNodePackets(
			[{ id: "n1", intent: "ok", change_spec: "token=sk-live-secret", acceptance_criteria: ["ok"], depends_on: [] }],
			dir,
		);
		const packet = readFileSync(join(packetDir, "n1.json"), "utf8");
		assert.doesNotMatch(packet, /sk-live-secret/);
		cleanupPackets(packetDir, "retain");
		assert.equal(existsSync(packetDir), true);
		cleanupPackets(packetDir, "delete");
		assert.equal(existsSync(packetDir), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
