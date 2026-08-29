/**
 * Claude Code adapter — the second host adapter, alongside `pi.ts`.
 *
 * Claude Code has no extension API; it has hooks, each one a separate short-lived
 * process fed a JSON event on stdin. So where the pi extension keeps state in
 * closure variables for the life of a session, this keeps it in a file keyed by
 * session id, and every handler is written to be correct when run cold.
 *
 * Three findings from probing a real session shaped this file. All three are
 * silent-corruption traps rather than crashes, which is the failure mode `doctor`
 * exists to catch:
 *
 *  1. One API response is written to the transcript as *several* lines — one per
 *     content block (thinking, text, tool_use) — sharing a `requestId` and carrying
 *     a *growing* `usage`. Billing per line triples the tokens; billing only the
 *     first line undercounts by ~60x. We bill the increase per `requestId`.
 *  2. A subagent's `tool_response.usage` is only its *final* message, not its total
 *     (225 of 441 tokens in the probe). We bill the subagent's own transcript
 *     instead, which `SubagentStop` hands us as `agent_transcript_path`.
 *  3. Hooks fired *inside* a subagent report the parent's `transcript_path`. So the
 *     main transcript is flushed only from the main thread; a subagent's spend
 *     arrives once, at its own stop.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AGENT_PHASE, type Mode, type Tokens } from "../src/schema.ts";
import { BLIND_TARGETS, scrubPayload } from "../src/blind.ts";
import { Store, defaultDir } from "../src/store.ts";

/** Tools that spawn a subagent. `Task` is the older name for the same thing. */
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

/**
 * Billing keys kept per session. A response can only grow while it is the most
 * recent one, so older keys can be dropped — this bounds the state file without
 * risking a re-bill.
 */
const BILLED_LIMIT = 50;

export interface HookEvent {
	hook_event_name?: string;
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	prompt?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: unknown;
	error?: unknown;
	/** Present only when the hook fired inside a subagent. */
	agent_id?: string;
	agent_type?: string;
	/** `SubagentStop` only: the subagent's own transcript, which nothing else exposes. */
	agent_transcript_path?: string;
	effort?: { level?: string } | string;
}

export interface HookOutput {
	hookSpecificOutput?: Record<string, unknown>;
	systemMessage?: string;
}

/** Everything the handlers touch outside themselves, so they can be tested at all. */
export interface Host {
	store: Store;
	stateDir: string;
}

interface SessionState {
	run_id?: string;
	/** Byte offset already consumed from the main transcript. */
	offset: number;
	/** Tokens already billed, per `requestId`. See finding 1 in the file header. */
	billed: Record<string, Tokens>;
	/** Subagents whose transcript has been billed, so a second route cannot re-bill. */
	agents: string[];
}

function emptyState(): SessionState {
	return { offset: 0, billed: {}, agents: [] };
}

export function defaultStateDir(): string {
	return join(defaultDir(), "sessions");
}

function statePath(host: Host, sessionId: string): string {
	// A session id is a uuid from Claude Code, but it lands in a path either way.
	return join(host.stateDir, `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
}

function readState(host: Host, sessionId: string): SessionState {
	try {
		const parsed = JSON.parse(readFileSync(statePath(host, sessionId), "utf8")) as Partial<SessionState>;
		return {
			run_id: parsed.run_id,
			offset: parsed.offset ?? 0,
			billed: parsed.billed ?? {},
			agents: parsed.agents ?? [],
		};
	} catch {
		return emptyState();
	}
}

function writeState(host: Host, sessionId: string, state: SessionState): void {
	const keys = Object.keys(state.billed);
	if (keys.length > BILLED_LIMIT) {
		// Insertion order is arrival order, so the oldest keys are the safe ones to drop.
		for (const key of keys.slice(0, keys.length - BILLED_LIMIT)) delete state.billed[key];
	}
	if (state.agents.length > BILLED_LIMIT) state.agents = state.agents.slice(-BILLED_LIMIT);
	mkdirSync(host.stateDir, { recursive: true });
	writeFileSync(statePath(host, sessionId), JSON.stringify(state));
}

/**
 * Which CRAFTS protocol a prompt is starting, if any. Ported from the pi extension,
 * ordering included: an `/execute-dag` prompt also names a protocol, so matching
 * CRAFTS first would file the supervisor as a protocol run.
 */
export function parseCraftMode(prompt: string): Mode | null {
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

/** One assistant response, as the transcript records it. */
export interface TranscriptTurn {
	/** Stable across the several lines one response is split into. */
	key: string;
	model?: string;
	tokens: Tokens;
}

function tokensOf(usage: Record<string, unknown>): Tokens {
	return {
		input: Number(usage.input_tokens) || 0,
		output: Number(usage.output_tokens) || 0,
		cacheRead: Number(usage.cache_read_input_tokens) || 0,
		cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
	};
}

function totalTokens(t: Tokens): number {
	return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/**
 * Parse assistant turns out of transcript text. Later lines for the same `requestId`
 * overwrite earlier ones rather than adding to them — within one response the usage
 * is a running total, not an increment.
 */
export function parseTurns(text: string): TranscriptTurn[] {
	const byKey = new Map<string, TranscriptTurn>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry.type !== "assistant") continue;
		const message = entry.message as Record<string, unknown> | undefined;
		const usage = message?.usage as Record<string, unknown> | undefined;
		if (!usage) continue;
		// `requestId` identifies the API call; `message.id` is the same value's stand-in
		// on builds that omit it. `uuid` is per *line*, so it must never be the key.
		const key = String(entry.requestId ?? message?.id ?? "");
		if (!key) continue;
		const tokens = tokensOf(usage);
		if (totalTokens(tokens) === 0) continue;
		byKey.set(key, { key, model: message?.model ? String(message.model) : undefined, tokens });
	}
	return [...byKey.values()];
}

interface Chunk {
	text: string;
	/** Bytes consumed — excludes a trailing partial line the writer is mid-way through. */
	consumed: number;
	/** The file was replaced or truncated, so the previous offset means nothing. */
	reset: boolean;
	size: number;
}

/** Read a transcript from `offset` to EOF, stopping at the last complete line. */
export function readFrom(path: string, offset: number): Chunk | undefined {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return undefined;
	}
	try {
		const size = fstatSync(fd).size;
		// Shorter than what we already read: the file was rewritten (compaction does
		// this). Re-reading it would re-bill every response whose key has aged out of
		// the billed map, so re-anchor to the end and lose the rewrite instead.
		if (size < offset) return { text: "", consumed: 0, reset: true, size };
		if (size === offset) return { text: "", consumed: 0, reset: false, size };
		const buf = Buffer.allocUnsafe(size - offset);
		readSync(fd, buf, 0, buf.length, offset);
		const text = buf.toString("utf8");
		const cut = text.lastIndexOf("\n");
		if (cut === -1) return { text: "", consumed: 0, reset: false, size };
		const complete = text.slice(0, cut + 1);
		return { text: complete, consumed: Buffer.byteLength(complete, "utf8"), reset: false, size };
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/** What is left to bill for a turn, given what has been billed already. */
export function unbilled(turn: TranscriptTurn, already: Tokens | undefined): Tokens {
	if (!already) return turn.tokens;
	return {
		input: Math.max(0, turn.tokens.input - already.input),
		output: Math.max(0, turn.tokens.output - already.output),
		cacheRead: Math.max(0, turn.tokens.cacheRead - already.cacheRead),
		cacheWrite: Math.max(0, turn.tokens.cacheWrite - already.cacheWrite),
	};
}

function safe(fn: () => HookOutput | undefined): HookOutput | undefined {
	try {
		return fn();
	} catch {
		// Metrics must never break a session.
		return undefined;
	}
}

/**
 * Resolve the run this session belongs to, and correct its host.
 *
 * The adapter observes its host first-hand; `start --host` only repeats what the
 * conductor typed. Host decides which population a run is compared within, so a
 * disagreement resolves toward whoever is actually running the work.
 */
function resolveRun(host: Host, state: SessionState, cwd: string): string | undefined {
	if (state.run_id) return state.run_id;
	const run = host.store.latestOpenForCwd(cwd);
	if (!run) return undefined;
	if (run.host !== "claude-code") host.store.setHost(run.run_id, "claude-code");
	state.run_id = run.run_id;
	return run.run_id;
}

/** Bill every turn in a transcript that has not been billed yet. */
function flush(
	host: Host,
	state: SessionState,
	runId: string,
	path: string,
	opts: { offset?: number; subagent?: boolean; agent?: string; thinking?: string } = {},
): number {
	const chunk = readFrom(path, opts.offset ?? 0);
	if (!chunk) return opts.offset ?? 0;
	if (chunk.reset) return chunk.size;
	const phase = host.store.openPhase(runId);
	for (const turn of parseTurns(chunk.text)) {
		const delta = unbilled(turn, state.billed[turn.key]);
		const first = state.billed[turn.key] === undefined;
		state.billed[turn.key] = turn.tokens;
		if (totalTokens(delta) === 0) continue;
		host.store.recordUsage(
			runId,
			{
				phase,
				model: turn.model ? `anthropic/${turn.model}` : undefined,
				provider: "anthropic",
				thinking: opts.thinking,
				tokens: delta,
				// Claude Code reports no cost of its own. Recording 0 rather than
				// omitting it keeps `cost_usd` meaning "what you paid" — notional
				// pricing is what makes the phase comparable to a metered one.
				cost_usd: 0,
				// A response split across several lines is still one turn, counted when
				// its first line arrives.
				turns: first ? 1 : 0,
				subagent: opts.subagent,
				agent: opts.agent,
			},
			false,
		);
	}
	return (opts.offset ?? 0) + chunk.consumed;
}

function effortLevel(event: HookEvent): string | undefined {
	if (typeof event.effort === "string") return event.effort;
	return event.effort?.level;
}

export function handleHook(event: HookEvent, host: Host): HookOutput | undefined {
	const sessionId = event.session_id;
	const cwd = event.cwd;
	if (!sessionId || !cwd) return undefined;
	const state = readState(host, sessionId);

	switch (event.hook_event_name) {
		case "SessionStart": {
			if (resolveRun(host, state, cwd)) writeState(host, sessionId, state);
			return undefined;
		}

		case "UserPromptSubmit": {
			const mode = parseCraftMode(event.prompt ?? "");
			if (!mode) {
				if (resolveRun(host, state, cwd)) writeState(host, sessionId, state);
				return undefined;
			}
			// `openRun` dedupes on the open run for this cwd, so opening here before the
			// skill reaches its own `start` is the same benign race pi already handles.
			const run = host.store.openRun({ host: "claude-code", cwd, repo: basename(cwd), mode });
			state.run_id = run.run_id;
			writeState(host, sessionId, state);
			return undefined;
		}

		case "PreToolUse": {
			// Blinding enforcement. The hook can rewrite the tool's input before it runs,
			// so the reviewer physically cannot receive an authorship signal — this does
			// not depend on the conductor having composed the payload correctly.
			if (!SUBAGENT_TOOLS.has(event.tool_name ?? "")) return undefined;
			const input = event.tool_input;
			if (!input) return undefined;
			const agent = String(input.subagent_type ?? "");
			if (!BLIND_TARGETS.has(agent)) return undefined;
			const hits = scrubPayload(input, agent);
			if (hits.length === 0) return undefined;
			const runId = resolveRun(host, state, cwd);
			if (runId) {
				host.store.recordUsage(runId, { phase: host.store.openPhase(runId), blinding_scrubs: hits.length }, false);
			}
			writeState(host, sessionId, state);
			return {
				hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: input },
				systemMessage: `craft: blinded ${hits.length} authorship signal${hits.length === 1 ? "" : "s"} → ${agent}`,
			};
		}

		case "PostToolUse":
		case "PostToolUseFailure": {
			const runId = resolveRun(host, state, cwd);
			if (!runId) return undefined;
			// Finding 3: a subagent's hooks report the *parent's* transcript. Flushing it
			// from there would bill the conductor's turns against the subagent's phase.
			if (!event.agent_id && event.transcript_path) {
				state.offset = flush(host, state, runId, event.transcript_path, {
					offset: state.offset,
					thinking: effortLevel(event),
				});
			}
			const errText = event.error === undefined ? "" : JSON.stringify(event.error);
			const named = event.agent_type && AGENT_PHASE[event.agent_type] ? event.agent_type : undefined;
			host.store.recordUsage(
				runId,
				{
					phase: host.store.openPhase(runId),
					tool_name: event.tool_name,
					agent: named,
					subagent: Boolean(event.agent_id),
					quota_error: quota(errText),
					timeout: timeout(errText),
					failover: failover(errText),
				},
				false,
			);
			writeState(host, sessionId, state);
			return undefined;
		}

		case "SubagentStop": {
			const runId = resolveRun(host, state, cwd);
			const path = event.agent_transcript_path;
			const agentId = event.agent_id;
			if (!runId || !path || !agentId) return undefined;
			if (state.agents.includes(agentId)) return undefined;
			state.agents.push(agentId);
			// Read whole: the subagent has stopped, so there is no tail to resume, and
			// the per-request keys still guard against a repeat.
			flush(host, state, runId, path, {
				subagent: true,
				agent: event.agent_type,
				thinking: effortLevel(event),
			});
			writeState(host, sessionId, state);
			return undefined;
		}

		case "Stop": {
			const runId = resolveRun(host, state, cwd);
			if (!runId || !event.transcript_path) return undefined;
			state.offset = flush(host, state, runId, event.transcript_path, {
				offset: state.offset,
				thinking: effortLevel(event),
			});
			writeState(host, sessionId, state);
			return undefined;
		}

		case "SessionEnd": {
			const runId = resolveRun(host, state, cwd);
			if (runId && event.transcript_path) {
				flush(host, state, runId, event.transcript_path, { offset: state.offset, thinking: effortLevel(event) });
			}
			// The run stays open: ending it is the skill's job, as on pi. Only this
			// session's bookkeeping goes.
			try {
				rmSync(statePath(host, sessionId), { force: true });
			} catch {
				// A stale state file is harmless; a throw here is not.
			}
			return undefined;
		}

		default:
			return undefined;
	}
}

export function readStdin(): string {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

export function defaultHost(): Host {
	// Honours `CRAFT_METRICS_PATH` the way the CLI does, so a redirected store stays
	// redirected for the half of collection the host contributes — and session state
	// follows the log rather than stranding itself beside a store nobody is reading.
	const store = new Store(process.env.CRAFT_METRICS_PATH ?? undefined);
	return { store, stateDir: join(dirname(store.path), "sessions") };
}

/** Entry point. Never throws — a hook that fails must not fail the session. */
export function main(raw: string, host: Host = defaultHost()): string {
	const output = safe(() => {
		let event: HookEvent;
		try {
			event = JSON.parse(raw) as HookEvent;
		} catch {
			return undefined;
		}
		return handleHook(event, host);
	});
	return output ? JSON.stringify(output) : "";
}
