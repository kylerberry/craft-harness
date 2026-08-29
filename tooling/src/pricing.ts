import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PhaseRecord, Run, Tokens } from "./schema.ts";

/**
 * Notional cost: what a phase's tokens would cost at list price, regardless of how
 * the model is actually billed. `cost_usd` is what you paid — $0 for a subscription
 * model like ChatGPT-plan Codex, even though it burned real tokens. That makes
 * `cost_usd` honest for "what did this run cost me" and useless for "which phase is
 * expensive": a subscription-heavy phase reads as free next to a metered one that
 * did less work.
 *
 * The price table already exists — pi's model registry knows list prices for every
 * model it can route to, subscription or not. This reads that table and prices
 * tokens against it, purely for comparison. It never touches `cost_usd`.
 */

export interface ModelPrice {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** provider/id → list price, e.g. "openai-codex/gpt-5.6-terra". */
export type PriceTable = Map<string, ModelPrice>;

export function defaultPriceTablePath(): string {
	return join(homedir(), ".pi", "agent", "models-store.json");
}

/**
 * Prices shipped with this repo, currently Anthropic's. Needed because Claude Code
 * reports no cost at all, and pi's registry lists only the providers pi routes to —
 * so without a bundled table every Claude Code phase prices at $0 and reads as free
 * next to a metered pi phase. Same file shape as pi's registry, so one parser serves
 * both.
 */
export function bundledPriceTablePath(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "prices", "anthropic.json");
}

/**
 * The price table as the tool actually resolves it: bundled prices first, then the
 * host's own registry over the top — a host that knows a model's price beats the one
 * we shipped for it.
 *
 * An explicit path (the `path` argument, or `CRAFT_METRICS_PRICES`) means *that table,
 * exactly*. Merging the bundle underneath a table someone deliberately pointed us at
 * would price models they left out on purpose.
 */
export function loadPriceTable(path?: string): PriceTable {
	const override = path ?? process.env.CRAFT_METRICS_PRICES;
	if (override) return readPriceFile(override);
	return mergePriceTables(readPriceFile(bundledPriceTablePath()), readPriceFile(defaultPriceTablePath()));
}

/** `over` wins on collision. Neither input is mutated. */
export function mergePriceTables(base: PriceTable, over: PriceTable): PriceTable {
	const merged: PriceTable = new Map(base);
	for (const [model, price] of over) merged.set(model, price);
	return merged;
}

/**
 * Parse one models-store-shaped file. Missing file, unreadable JSON, or an unexpected
 * shape all return an empty table rather than throwing — pricing is enrichment, not
 * a dependency the rest of the tool should break on. An empty table makes every
 * notional figure fall back to `cost_usd`, which is silently correct: nothing to
 * price against means nothing changes.
 */
function readPriceFile(path: string): PriceTable {
	const table: PriceTable = new Map();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return table;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return table;
	}
	if (!parsed || typeof parsed !== "object") return table;
	for (const [provider, entry] of Object.entries(parsed as Record<string, unknown>)) {
		const models = (entry as { models?: unknown[] } | null)?.models;
		if (!Array.isArray(models)) continue;
		for (const m of models) {
			const model = m as { id?: unknown; cost?: Record<string, unknown> } | null;
			if (!model?.id || typeof model.id !== "string" || !model.cost) continue;
			const c = model.cost;
			table.set(`${provider}/${model.id}`, {
				input: Number(c.input) || 0,
				output: Number(c.output) || 0,
				cacheRead: Number(c.cacheRead) || 0,
				cacheWrite: Number(c.cacheWrite) || 0,
			});
		}
	}
	return table;
}

/**
 * Price is per-million-tokens, matching how every provider publishes it. Note:
 * some models (the Codex `sol`/`terra` tiers observed so far) charge a higher rate
 * above a context threshold (`tiers: [{ inputTokensAbove, ... }]`). Tokens are
 * summed across every request in a phase, so which individual requests crossed
 * that threshold is not reconstructable from aggregate counts. This always prices
 * at the base tier — an under-count on long-context phases, not an over-count.
 * Treat notional cost as a floor, not an exact figure.
 */
/**
 * Notional uses whatever price is in the table *now*. If a provider's rate changed
 * during the window a run's tokens were spent, notional and `cost_usd` will diverge
 * even for a fully metered model — that is expected, not a bug. `cost_usd` is what
 * was billed at the time; notional is what the same tokens would cost today.
 */
export function notionalCostForTokens(price: ModelPrice, tokens: Tokens): number {
	return (
		(tokens.input * price.input +
			tokens.output * price.output +
			tokens.cacheRead * price.cacheRead +
			tokens.cacheWrite * price.cacheWrite) /
		1e6
	);
}

/**
 * Annotate a folded run with notional cost, in place. Derived at read time from the
 * current price table rather than stamped into the event log at write time — so a
 * price correction re-prices every historical run on the next read, with no
 * migration and no event replay.
 */
export function applyNotionalPricing(run: Run, table: PriceTable): void {
	let runTotal = 0;
	for (const phase of run.phases) {
		runTotal += applyNotionalPricingToPhase(phase, table);
	}
	run.notional_cost_usd = runTotal;
}

function applyNotionalPricingToPhase(phase: PhaseRecord, table: PriceTable): number {
	let phaseTotal = 0;
	for (const [model, spend] of Object.entries(phase.by_model)) {
		const price = table.get(model);
		// No price known: notional collapses to actual. Correct for metered models
		// that are simply missing from the table, and the least-wrong fallback for
		// anything else — it never fabricates a number the table cannot support.
		const notional = price ? notionalCostForTokens(price, spend.tokens) : spend.cost_usd;
		spend.notional_cost_usd = notional;
		phaseTotal += notional;
	}
	phase.notional_cost_usd = phaseTotal;
	return phaseTotal;
}
