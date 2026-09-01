import type { Tokens } from "../src/schema.ts";

export type ChildUsage = {
	model?: string;
	provider?: string;
	tokens?: Tokens;
	cost_usd?: number;
	turns?: number;
	failover?: boolean;
	quota_error?: boolean;
	timeout?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function usageOf(value: unknown): { tokens: Tokens; cost_usd: number; turns: number } | null {
	const rec = asRecord(value);
	if (!rec) return null;
	const input = Number(rec.input) || 0;
	const output = Number(rec.output) || 0;
	const cacheRead = Number(rec.cacheRead) || 0;
	const cacheWrite = Number(rec.cacheWrite) || 0;
	const cost = Number(rec.cost) || 0;
	const turns = Number(rec.turns) || 0;
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && cost === 0 && turns === 0) return null;
	return { tokens: { input, output, cacheRead, cacheWrite }, cost_usd: cost, turns };
}

function modelOf(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function childRecord(value: unknown): Record<string, unknown> | null {
	const rec = asRecord(value);
	if (!rec) return null;
	const details = asRecord(rec.details);
	const results = details?.results;
	if (Array.isArray(results) && results[0]) return asRecord(results[0]) ?? rec;
	if (details) return details;
	return rec;
}

/** Pull model + tokens from a Pi `subagent` tool result. Children disable ambient extensions, so the parent must bill this. */
export function extractSubagentUsage(result: unknown, isError = false): ChildUsage | null {
	const child = childRecord(result);
	if (!child) return null;
	const model = modelOf(child.model);
	const usage = usageOf(child.usage);
	if (!model && !usage) return null;
	const attempted = child.attemptedModels;
	const err = typeof child.error === "string" ? child.error : "";
	const provider = model?.includes("/") ? model.slice(0, model.indexOf("/")) : undefined;
	return {
		model,
		provider,
		tokens: usage?.tokens,
		cost_usd: usage?.cost_usd,
		turns: usage?.turns,
		failover: Array.isArray(attempted) && attempted.length > 1,
		quota_error: /429|rate.?limit|quota|resource.?exhausted|usage.?limit/i.test(err),
		timeout: isError && /timed? out|timeout/i.test(err),
	};
}
