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
	assert.deepEqual(settings.subagents?.agentOverrides?.["node-conductor"], { model: "inherit" });
	for (const role of PHASE_ROLES) {
		assert.deepEqual(settings.subagents?.agentOverrides?.[role], DEFAULT_ROUTES[role]);
	}
	assert.deepEqual(changed.sort(), [...PHASE_ROLES].sort());
	assert.equal(before.subagents?.agentOverrides?.["craft-builder"], undefined, "input is not mutated");
});

test("re-running is idempotent and preserves valid user-supplied routes", () => {
	const custom: RoleRoute = { model: "openai-codex/gpt-5.6-sol", fallbackModels: ["moonshot/kimi-k3"] };
	const once = installRoutes(
		{ subagents: { agentOverrides: { "craft-planner": custom } } },
		"pi",
	).settings;
	assert.deepEqual(once.subagents?.agentOverrides?.["craft-planner"], custom);
	const twice = installRoutes(once, "pi");
	assert.deepEqual(twice.changed, []);
	assert.deepEqual(twice.settings, once);
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
