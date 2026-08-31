export const HEALTH_CHECK_TURNS = 12;
export const HEALTH_CHECK_INTERVAL_TURNS = 12;

export type PhaseEvent =
	| { type: "tick"; turns: number; tools: number; atMs: number }
	| { type: "terminal"; shape: "report" | "blocked"; atMs: number };

export type HealthIntervention = {
	kind: "health-check";
	observed_turns: number;
	observed_tools: number;
};

export type HealthResult = {
	terminal?: { reason: "report" | "blocked" };
	interventions: HealthIntervention[];
};

/**
 * Turn budgets are check-in cadences, not completion deadlines. A healthy phase
 * may continue after every check-in; only a host-level, long no-activity watchdog
 * may synthesize a timeout.
 */
export function supervisePhase(events: PhaseEvent[]): HealthResult {
	const interventions: HealthIntervention[] = [];
	let nextHealthCheckAt = HEALTH_CHECK_TURNS;
	for (const event of events) {
		if (event.type === "terminal") return { terminal: { reason: event.shape }, interventions };
		if (event.turns >= nextHealthCheckAt) {
			interventions.push({
				kind: "health-check",
				observed_turns: event.turns,
				observed_tools: event.tools,
			});
			nextHealthCheckAt = event.turns + HEALTH_CHECK_INTERVAL_TURNS;
		}
	}
	return { interventions };
}
