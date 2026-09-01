export const SUPPORTED_HOST = "pi" as const;

export type RoleRoute = {
	model: string;
	fallbackModels: string[];
};

const MOONSHOT = "moonshot/kimi-k2.7-code";

export const DEFAULT_ROUTES: Record<string, RoleRoute> = {
	"craft-planner": { model: "openai-codex/gpt-5.6-sol", fallbackModels: ["xai/grok-4.6", "zai/glm-5.2", MOONSHOT] },
	"craft-counsel": { model: "zai/glm-5.3", fallbackModels: ["openai-codex/gpt-5.6-sol", "xai/grok-4.6", MOONSHOT] },
	"craft-builder": { model: "zai/glm-5.2", fallbackModels: ["xai/grok-4.6", "openai-codex/gpt-5.6-sol", MOONSHOT] },
	"craft-node-writer": { model: "zai/glm-5.2", fallbackModels: ["xai/grok-4.6", "openai-codex/gpt-5.6-sol", MOONSHOT] },
	"craft-evaluator": { model: "xai/grok-4.6", fallbackModels: ["openai-codex/gpt-5.6-sol", "zai/glm-5.2", MOONSHOT] },
	"craft-security-review": { model: "openai-codex/gpt-5.6-terra", fallbackModels: ["xai/grok-4.6", "zai/glm-5.2", MOONSHOT] },
};

export const PHASE_ROLES = Object.keys(DEFAULT_ROUTES);

export class RouteError extends Error {}

export function modelFamily(model: string): string {
	const i = model.indexOf("/");
	return i === -1 ? model : model.slice(0, i);
}

function isCompleteRoute(value: unknown): value is RoleRoute {
	if (!value || typeof value !== "object") return false;
	const route = value as RoleRoute;
	return (
		typeof route.model === "string" &&
		route.model.length > 0 &&
		Array.isArray(route.fallbackModels) &&
		route.fallbackModels.length > 0 &&
		route.fallbackModels.every((m) => typeof m === "string" && m.length > 0)
	);
}

function primaryFamily(route: RoleRoute | undefined): string {
	if (!route) return "";
	return modelFamily(route.model);
}

function assertMoonshotLast(role: string, route: RoleRoute): void {
	if (modelFamily(route.model) === "moonshot") throw new RouteError(`${role} must not use moonshot as primary`);
	const index = route.fallbackModels.findIndex((model) => modelFamily(model) === "moonshot");
	if (index === -1) return;
	if (!route.fallbackModels.slice(index).every((model) => modelFamily(model) === "moonshot")) {
		throw new RouteError(`${role}: moonshot must be last in fallbackModels`);
	}
}

export function validateSeams(overrides: Record<string, RoleRoute>): void {
	for (const role of PHASE_ROLES) {
		const route = overrides[role];
		if (route) assertMoonshotLast(role, route);
	}
	const c = primaryFamily(overrides["craft-planner"]);
	const counsel = primaryFamily(overrides["craft-counsel"]);
	const r = primaryFamily(overrides["craft-builder"]);
	const writer = primaryFamily(overrides["craft-node-writer"] ?? overrides["craft-builder"]);
	const a = primaryFamily(overrides["craft-evaluator"]);
	const t = primaryFamily(overrides["craft-security-review"]);
	if (c && counsel && c === counsel) throw new RouteError("C→counsel primary families overlap");
	if ((r && a && r === a) || (writer && a && writer === a)) throw new RouteError("R→A primary families overlap");
	if ((r && t && r === t) || (writer && t && writer === t)) throw new RouteError("R→T primary families overlap");
}

export interface Settings {
	subagents?: {
		agentOverrides?: Record<string, unknown>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

function sameRoute(a: unknown, b: RoleRoute): boolean {
	if (!isCompleteRoute(a)) return false;
	return a.model === b.model && a.fallbackModels.length === b.fallbackModels.length && a.fallbackModels.every((m, i) => m === b.fallbackModels[i]);
}

export function installRoutes(
	settings: Settings,
	host: string,
	opts: { apply?: boolean } = {},
): { settings: Settings; changed: string[] } {
	if (host !== SUPPORTED_HOST) {
		throw new RouteError(`unsupported host ${host}: only ${SUPPORTED_HOST} is supported`);
	}
	const next: Settings = structuredClone(settings);
	next.subagents = { ...(next.subagents ?? {}) };
	const overrides = { ...(next.subagents.agentOverrides ?? {}) };
	const changed: string[] = [];
	for (const role of PHASE_ROLES) {
		const existing = overrides[role];
		if (!opts.apply && isCompleteRoute(existing)) continue;
		if (opts.apply && sameRoute(existing, DEFAULT_ROUTES[role])) continue;
		overrides[role] = structuredClone(DEFAULT_ROUTES[role]);
		changed.push(role);
	}
	if ("node-conductor" in overrides) {
		delete overrides["node-conductor"];
		changed.push("node-conductor");
	}
	const roleRoutes = Object.fromEntries(PHASE_ROLES.map((role) => [role, overrides[role] as RoleRoute]));
	validateSeams(roleRoutes);
	next.subagents.agentOverrides = overrides;
	return { settings: next, changed };
}
