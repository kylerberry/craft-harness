import { basename } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_PHASE, type Mode, type PhaseName } from "../src/schema.ts";
import { BLIND_TARGETS, scrubPayload } from "../src/blind.ts";
import { Store } from "../src/store.ts";

const CRAFT_AGENTS = new Set(Object.keys(AGENT_PHASE));

function safe(fn: () => void): void {
	try {
		fn();
	} catch {
		// metrics must never break the session
	}
}

function parseCraftMode(prompt: string): Mode | null {
	// Checked first: an execute-dag prompt names a protocol too ("--protocol craft"),
	// so matching CRAFTS first would file the supervisor as a protocol run.
	if (/\/execute-dag\b/.test(prompt)) return "dag";
	if (!/(?:^|\s)\/craft(?:-hitl|-lite)?(?:\s|$)/m.test(prompt) && !/\bCRAFTS\b/.test(prompt)) return null;
	if (/\/craft-lite\b/.test(prompt)) return "lite";
	if (/\/craft-hitl\b/.test(prompt) || /\bhitl\b/i.test(prompt)) return "hitl";
	return "full";
}

function quota(text: string): boolean {
	return /429|rate.?limit|quota|resource.?exhausted|usage.?limit/i.test(text);
}

function timeout(text: string): boolean {
	return /timed? out|timeout/i.test(text);
}

function failover(text: string): boolean {
	return /failing over|failover|switched to|provider error/i.test(text);
}

/**
 * Stable identity for an assistant message, so a turn already reported by
 * `turn_end` is not counted again when `agent_end` replays the whole history.
 */
function messageKey(m: AssistantMessage, index: number): string {
	return m.responseId ?? `${m.timestamp ?? index}:${m.usage?.totalTokens ?? 0}:${index}`;
}

function usageOf(m: AssistantMessage) {
	const u = m.usage;
	return {
		input: u?.input ?? 0,
		output: u?.output ?? 0,
		cacheRead: u?.cacheRead ?? 0,
		cacheWrite: u?.cacheWrite ?? 0,
		cost: u?.cost?.total ?? 0,
	};
}

export default function (pi: ExtensionAPI) {
	const store = new Store();
	let runId: string | undefined;
	let lastModel: string | undefined;
	/** Assistant messages already billed, by messageKey. */
	const reported = new Set<string>();
	/** Phase open when the current agent loop started — the fallback stamp for agent_end. */
	let phaseAtAgentStart: PhaseName | undefined;

	function resolveRun(cwd: string): string | undefined {
		if (runId) return runId;
		const run = store.latestOpenForCwd(cwd);
		if (!run) return undefined;
		// The adapter observes its host first-hand; `start --host` only repeats what
		// the conductor typed, and host is now a comparison axis — a run filed under
		// the wrong harness pollutes that harness's averages rather than merely
		// carrying a wrong label. A disagreement resolves toward whoever is running.
		if (run.host !== "pi") store.setHost(run.run_id, "pi");
		runId = run.run_id;
		return runId;
	}

	pi.on("session_start", (_event, ctx) => {
		safe(() => {
			reported.clear();
			runId = undefined;
			if (resolveRun(ctx.cwd)) ctx.ui.setStatus("craft-metrics", `craft ${runId!.slice(0, 8)}`);
		});
	});

	pi.on("before_agent_start", (event, ctx) => {
		safe(() => {
			const mode = parseCraftMode(event.prompt ?? "");
			if (!mode) {
				// Not a craft kickoff, but an agent loop is starting inside an existing
				// run — remember the phase so a late agent_end can still be placed.
				const open = resolveRun(ctx.cwd);
				if (open) phaseAtAgentStart = store.openPhase(open);
				return;
			}
			const existing = resolveRun(ctx.cwd);
			if (existing) {
				phaseAtAgentStart = store.openPhase(existing);
				return;
			}
			const run = store.openRun({
				host: "pi",
				cwd: ctx.cwd,
				repo: basename(ctx.cwd),
				mode,
			});
			runId = run.run_id;
			phaseAtAgentStart = undefined;
			ctx.ui.setStatus("craft-metrics", `craft ${runId.slice(0, 8)}`);
		});
	});

	// The load-bearing handler. Pi reports a headless agent's entire session in one
	// `agent_end` lump that arrives after the skill has already closed S and ended
	// the run — spanning every phase and attributable to none. Billing each turn as
	// it completes puts the cost inside whichever phase is actually open.
	pi.on("turn_end", (event, ctx) => {
		safe(() => {
			const id = resolveRun(ctx.cwd);
			if (!id) return;
			const m = (event as { message?: unknown }).message as AssistantMessage | undefined;
			if (!m || m.role !== "assistant" || !m.usage) return;
			const key = messageKey(m, (event as { turnIndex?: number }).turnIndex ?? 0);
			if (reported.has(key)) return;
			reported.add(key);
			const u = usageOf(m);
			const model = m.model ? `${m.provider}/${m.model}` : undefined;
			const switched = Boolean(lastModel && model && lastModel !== model);
			if (model) lastModel = model;
			store.recordUsage(
				id,
				{
					phase: store.openPhase(id),
					model,
					provider: m.provider,
					thinking: ctx.thinkingLevel,
					tokens: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
					cost_usd: u.cost,
					turns: 1,
					subagent: !ctx.hasUI,
					failover: switched,
				},
				false,
			);
		});
	});

	// Blinding enforcement. `tool_call` fires before the tool runs and its `input`
	// is mutable, so the reviewer physically cannot receive an authorship signal —
	// this does not depend on the conductor having composed the payload correctly.
	pi.on("tool_call", (event, ctx) => {
		safe(() => {
			if (event.toolName !== "subagent") return;
			const input = event.input as Record<string, unknown>;
			const agent = String(input.agent ?? "");
			if (!BLIND_TARGETS.has(agent)) return;
			const hits = scrubPayload(input, agent);
			if (hits.length === 0) return;
			const id = resolveRun(ctx.cwd);
			if (id) {
				store.recordUsage(id, { phase: store.openPhase(id), blinding_scrubs: hits.length }, false);
			}
			ctx.ui.setStatus("craft-blind", `blinded ${hits.length} → ${agent}`);
		});
	});

	pi.on("tool_execution_end", (event, ctx) => {
		safe(() => {
			const id = resolveRun(ctx.cwd);
			if (!id) return;
			const agent = CRAFT_AGENTS.has(String((event as { args?: { agent?: string } }).args?.agent ?? ""))
				? String((event as { args?: { agent?: string } }).args?.agent)
				: undefined;
			const errText = event.isError ? JSON.stringify(event.result ?? "") : "";
			store.recordUsage(id, {
				phase: store.openPhase(id),
				tool_name: event.toolName,
				agent,
				subagent: event.toolName === "subagent" || !ctx.hasUI,
				quota_error: quota(errText),
				timeout: timeout(errText),
				failover: failover(errText),
			}, false);
		});
	});

	// Backstop only: whatever turn_end missed (a turn that errored before settling,
	// or a Pi build that does not emit turn_end). Anything already billed per-turn
	// is skipped, so this no longer double-reports the session total.
	pi.on("agent_end", (event, ctx) => {
		safe(() => {
			const id = resolveRun(ctx.cwd);
			if (!id) return;
			let input = 0,
				output = 0,
				cacheRead = 0,
				cacheWrite = 0,
				cost = 0,
				turns = 0;
			let model: string | undefined;
			let provider: string | undefined;
			const messages = (event as { messages?: unknown[] }).messages ?? [];
			messages.forEach((msg, i) => {
				const m = msg as AssistantMessage;
				if (!m || m.role !== "assistant" || !m.usage) return;
				const key = messageKey(m, i);
				if (reported.has(key)) return;
				reported.add(key);
				const u = usageOf(m);
				turns += 1;
				input += u.input;
				output += u.output;
				cacheRead += u.cacheRead;
				cacheWrite += u.cacheWrite;
				cost += u.cost;
				if (m.model) {
					model = `${m.provider}/${m.model}`;
					provider = m.provider;
				}
			});
			if (turns === 0) return;
			model ??= ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const switched = Boolean(lastModel && model && lastModel !== model);
			if (model) lastModel = model;
			store.recordUsage(
				id,
				{
					// The work happened under the phase that was open when this loop began,
					// not the one open now — the loop may have outlived several gates.
					phase: store.openPhase(id) ?? phaseAtAgentStart,
					agent: CRAFT_AGENTS.has(String((event as { agent?: string }).agent ?? ""))
						? String((event as { agent?: string }).agent)
						: undefined,
					model,
					provider: provider ?? ctx.model?.provider,
					thinking: ctx.thinkingLevel,
					tokens: { input, output, cacheRead, cacheWrite },
					cost_usd: cost,
					turns,
					subagent: !ctx.hasUI,
					failover: switched,
				},
				false,
			);
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		safe(() => {
			ctx.ui.setStatus("craft-metrics", undefined);
		});
	});

	pi.registerCommand("craft-metrics", {
		description: "Show CRAFT phase metrics for this cwd",
		handler: async (args, ctx) => {
			const cmd = (args ?? "").trim();
			if (cmd === "end") {
				const id = resolveRun(ctx.cwd);
				if (!id) {
					ctx.ui.notify("no open craft run", "warning");
					return;
				}
				store.endRun(id, "completed");
				runId = undefined;
				ctx.ui.notify(`ended ${id.slice(0, 8)}`, "info");
				return;
			}
			const runs = store.loadAll().filter((r) => r.cwd === ctx.cwd);
			if (runs.length === 0) {
				ctx.ui.notify("no craft runs for this project", "info");
				return;
			}
			const last = runs.at(-1)!;
			const lines = last.phases
				.filter((p) => p.cost_usd || p.duration_ms || p.tool_calls)
				.map((p) => `${p.name}: $${p.cost_usd.toFixed(4)} ${(p.duration_ms / 1000).toFixed(1)}s ${p.tool_calls} tools ${p.model ?? ""}`);
			ctx.ui.notify(
				`${last.mode} ${last.outcome} ${last.run_id.slice(0, 8)}\n${lines.join("\n") || "(no phase data yet)"}`,
				"info",
			);
		},
	});
}

export type { PhaseName };
