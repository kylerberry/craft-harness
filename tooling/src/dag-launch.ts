import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Store } from "./store.ts";
import type { OrchestrationFailureKind } from "./schema.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET = /(?:token|password|secret|api[_-]?key)\s*[=:]\s*\S+|sk-[A-Za-z0-9_-]{8,}/gi;
export const STATIC_WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), "dag-workflow.static.js");

export type NodePacket = {
	id: string;
	intent: string;
	change_spec: string;
	acceptance_criteria: string[];
	depends_on: string[];
};

function scrub(value: string): string {
	return value.replace(SECRET, "[redacted]");
}

function scrubPacket(node: NodePacket): NodePacket {
	return {
		id: node.id,
		intent: scrub(node.intent),
		change_spec: scrub(node.change_spec),
		acceptance_criteria: node.acceptance_criteria.map(scrub),
		depends_on: [...node.depends_on],
	};
}

export function workflowValidateCall(scriptPath: string = STATIC_WORKFLOW): { action: "validate"; workflowScript: string } {
	return { action: "validate", workflowScript: scriptPath };
}

export type ValidationResult = { ok: true } | { ok: false; kind: OrchestrationFailureKind; evidence: string };

export type LaunchGate =
	| { status: "blocked"; dispatched: false; kind: OrchestrationFailureKind; evidence: string }
	| { status: "ready"; dispatched: true };

export function applyWorkflowValidation(
	store: Store,
	runId: string,
	call: { action: "validate"; workflowScript: string },
	result: ValidationResult,
): LaunchGate {
	if (call.action !== "validate") throw new Error("workflow validation call required before dispatch");
	if (call.workflowScript !== STATIC_WORKFLOW && !call.workflowScript.endsWith("dag-workflow.static.js")) {
		store.recordOrchestrationFailure(runId, "validation", "workflowScript is not the static execute-dag script");
		return { status: "blocked", dispatched: false, kind: "validation", evidence: "workflowScript is not the static execute-dag script" };
	}
	if (!result.ok) {
		store.recordOrchestrationFailure(runId, result.kind, result.evidence);
		return { status: "blocked", dispatched: false, kind: result.kind, evidence: result.evidence };
	}
	return { status: "ready", dispatched: true };
}

export function writeNodePackets(nodes: NodePacket[], _hintDir?: string): { packetDir: string; scriptPath: string } {
	const packetDir = mkdtempSync(join(tmpdir(), "craft-dag-packets-"));
	for (const node of nodes) {
		writeFileSync(join(packetDir, `${node.id}.json`), JSON.stringify(scrubPacket(node), null, 2) + "\n", { mode: 0o600 });
	}
	void _hintDir;
	return { packetDir, scriptPath: STATIC_WORKFLOW };
}

export function cleanupPackets(packetDir: string, policy: "delete" | "retain"): void {
	if (policy === "retain") return;
	rmSync(packetDir, { recursive: true, force: true });
}
