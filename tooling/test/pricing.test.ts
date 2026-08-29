import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyNotionalPricing,
	bundledPriceTablePath,
	loadPriceTable,
	mergePriceTables,
	notionalCostForTokens,
	type PriceTable,
} from "../src/pricing.ts";
import { emptyPhase, emptyTokens, type Run } from "../src/schema.ts";

function tmpFile(content: string): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "craft-pricing-"));
	const path = join(dir, "models-store.json");
	writeFileSync(path, content);
	return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("loadPriceTable parses provider/id from the models-store.json shape", () => {
	const { path, cleanup } = tmpFile(
		JSON.stringify({
			"openai-codex": {
				models: [
					{ id: "gpt-5.6-terra", cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 } },
					{ id: "gpt-5.6-sol", cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } },
				],
			},
			xai: { models: [{ id: "grok-4.6", cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 } }] },
		}),
	);
	try {
		const table = loadPriceTable(path);
		assert.equal(table.size, 3);
		assert.deepEqual(table.get("openai-codex/gpt-5.6-terra"), {
			input: 2,
			output: 12,
			cacheRead: 0.2,
			cacheWrite: 2.5,
		});
		assert.deepEqual(table.get("xai/grok-4.6"), { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 });
		assert.equal(table.get("xai/nonexistent"), undefined);
	} finally {
		cleanup();
	}
});

test("the bundled table prices the models Claude Code actually reports", () => {
	// Read through the explicit-path route so this asserts the shipped file itself,
	// not whatever this machine's pi registry happens to add on top.
	const bundled = loadPriceTable(bundledPriceTablePath());
	assert.deepEqual(bundled.get("anthropic/claude-opus-5"), {
		input: 5,
		output: 25,
		cacheRead: 0.5,
		cacheWrite: 6.25,
	});
	// Claude Code writes the dated Haiku id, not the alias — both must price.
	assert.ok(bundled.get("anthropic/claude-haiku-4-5-20251001"));
	// The prose block in the file is not a provider, and must not parse as one.
	assert.equal(bundled.get("_comment/models"), undefined);
});

test("the host's registry wins over the bundled price for the same model", () => {
	const bundled: PriceTable = new Map([
		["anthropic/claude-opus-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
		["anthropic/claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
	]);
	const registry: PriceTable = new Map([
		["anthropic/claude-opus-5", { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }],
		["xai/grok-4.6", { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }],
	]);

	const merged = mergePriceTables(bundled, registry);
	assert.equal(merged.get("anthropic/claude-opus-5")!.input, 4, "the host knows its own routing better");
	assert.equal(merged.get("anthropic/claude-haiku-4-5")!.input, 1, "and does not erase what it never listed");
	assert.equal(merged.get("xai/grok-4.6")!.input, 2);
	assert.equal(bundled.size, 2, "inputs are left alone");
	assert.equal(registry.size, 2);
});

test("an explicit price table is used exactly, with no bundled prices merged under it", () => {
	const { path, cleanup } = tmpFile(JSON.stringify({ xai: { models: [{ id: "grok-4.6", cost: { input: 2 } }] } }));
	const prior = process.env.CRAFT_METRICS_PRICES;
	try {
		assert.equal(loadPriceTable(path).get("anthropic/claude-opus-5"), undefined, "argument form");
		process.env.CRAFT_METRICS_PRICES = path;
		assert.equal(loadPriceTable().get("anthropic/claude-opus-5"), undefined, "env form");
	} finally {
		if (prior === undefined) delete process.env.CRAFT_METRICS_PRICES;
		else process.env.CRAFT_METRICS_PRICES = prior;
		cleanup();
	}
});

test("the default resolution prices Anthropic models even when the host registry lists none", () => {
	const prior = process.env.CRAFT_METRICS_PRICES;
	delete process.env.CRAFT_METRICS_PRICES;
	try {
		assert.ok(
			loadPriceTable().get("anthropic/claude-opus-5"),
			"a Claude Code phase must price against something — it reports no cost of its own",
		);
	} finally {
		if (prior !== undefined) process.env.CRAFT_METRICS_PRICES = prior;
	}
});

test("loadPriceTable never throws — missing file, bad json, and wrong shape all yield empty", () => {
	assert.equal(loadPriceTable("/definitely/does/not/exist.json").size, 0);
	const { path: badJson, cleanup: c1 } = tmpFile("{ not valid json");
	try {
		assert.equal(loadPriceTable(badJson).size, 0);
	} finally {
		c1();
	}
	const { path: wrongShape, cleanup: c2 } = tmpFile(JSON.stringify({ openai: "not an object with models" }));
	try {
		assert.equal(loadPriceTable(wrongShape).size, 0);
	} finally {
		c2();
	}
	const { path: skipsBadEntries, cleanup: c3 } = tmpFile(
		JSON.stringify({
			p: { models: [{ id: "no-cost-field" }, { id: "good", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] },
		}),
	);
	try {
		const table = loadPriceTable(skipsBadEntries);
		assert.equal(table.size, 1);
		assert.ok(table.has("p/good"));
	} finally {
		c3();
	}
});

test("notionalCostForTokens prices per-million-token, matching provider convention", () => {
	const price = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 };
	const cost = notionalCostForTokens(price, { input: 1_000_000, output: 500_000, cacheRead: 8_000_000, cacheWrite: 0 });
	// (1M*2 + 0.5M*12 + 8M*0.2) / 1e6 = 2 + 6 + 1.6
	assert.ok(Math.abs(cost - 9.6) < 1e-9);
});

test("notionalCostForTokens on zero tokens is zero, not NaN", () => {
	const price = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 };
	assert.equal(notionalCostForTokens(price, emptyTokens()), 0);
});

function bareRun(): Run {
	return {
		schema_version: 1,
		run_id: "r1",
		started_at: "2026-01-01T00:00:00.000Z",
		ended_at: null,
		host: "pi",
		cwd: "/tmp",
		mode: "full",
		outcome: "open",
		open_phase: null,
		phase_entries: 0,
		last_closed_phase: null,
		last_closed_at: null,
		phases: [],
		seams: { counsel_family_differs_from_c: null, a_family_differs_from_r: null, t_family_differs_from_r: null },
		hitl: { pause_ms: 0 },
		last_verify: null,
		verify_count: 0,
	};
}

test("applyNotionalPricing sums per-model spend into phase and run totals", () => {
	const run = bareRun();
	const a = emptyPhase("A");
	a.by_model["xai/grok-4.6"] = {
		provider: "xai",
		turns: 1,
		events: 1,
		cost_usd: 0,
		tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const r = emptyPhase("R");
	r.by_model["unpriced/thing"] = {
		provider: "unpriced",
		turns: 1,
		events: 1,
		cost_usd: 0.5, // no price entry — notional must fall back to this, not zero it out
		tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	run.phases = [a, r];

	const table = new Map([["xai/grok-4.6", { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }]]);
	applyNotionalPricing(run, table);

	assert.equal(a.notional_cost_usd, 2); // 1M input * $2/M
	assert.equal(a.by_model["xai/grok-4.6"].notional_cost_usd, 2);
	assert.equal(r.notional_cost_usd, 0.5); // fell back to actual — no price for this model
	assert.equal(run.notional_cost_usd, 2.5);
});

test("applyNotionalPricing on an empty table falls back to actual everywhere", () => {
	const run = bareRun();
	const c = emptyPhase("C");
	c.by_model["zai/glm-5.2"] = {
		provider: "zai",
		turns: 1,
		events: 1,
		cost_usd: 0.03,
		tokens: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0 },
	};
	run.phases = [c];
	applyNotionalPricing(run, new Map());
	assert.equal(c.notional_cost_usd, 0.03);
	assert.equal(run.notional_cost_usd, 0.03);
});
