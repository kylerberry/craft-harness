export const SUPPORTED_HOST = "pi" as const;

export type RoleRoute = {
	model: string;
	fallbackModels: string[];
};

export const DEFAULT_ROUTES: Record<string, RoleRoute> = {
	"craft-planner": { model: "openai-codex/gpt-5.6-sol", fallbackModels: ["xai/grok-4.6", "openai-codex/gpt-5.6-terra"] },
	"craft-counsel": { model: "zai/glm-5.3", fallbackModels: ["moonshot/kimi-k3"] },
	"craft-builder": { model: "zai/glm-5.2", fallbackModels: ["moonshot/kimi-k2.7-code"] },
	"craft-evaluator": { model: "xai/grok-4.6", fallbackModels: ["openai-codex/gpt-5.6-sol"] },
	"craft-security-review": { model: "openai-codex/gpt-5.6-terra", fallbackModels: ["xai/grok-4.3"] },
};

export const CONDUCTOR_OVERRIDE = { model: "inherit" } as const;

export const PHASE_ROLES = Object.keys(DEFAULT_ROUTES);

export class RouteError extends Error {}

export function modelFamily(model: string): string {
	const i = model.indexOf("/");
	return i === -1 ? model : model.slice(0, i);
}

function roleModels(route: RoleRoute): string[] {
	return [route.model, ...route.fallbackModels];
}

function familiesOf(route: RoleRoute): Set<string> {
	return new Set(roleModels(route).map(modelFamily));
}

function disjoint(a: Set<string>, b: Set<string>): boolean {
	for (const f of a) if (b.has(f)) return false;
	return true;
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

export function validateSeams(overrides: Record<string, RoleRoute>): void {
	const c = familiesOf(overrides["craft-planner"]);
	const counsel = familiesOf(overrides["craft-counsel"]);
	const r = familiesOf(overrides["craft-builder"]);
	const a = familiesOf(overrides["craft-evaluator"]);
	const t = familiesOf(overrides["craft-security-review"]);
	if (!disjoint(c, counsel)) throw new RouteError("C→counsel family sets overlap");
	if (!disjoint(r, a)) throw new RouteError("R→A family sets overlap");
	if (!disjoint(r, t)) throw new RouteError("R→T family sets overlap");
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
	const conductor = overrides["node-conductor"];
	if (!conductor || typeof conductor !== "object" || (conductor as { model?: unknown }).model !== "inherit") {
		overrides["node-conductor"] = { ...CONDUCTOR_OVERRIDE };
		changed.push("node-conductor");
	}
	const roleRoutes = Object.fromEntries(PHASE_ROLES.map((role) => [role, overrides[role] as RoleRoute]));
	validateSeams(roleRoutes);
	next.subagents.agentOverrides = overrides;
	return { settings: next, changed };
}
