import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleHook, main, parseCraftMode, parseTurns, readFrom, unbilled, type Host } from "../extensions/claude-code.ts";
import { Store } from "../src/store.ts";
import type { Run } from "../src/schema.ts";

function tmpHost(): { host: Host; dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "craft-hook-"));
	return {
		// Empty price table: notional pricing must not depend on this machine's registry.
		host: { store: new Store(join(dir, "events.jsonl"), new Map()), stateDir: join(dir, "sessions") },
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/**
 * One assistant line as Claude Code writes it. A single API response produces
 * several of these — same `requestId`, one per content block, with usage that grows
 * as the response fills in.
 */
function line(requestId: string, block: string, usage: Partial<Record<string, number>>, model = "claude-opus-5"): string {
	return `${JSON.stringify({
		type: "assistant",
		uuid: `${requestId}-${block}`,
		requestId,
		message: {
			id: `msg_${requestId}`,
			model,
			content: [{ type: block }],
			usage: {
				input_tokens: usage.input ?? 0,
				output_tokens: usage.output ?? 0,
				cache_read_input_tokens: usage.cacheRead ?? 0,
				cache_creation_input_tokens: usage.cacheWrite ?? 0,
			},
		},
	})}\n`;
}

function phase(run: Run, name: string) {
	return run.phases.find((p) => p.name === name);
}

test("a response split across several lines is billed once, at its final size", () => {
	// The trap: same requestId, three lines, usage growing. Keying on `uuid` would
	// triple the bill; taking the first line would report 3 output tokens of 184.
	const turns = parseTurns(
		line("req_a", "thinking", { input: 10, output: 3, cacheWrite: 9311 }) +
			line("req_a", "text", { input: 10, output: 120, cacheWrite: 9311 }) +
			line("req_a", "tool_use", { input: 10, output: 184, cacheWrite: 9311 }),
	);
	assert.equal(turns.length, 1);
	assert.deepEqual(turns[0].tokens, { input: 10, output: 184, cacheRead: 0, cacheWrite: 9311 });
	assert.equal(turns[0].model, "claude-opus-5");
});

test("parseTurns skips lines that carry no usable usage", () => {
	const turns = parseTurns(
		[
			JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
			JSON.stringify({ type: "assistant", requestId: "r", message: { model: "m" } }), // no usage
			// A `<synthetic>` message reports all-zero usage; billing it would invent a
			// model that never ran and leave `doctor` reporting it as unpriced.
			line("req_synth", "text", {}, "<synthetic>"),
			"not json at all",
			line("req_real", "text", { output: 5 }),
		].join("\n"),
	);
	assert.deepEqual(
		turns.map((t) => t.key),
		["req_real"],
	);
});

test("only the increase is billed when a response is seen again", () => {
	const turn = { key: "r", tokens: { input: 10, output: 184, cacheRead: 5, cacheWrite: 100 } };
	assert.deepEqual(unbilled(turn, undefined), turn.tokens, "nothing billed yet: bill it all");
	assert.deepEqual(unbilled(turn, { input: 10, output: 3, cacheRead: 5, cacheWrite: 100 }), {
		input: 0,
		output: 181,
		cacheRead: 0,
		cacheWrite: 0,
	});
	// A shrinking count would otherwise credit tokens back and understate the phase.
	assert.deepEqual(unbilled(turn, { input: 99, output: 999, cacheRead: 99, cacheWrite: 999 }), {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	});
});

test("readFrom stops at the last complete line and reports what it consumed", () => {
	const dir = mkdtempSync(join(tmpdir(), "craft-tail-"));
	const path = join(dir, "t.jsonl");
	try {
		const whole = line("req_a", "text", { output: 5 });
		writeFileSync(path, whole + '{"type":"assistant","requestId":"req_b"');
		const chunk = readFrom(path, 0)!;
		assert.equal(chunk.consumed, Buffer.byteLength(whole), "the half-written line is left for next time");
		assert.equal(parseTurns(chunk.text).length, 1);
		assert.equal(chunk.reset, false);

		// Resuming from the offset returns nothing new until the partial line completes.
		assert.equal(parseTurns(readFrom(path, chunk.consumed)!.text).length, 0);

		// A shorter file means it was rewritten; re-reading it would re-bill.
		writeFileSync(path, "");
		const after = readFrom(path, chunk.consumed)!;
		assert.equal(after.reset, true);
		assert.equal(readFrom(join(dir, "missing.jsonl"), 0), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("usage lands on the phase that is open, and a re-flush bills nothing twice", () => {
	const { host, dir, cleanup } = tmpHost();
	try {
		const run = host.store.openRun({ host: "claude-code", cwd: "/tmp/proj", repo: "proj", mode: "full" });
		host.store.enterPhase(run.run_id, "R", { agent: "craft-builder" });
		const transcript = join(dir, "session.jsonl");
		writeFileSync(transcript, line("req_a", "thinking", { output: 3, cacheWrite: 100 }));

		const event = {
			hook_event_name: "PostToolUse",
			session_id: "s1",
			cwd: "/tmp/proj",
			transcript_path: transcript,
			tool_name: "Bash",
			effort: { level: "high" },
		};
		handleHook(event, host);
		// The same response, now complete — only the delta may be billed.
		appendFileSync(transcript, line("req_a", "text", { output: 184, cacheWrite: 100 }));
		handleHook(event, host);

		const r = phase(host.store.get(run.run_id)!, "R")!;
		assert.deepEqual(r.tokens, { input: 0, output: 184, cacheRead: 0, cacheWrite: 100 });
		assert.equal(r.turns, 1, "one response is one turn, however many lines it took");
		assert.equal(r.tool_calls, 2);
		assert.equal(r.tool_calls_by_name.Bash, 2);
		assert.equal(r.cost_usd, 0, "Claude Code reports no cost — notional is what compares it");
		assert.deepEqual(Object.keys(r.by_model), ["anthropic/claude-opus-5"]);
		assert.equal(r.thinking, "high");
	} finally {
		cleanup();
	}
});

test("a subagent is billed from its own transcript, not the parent's", () => {
	const { host, dir, cleanup } = tmpHost();
	try {
		const run = host.store.openRun({ host: "claude-code", cwd: "/tmp/proj", repo: "proj", mode: "full" });
		host.store.enterPhase(run.run_id, "A", { agent: "craft-evaluator" });
		const parent = join(dir, "parent.jsonl");
		const child = join(dir, "agent-abc.jsonl");
		writeFileSync(parent, line("req_parent", "text", { output: 50 }));
		writeFileSync(child, line("req_child", "text", { output: 400, cacheRead: 9000 }));

		// A hook firing *inside* the subagent reports the parent's transcript. Flushing
		// it there would bill the conductor's turn as the subagent's.
		handleHook(
			{
				hook_event_name: "PostToolUse",
				session_id: "s1",
				cwd: "/tmp/proj",
				transcript_path: parent,
				tool_name: "Read",
				agent_id: "abc",
				agent_type: "craft-evaluator",
			},
			host,
		);
		let a = phase(host.store.get(run.run_id)!, "A")!;
		assert.equal(a.tokens.output, 0, "the parent transcript is not the subagent's to bill");
		assert.equal(a.tool_calls, 1);
		assert.equal(a.subagent_count, 0, "a tool call alone is not spend");

		const stop = {
			hook_event_name: "SubagentStop",
			session_id: "s1",
			cwd: "/tmp/proj",
			transcript_path: parent,
			agent_transcript_path: child,
			agent_id: "abc",
			agent_type: "craft-evaluator",
		};
		handleHook(stop, host);
		handleHook(stop, host); // a repeated stop must not double the bill

		a = phase(host.store.get(run.run_id)!, "A")!;
		assert.equal(a.tokens.output, 400);
		assert.equal(a.tokens.cacheRead, 9000);
		assert.equal(a.subagent_count, 1);
		assert.equal(a.agents.includes("craft-evaluator"), true);

		// The parent's own turn is still owed, and arrives on the main thread's flush.
		handleHook({ hook_event_name: "Stop", session_id: "s1", cwd: "/tmp/proj", transcript_path: parent }, host);
		assert.equal(phase(host.store.get(run.run_id)!, "A")!.tokens.output, 450);
	} finally {
		cleanup();
	}
});

test("a reviewer's payload is scrubbed before the subagent is spawned", () => {
	const { host, cleanup } = tmpHost();
	try {
		const run = host.store.openRun({ host: "claude-code", cwd: "/tmp/proj", repo: "proj", mode: "full" });
		host.store.enterPhase(run.run_id, "A");
		const input: Record<string, unknown> = {
			subagent_type: "craft-evaluator",
			prompt: "craft-builder implemented this on anthropic/claude-opus-5. Review it.",
		};
		const out = handleHook(
			{ hook_event_name: "PreToolUse", session_id: "s1", cwd: "/tmp/proj", tool_name: "Agent", tool_input: input },
			host,
		);

		const updated = out!.hookSpecificOutput!.updatedInput as Record<string, string>;
		assert.equal(out!.hookSpecificOutput!.hookEventName, "PreToolUse");
		assert.doesNotMatch(updated.prompt, /craft-builder/);
		assert.doesNotMatch(updated.prompt, /claude-opus-5/);
		assert.match(updated.prompt, /the implementation step/);
		assert.equal(phase(host.store.get(run.run_id)!, "A")!.blinding_scrubs, 2);
	} finally {
		cleanup();
	}
});

test("a non-reviewer agent's payload is passed through untouched", () => {
	const { host, cleanup } = tmpHost();
	try {
		host.store.openRun({ host: "claude-code", cwd: "/tmp/proj", repo: "proj", mode: "full" });
		const input = { subagent_type: "craft-builder", prompt: "craft-planner wrote the plan on anthropic/claude-opus-5." };
		const out = handleHook(
			{ hook_event_name: "PreToolUse", session_id: "s1", cwd: "/tmp/proj", tool_name: "Agent", tool_input: input },
			host,
		);
		assert.equal(out, undefined, "no rewrite, no output");
		assert.match(input.prompt, /craft-planner/, "the builder is not a blind target");
	} finally {
		cleanup();
	}
});

test("a craft prompt opens a run, and the adapter stamps its own host", () => {
	const { host, cleanup } = tmpHost();
	try {
		handleHook(
			{ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/tmp/proj", prompt: "/craft-lite fix the parser" },
			host,
		);
		const run = host.store.latestOpenForCwd("/tmp/proj")!;
		assert.equal(run.host, "claude-code");
		assert.equal(run.mode, "lite");
		assert.equal(run.repo, "proj");

		// A run the skill opened under the wrong harness is corrected on sight: the
		// adapter is the host, the flag is only a claim about it.
		const other = new Store(host.store.path, new Map());
		const stray = other.openRun({ host: "pi", cwd: "/tmp/elsewhere", repo: "elsewhere", mode: "full" });
		handleHook({ hook_event_name: "SessionStart", session_id: "s2", cwd: "/tmp/elsewhere" }, host);
		assert.equal(host.store.get(stray.run_id)!.host, "claude-code");
	} finally {
		cleanup();
	}
});

test("modes are read from the prompt the same way the pi extension reads them", () => {
	assert.equal(parseCraftMode("/craft build the thing"), "full");
	assert.equal(parseCraftMode("/craft-lite build the thing"), "lite");
	assert.equal(parseCraftMode("/craft-hitl build the thing"), "hitl");
	assert.equal(parseCraftMode("run CRAFTS on this"), "full");
	// A supervisor prompt names a protocol too — matched first, or it files as one.
	assert.equal(parseCraftMode("/execute-dag --protocol craft"), "dag");
	assert.equal(parseCraftMode("just fix the typo"), null);
});

test("a session with no craft run records nothing at all", () => {
	const { host, dir, cleanup } = tmpHost();
	try {
		const transcript = join(dir, "s.jsonl");
		writeFileSync(transcript, line("req_a", "text", { output: 500 }));
		handleHook(
			{
				hook_event_name: "PostToolUse",
				session_id: "s1",
				cwd: "/tmp/unrelated",
				transcript_path: transcript,
				tool_name: "Bash",
			},
			host,
		);
		assert.deepEqual(host.store.loadAll(), []);
	} finally {
		cleanup();
	}
});

test("SessionEnd flushes the last turn and clears the session's bookkeeping", () => {
	const { host, dir, cleanup } = tmpHost();
	try {
		const run = host.store.openRun({ host: "claude-code", cwd: "/tmp/proj", repo: "proj", mode: "full" });
		host.store.enterPhase(run.run_id, "S");
		const transcript = join(dir, "s.jsonl");
		writeFileSync(transcript, line("req_a", "text", { output: 77 }));

		handleHook(
			{ hook_event_name: "SessionEnd", session_id: "s1", cwd: "/tmp/proj", transcript_path: transcript },
			host,
		);

		const after = host.store.get(run.run_id)!;
		assert.equal(phase(after, "S")!.tokens.output, 77);
		assert.equal(after.outcome, "open", "ending the run is the skill's job, not the host's");
		assert.equal(existsSync(host.stateDir) ? readdirSync(host.stateDir).length : 0, 0);
	} finally {
		cleanup();
	}
});

test("errors in a tool result are classified, not just counted", () => {
	const { host, cleanup } = tmpHost();
	try {
		const run = host.store.openRun({ host: "claude-code", cwd: "/tmp/proj", repo: "proj", mode: "full" });
		host.store.enterPhase(run.run_id, "R");
		handleHook(
			{
				hook_event_name: "PostToolUseFailure",
				session_id: "s1",
				cwd: "/tmp/proj",
				tool_name: "Bash",
				error: { message: "429 rate limit exceeded; request timed out" },
			},
			host,
		);
		const r = phase(host.store.get(run.run_id)!, "R")!;
		assert.equal(r.quota_errors, 1);
		assert.equal(r.timeouts, 1);
		assert.equal(r.failovers, 0);
	} finally {
		cleanup();
	}
});

test("the billed-response record stays bounded across a long session", () => {
	const { host, dir, cleanup } = tmpHost();
	try {
		const run = host.store.openRun({ host: "claude-code", cwd: "/tmp/proj", repo: "proj", mode: "full" });
		host.store.enterPhase(run.run_id, "R");
		const transcript = join(dir, "long.jsonl");
		writeFileSync(transcript, "");

		// 200 responses is a long but ordinary agentic session. The state file is read
		// and rewritten on every tool call, so it cannot be allowed to grow with it.
		for (let i = 0; i < 200; i++) {
			appendFileSync(transcript, line(`req_${i}`, "text", { output: 1 }));
			handleHook(
				{
					hook_event_name: "PostToolUse",
					session_id: "s1",
					cwd: "/tmp/proj",
					transcript_path: transcript,
					tool_name: "Bash",
				},
				host,
			);
		}

		const state = JSON.parse(readFileSync(join(host.stateDir, "s1.json"), "utf8"));
		assert.ok(Object.keys(state.billed).length <= 50, `billed keys: ${Object.keys(state.billed).length}`);
		// Dropping old keys is only safe because a finished response never grows again:
		// every one of the 200 must still have been billed exactly once.
		assert.equal(phase(host.store.get(run.run_id)!, "R")!.tokens.output, 200);
		assert.equal(phase(host.store.get(run.run_id)!, "R")!.turns, 200);
	} finally {
		cleanup();
	}
});

test("a run already filed under this harness is not re-stamped on every session", () => {
	const { host, cleanup } = tmpHost();
	try {
		const run = host.store.openRun({ host: "claude-code", cwd: "/tmp/proj", repo: "proj", mode: "full" });
		for (const session of ["s1", "s2", "s3"]) {
			handleHook({ hook_event_name: "SessionStart", session_id: session, cwd: "/tmp/proj" }, host);
		}
		const hostEvents = readFileSync(host.store.path, "utf8")
			.split("\n")
			.filter((l) => l.includes('"t":"host"'));
		assert.deepEqual(hostEvents, [], "correcting a host that is already right is just log noise");
		assert.equal(host.store.get(run.run_id)!.host, "claude-code");
	} finally {
		cleanup();
	}
});

test("only agents the protocol knows are recorded by name", () => {
	const { host, cleanup } = tmpHost();
	try {
		const run = host.store.openRun({ host: "claude-code", cwd: "/tmp/proj", repo: "proj", mode: "full" });
		host.store.enterPhase(run.run_id, "R");
		// A general-purpose subagent is still a subagent, but naming it would put a
		// stranger in the phase's agent list and offer route-3 a name it cannot map.
		handleHook(
			{
				hook_event_name: "PostToolUse",
				session_id: "s1",
				cwd: "/tmp/proj",
				tool_name: "Read",
				agent_id: "x1",
				agent_type: "Explore",
			},
			host,
		);
		const r = phase(host.store.get(run.run_id)!, "R")!;
		assert.deepEqual(r.agents, []);
		assert.equal(r.tool_calls, 1, "the call still counts — only the name is withheld");
	} finally {
		cleanup();
	}
});

test("a SubagentStop with no transcript to read bills nothing and breaks nothing", () => {
	const { host, cleanup } = tmpHost();
	try {
		const run = host.store.openRun({ host: "claude-code", cwd: "/tmp/proj", repo: "proj", mode: "full" });
		host.store.enterPhase(run.run_id, "A");
		for (const event of [
			{ agent_id: "a1" }, // no agent_transcript_path
			{ agent_transcript_path: "/nonexistent/agent.jsonl", agent_id: "a2" },
		]) {
			handleHook({ hook_event_name: "SubagentStop", session_id: "s1", cwd: "/tmp/proj", ...event }, host);
		}
		assert.equal(phase(host.store.get(run.run_id)!, "A")!.tokens.output, 0);
	} finally {
		cleanup();
	}
});

test("hitl is recognised from the word as well as the command", () => {
	assert.equal(parseCraftMode("/craft this one needs hitl on the schema choice"), "hitl");
	assert.equal(parseCraftMode("CRAFTS with HITL"), "hitl");
});

test("the effort level is read whichever shape the host sends it in", () => {
	const { host, dir, cleanup } = tmpHost();
	try {
		const run = host.store.openRun({ host: "claude-code", cwd: "/tmp/proj", repo: "proj", mode: "full" });
		host.store.enterPhase(run.run_id, "R");
		const transcript = join(dir, "s.jsonl");
		writeFileSync(transcript, line("req_a", "text", { output: 5 }));
		handleHook(
			{
				hook_event_name: "Stop",
				session_id: "s1",
				cwd: "/tmp/proj",
				transcript_path: transcript,
				effort: "xhigh",
			},
			host,
		);
		assert.equal(phase(host.store.get(run.run_id)!, "R")!.thinking, "xhigh");
	} finally {
		cleanup();
	}
});

test("main survives anything on stdin", () => {
	const { host, cleanup } = tmpHost();
	try {
		assert.equal(main("", host), "");
		assert.equal(main("not json", host), "");
		assert.equal(main("null", host), "");
		assert.equal(main(JSON.stringify({ hook_event_name: "Nonexistent" }), host), "");
		// A well-formed event for a session with no run is still a silent no-op.
		assert.equal(main(JSON.stringify({ hook_event_name: "Stop", session_id: "s", cwd: "/tmp/x" }), host), "");
		// An event with no session or cwd cannot be placed, and must not guess.
		assert.equal(main(JSON.stringify({ hook_event_name: "Stop", cwd: "/tmp/x" }), host), "");
		assert.equal(main(JSON.stringify({ hook_event_name: "Stop", session_id: "s" }), host), "");
		assert.deepEqual(host.store.loadAll(), []);
	} finally {
		cleanup();
	}
});
