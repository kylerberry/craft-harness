export const NO_REPORT_TURNS = 8;
export const NO_REPORT_TOOLS = 12;
export const FINALIZATION_DEADLINE_MS = 30_000;

export type PhaseEvent =
	| { type: "tick"; turns: number; tools: number; atMs: number }
	| { type: "terminal"; shape: "report" | "blocked"; atMs: number };

export type HealthIntervention = {
	kind: "finalization-request";
	observed_turns: number;
	observed_tools: number;
};

export type HealthResult = {
	terminal: { reason: "report" | "blocked" | "timeout"; detail?: string };
	interventions: HealthIntervention[];
};

export function supervisePhase(events: PhaseEvent[]): HealthResult {
	const interventions: HealthIntervention[] = [];
	let warnedAt: number | undefined;
	for (const event of events) {
		if (event.type === "terminal") return { terminal: { reason: event.shape }, interventions };
		if (!warnedAt && (event.turns >= NO_REPORT_TURNS || event.tools >= NO_REPORT_TOOLS)) {
			interventions.push({
				kind: "finalization-request",
				observed_turns: event.turns,
				observed_tools: event.tools,
			});
			warnedAt = event.atMs;
			continue;
		}
		if (warnedAt !== undefined && event.atMs - warnedAt >= FINALIZATION_DEADLINE_MS) {
			return { terminal: { reason: "timeout", detail: "finalization deadline exhausted" }, interventions };
		}
	}
	if (warnedAt !== undefined) {
		return { terminal: { reason: "timeout", detail: "finalization deadline exhausted" }, interventions };
	}
	return { terminal: { reason: "timeout", detail: "phase did not terminate" }, interventions };
}
