import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWorkflowValidation, cleanupPackets, STATIC_WORKFLOW, workflowValidateCall, writeNodePackets } from "../src/dag-launch.ts";
import { Store } from "../src/store.ts";

const staticScript = join(import.meta.dirname, "../src/dag-workflow.static.js");

test("failed validation records orchestration failure and does not dispatch or consume a phase", () => {
	const dir = mkdtempSync(join(tmpdir(), "craft-dag-val-"));
	const store = new Store(join(dir, "events.jsonl"), new Map());
	try {
		const run = store.openRun({ host: "pi", cwd: dir, repo: "demo", mode: "dag" });
		const before = store.get(run.run_id)!;
		const blocked = applyWorkflowValidation(store, run.run_id, workflowValidateCall(), {
			ok: false,
			kind: "validation",
			evidence: "workflowScript parse error",
		});
		assert.equal(blocked.dispatched, false);
		assert.equal(blocked.status, "blocked");
		const after = store.get(run.run_id)!;
		assert.equal(after.phase_entries, before.phase_entries);
		assert.equal(after.open_phase, null);
		assert.deepEqual(after.phases.map((p) => p.cycles), before.phases.map((p) => p.cycles));
		assert.equal(after.orchestration_failures[0]?.kind, "validation");
		assert.match(after.orchestration_failures[0]?.evidence ?? "", /workflowScript parse error/);

		const ready = applyWorkflowValidation(store, run.run_id, workflowValidateCall(), { ok: true });
		assert.equal(ready.dispatched, true);
		assert.equal(store.get(run.run_id)!.phase_entries, before.phase_entries);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("execute-dag requires subagent validate on the static script before execution", () => {
	const skill = readFileSync(join(import.meta.dirname, "../../skills/execute-dag/SKILL.md"), "utf8");
	assert.match(skill, /action:\s*validate/);
	assert.match(skill, /exact.*workflowScript|workflowScript.*exact/i);
	assert.match(skill, /orchestration-failure/);
	assert.match(skill, /consume no node or CRAFT phase attempt/i);
});

test("validates the exact static workflow script before every execution attempt", () => {
	assert.deepEqual(workflowValidateCall(), { action: "validate", workflowScript: STATIC_WORKFLOW });
	assert.deepEqual(workflowValidateCall(staticScript), { action: "validate", workflowScript: staticScript });
});

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
