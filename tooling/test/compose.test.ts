import { test } from "node:test";
import assert from "node:assert/strict";
import { composeNode, packetSlice, reviewerPayload } from "../src/compose.ts";
import type { EvidencePacket } from "../src/discover.ts";

const packet: EvidencePacket = {
	schema_version: 1,
	base_commit: "abc",
	graph_status: "current",
	authority_sources: [{ path: "AGENTS.md", lines: "1-1" }],
	task_sources: [{ path: "task.txt", lines: "1-1", content_hash: "sha256:x" }],
	graph_candidates: [{ path: "src.ts", reason: "task", source_location: "src.ts:1" }],
	verified_facts: [{ fact: "supported", source: "task.txt:1" }],
	evidence_gaps: ["authority conflict: a, b"],
};

test("a node run executes D before C and stops when Discovery is blocked", () => {
	const blocked = composeNode({ protocol: "craft", discovery: { status: "blocked", detail: "unresolved authority: docs/wiki" } });
	assert.deepEqual(blocked.phases, ["D"]);
	assert.equal(blocked.stop, "blocked");
	assert.match(blocked.detail ?? "", /unresolved authority/);
	assert.equal(blocked.handoff, undefined);

	const ok = composeNode({ protocol: "craft", discovery: { status: "packet", packet } });
	assert.equal(ok.phases[0], "D");
	assert.equal(ok.phases[1], "C");
	assert.equal(ok.stop, undefined);
});

test("advisory roles receive packet slices; F gets only blocking context", () => {
	assert.deepEqual(Object.keys(packetSlice("C", packet)).sort(), ["authority_sources", "evidence_gaps", "graph_status", "task_sources", "verified_facts"]);
	assert.deepEqual(Object.keys(packetSlice("counsel", packet)).sort(), ["authority_sources", "evidence_gaps", "task_sources", "verified_facts"]);
	assert.deepEqual(Object.keys(packetSlice("R", packet)).sort(), ["authority_sources", "evidence_gaps", "verified_facts"]);
	assert.deepEqual(packetSlice("F", packet), { evidence_gaps: packet.evidence_gaps });
	assert.ok(!("graph_candidates" in packetSlice("C", packet)));
	assert.ok(!("authority_sources" in packetSlice("F", packet)));
});

test("A and T receive the Render delta and must inspect the final diff independently", () => {
	const delta = { r_base: "abc", changed_files: ["src.ts"], validation: [{ command: "npm test", exit_code: 0 }], source_locations: ["src.ts:1"] };
	for (const role of ["A", "T"] as const) {
		const payload = reviewerPayload(role, packetSlice(role, packet), delta);
		assert.deepEqual(payload.delta, delta);
		assert.equal(payload.inspect_final_diff, true);
		assert.match(payload.instruction, /inspect the final diff independently/i);
	}
	assert.equal("delta" in reviewerPayload("C", packetSlice("C", packet)), false);
});
