import type { EvidencePacket } from "./discover.ts";
import type { RenderDelta } from "./delta.ts";

export type Protocol = "craft" | "craft-hitl" | "craft-lite";
export type AdvisoryRole = "C" | "counsel" | "R" | "A" | "F" | "T";

export type DiscoveryResult =
	| { status: "blocked"; detail: string }
	| { status: "packet"; packet: EvidencePacket };

export type ComposeResult = {
	phases: string[];
	stop?: "blocked";
	detail?: string;
	handoff?: never;
};

const FULL = ["D", "C", "counsel", "R", "A", "T", "S"];
const LITE = ["D", "C", "R", "A", "S"];

export function composeNode(input: { protocol: Protocol; discovery: DiscoveryResult }): ComposeResult {
	if (input.discovery.status === "blocked") {
		return { phases: ["D"], stop: "blocked", detail: input.discovery.detail };
	}
	return { phases: input.protocol === "craft-lite" ? LITE : FULL };
}

export function packetSlice(role: AdvisoryRole, packet: EvidencePacket): Record<string, unknown> {
	if (role === "F") return { evidence_gaps: packet.evidence_gaps };
	const slice: Record<string, unknown> = {
		verified_facts: packet.verified_facts,
		evidence_gaps: packet.evidence_gaps,
	};
	if (role === "C" || role === "counsel" || role === "R") slice.authority_sources = packet.authority_sources;
	if (role === "C" || role === "counsel") slice.task_sources = packet.task_sources;
	if (role === "C") slice.graph_status = packet.graph_status;
	return slice;
}

export function reviewerPayload(
	role: AdvisoryRole,
	slice: Record<string, unknown>,
	delta?: RenderDelta,
): Record<string, unknown> {
	if (role === "A" || role === "T") {
		if (!delta) throw new Error(`${role} requires the Render delta`);
		return {
			...slice,
			delta,
			inspect_final_diff: true,
			instruction: "Inspect the final diff independently. The packet and delta do not replace current-code review.",
		};
	}
	return { ...slice };
}
