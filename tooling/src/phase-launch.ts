import type { Store } from "./store.ts";
import type { OrchestrationFailureKind, PhaseName } from "./schema.ts";

export type LaunchEvent =
	| { kind: "orchestration-failure"; failureKind: OrchestrationFailureKind; evidence: string }
	| { kind: "receipt"; launchId: string };

export type LaunchOutcome = {
	entered: boolean;
	awaitTerminal: boolean;
	retryConsumed: boolean;
};

export type RoleRoutes = Record<string, { model: string; fallbackModels?: string[] }>;

export function modelForAttempt(role: string, routes: RoleRoutes, attempt: number, conductorModel?: string): string | undefined {
	if (conductorModel) throw new Error("conductor must not select a model id");
	const route = routes[role];
	if (!route) throw new Error(`no host route for ${role}`);
	return [route.model, ...(route.fallbackModels ?? [])][attempt];
}

export function phaseRetry(input: { used: number; kind: "orchestration" | "terminal" }): {
	action: "relaunch" | "retry" | "blocked";
	retryConsumed: boolean;
} {
	if (input.kind === "orchestration") return { action: "relaunch", retryConsumed: false };
	if (input.used >= 1) return { action: "blocked", retryConsumed: false };
	return { action: "retry", retryConsumed: true };
}

export function handleLaunch(
	store: Store,
	runId: string,
	phase: PhaseName,
	agent: string,
	event: LaunchEvent,
): LaunchOutcome {
	if (event.kind === "orchestration-failure") {
		store.recordOrchestrationFailure(runId, event.failureKind, event.evidence);
		return { entered: false, awaitTerminal: false, retryConsumed: false };
	}
	store.enterPhase(runId, phase, { agent });
	return { entered: true, awaitTerminal: true, retryConsumed: false };
}
