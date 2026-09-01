import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_ROUTES,
	PHASE_ROLES,
	RouteError,
	installRoutes,
	validateSeams,
	type RoleRoute,
} from "../src/route-install.ts";

const cli = join(import.meta.dirname, "../src/route-install-cli.ts");

test("installer fills missing CRAFT role routes without touching unrelated settings", () => {
	const before = {
		theme: "dark",
		subagents: {
			modelScope: { enforce: true },
			agentOverrides: { "node-conductor": { model: "inherit" } },
		},
	};
	const { settings, changed } = installRoutes(before, "pi");
	assert.equal(settings.theme, "dark");
	assert.deepEqual(settings.subagents?.modelScope, { enforce: true });
	assert.equal("node-conductor" in (settings.subagents?.agentOverrides ?? {}), false);
	for (const role of PHASE_ROLES) {
		assert.deepEqual(settings.subagents?.agentOverrides?.[role], DEFAULT_ROUTES[role]);
	}
	assert.deepEqual(changed.sort(), [...PHASE_ROLES, "node-conductor"].sort());
	assert.equal(before.subagents?.agentOverrides?.["craft-builder"], undefined, "input is not mutated");
});

test("re-running is idempotent and preserves valid user-supplied routes", () => {
	const custom: RoleRoute = { model: "openai-codex/gpt-5.6-sol", fallbackModels: ["xai/grok-4.3"] };
	const once = installRoutes(
		{ subagents: { agentOverrides: { "craft-planner": custom } } },
		"pi",
	).settings;
	assert.deepEqual(once.subagents?.agentOverrides?.["craft-planner"], custom);
	const twice = installRoutes(once, "pi");
	assert.deepEqual(twice.changed, []);
	assert.deepEqual(twice.settings, once);
});

test("--apply replaces CRAFT role routes and removes node-conductor", () => {
	const before = {
		theme: "dark",
		packages: ["npm:pi-multi-account"],
		subagents: {
			modelScope: { enforce: true },
			agentOverrides: {
				"craft-planner": { model: "openai-codex/gpt-5.6-sol", fallbackModels: ["moonshot/kimi-k3"] },
				"node-conductor": { model: "openai-codex/gpt-5.6-terra" },
				"unrelated-agent": { model: "xai/grok-4.6" },
			},
		},
	};
	const { settings, changed } = installRoutes(before, "pi", { apply: true });
	assert.equal(settings.theme, "dark");
	assert.deepEqual(settings.packages, ["npm:pi-multi-account"]);
	assert.deepEqual(settings.subagents?.modelScope, { enforce: true });
	assert.deepEqual(settings.subagents?.agentOverrides?.["unrelated-agent"], { model: "xai/grok-4.6" });
	assert.equal("node-conductor" in (settings.subagents?.agentOverrides ?? {}), false);
	for (const role of PHASE_ROLES) {
		assert.deepEqual(settings.subagents?.agentOverrides?.[role], DEFAULT_ROUTES[role]);
	}
	assert.ok(changed.includes("craft-planner"));
	assert.ok(changed.includes("node-conductor"));
	const again = installRoutes(settings, "pi", { apply: true });
	assert.deepEqual(again.changed, []);
});

test("planner has a preconfigured second fallback without overlapping counsel", () => {
	assert.deepEqual(DEFAULT_ROUTES["craft-planner"].fallbackModels, ["xai/grok-4.6", "openai-codex/gpt-5.6-terra"]);
	assert.doesNotThrow(() => validateSeams(DEFAULT_ROUTES));
});

test("validation rejects overlapping families at C→counsel, R→A, and R→T", () => {
	const overlapC = {
		...DEFAULT_ROUTES,
		"craft-counsel": { model: "openai-codex/gpt-5.6-terra", fallbackModels: ["moonshot/kimi-k3"] },
	};
	assert.throws(() => validateSeams(overlapC), /C→counsel/);
	const overlapA = {
		...DEFAULT_ROUTES,
		"craft-evaluator": { model: "zai/glm-5.1", fallbackModels: ["moonshot/kimi-k2.7-code"] },
	};
	assert.throws(() => validateSeams(overlapA), /R→A/);
	const overlapT = {
		...DEFAULT_ROUTES,
		"craft-security-review": { model: "zai/glm-5.3", fallbackModels: ["moonshot/kimi-k3"] },
	};
	assert.throws(() => validateSeams(overlapT), /R→T/);
	assert.doesNotThrow(() => validateSeams(DEFAULT_ROUTES));
});

test("unsupported hosts fail explicitly", () => {
	assert.throws(() => installRoutes({}, "claude-code"), RouteError);
	const dir = mkdtempSync(join(tmpdir(), "craft-routes-"));
	try {
		const path = join(dir, "settings.json");
		writeFileSync(path, "{}\n");
		const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, "--host", "claude-code", "--settings", path], {
			encoding: "utf8",
		});
		assert.equal(result.status, 2);
		assert.match(result.stderr, /unsupported host claude-code/);
		assert.equal(readFileSync(path, "utf8"), "{}\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
