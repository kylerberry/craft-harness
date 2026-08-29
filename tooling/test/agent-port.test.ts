import { test } from "node:test";
import assert from "node:assert/strict";
import { PortError, portAgent, renderAgent } from "../src/agent-port.ts";
import { main, type Io } from "../src/agent-port-cli.ts";

const EVALUATOR = `---
name: craft-evaluator
description: Run A — Assess for correctness, type safety, reuse, and verification gaps.
context: none
tools:
  - read
  - grep
  - find
extensions:
input_schema:
  properties:
    prompt:
      type: string
      description: What you want the agent to do
  required: [prompt]
color: "#f59e0b"
icon: SearchCheck
priority: 120
---

You are the **craft-evaluator** agent.

## Rules
- Read only.
`;

test("porting keeps the name and body, and translates the tools", () => {
	const ported = portAgent(EVALUATOR);
	// The name is load-bearing: AGENT_PHASE, BLIND_TARGETS, and the PreToolUse
	// matcher all key on it. A rename here silently unhooks all three.
	assert.equal(ported.name, "craft-evaluator");
	assert.equal(ported.description, "Run A — Assess for correctness, type safety, reuse, and verification gaps.");
	assert.deepEqual(ported.tools, ["Read", "Grep", "Glob"]);
	assert.match(ported.body, /You are the \*\*craft-evaluator\*\* agent\./);
	assert.match(ported.body, /- Read only\./, "the instructions are carried through, not summarised");
});

test("a read-only reviewer is not handed the means to edit", () => {
	const tools = portAgent(EVALUATOR).tools;
	assert.equal(tools.includes("Write"), false);
	assert.equal(tools.includes("Edit"), false);
	assert.equal(tools.includes("Bash"), false);
});

test("the rendered file carries no model, so each host routes the agent itself", () => {
	const rendered = renderAgent(portAgent(EVALUATOR));
	assert.doesNotMatch(rendered, /^model:/m);
	assert.equal(rendered.startsWith("---\nname: craft-evaluator\n"), true);
	assert.match(rendered, /^tools: Read, Grep, Glob$/m);
	// Pi-only keys are dropped rather than passed through as noise.
	for (const dropped of ["icon:", "color:", "priority:", "input_schema:", "context:"]) {
		assert.doesNotMatch(rendered, new RegExp(`^${dropped}`, "m"), dropped);
	}
	// Round-trips: rendering then re-porting yields the same agent.
	assert.deepEqual(portAgent(rendered), portAgent(EVALUATOR));
});

test("an unmappable tool stops the port rather than dropping the tool", () => {
	const source = EVALUATOR.replace("  - find", "  - telepathy");
	assert.throws(() => portAgent(source), (err: Error) => err instanceof PortError && /telepathy/.test(err.message));
});

test("an unrecognised frontmatter key stops the port rather than being guessed at", () => {
	// A `model` baked in here would shadow the host's own routing — the exact thing
	// the repo's model-routing rule exists to prevent.
	assert.throws(
		() => portAgent(EVALUATOR.replace("context: none", "model: claude-opus-5")),
		(err: Error) => err instanceof PortError && /model/.test(err.message),
	);
});

test("malformed input is rejected with a reason", () => {
	assert.throws(() => portAgent("no frontmatter here"), /no frontmatter/);
	assert.throws(() => portAgent("---\nname: x\n"), /unterminated/);
	assert.throws(() => portAgent("---\ndescription: d\n---\n"), /no name/);
	assert.throws(() => portAgent("---\nname: x\n---\n"), /no description/);
});

function harness(files: Record<string, string>) {
	const out: string[] = [];
	const err: string[] = [];
	const saved: Record<string, string> = {};
	const io: Io = {
		write: (s) => out.push(s),
		error: (s) => err.push(s),
		read: (path) => {
			const key = path.split("/").pop()!;
			if (!(key in files)) throw new Error(`ENOENT ${path}`);
			return files[key];
		},
		list: () => Object.keys(files),
		save: (path, contents) => {
			saved[path.split("/").pop()!] = contents;
		},
	};
	return { io, out: () => out.join(""), err: () => err.join(""), saved };
}

test("the command writes one file per agent, named after the agent", () => {
	// Source filename and agent name deliberately disagree: the output must follow
	// the name, since that is what every matcher and phase map looks up.
	const h = harness({ "weird-filename.md": EVALUATOR });
	assert.equal(main(["agents", "/out"], h.io), 0);
	assert.deepEqual(Object.keys(h.saved), ["craft-evaluator.md"]);
	assert.match(h.out(), /craft-evaluator {2}Read, Grep, Glob/);
	assert.match(h.out(), /1 agent → \/out/);
});

test("one bad agent fails the whole run, naming the file", () => {
	const h = harness({ "a.md": EVALUATOR, "b.md": EVALUATOR.replace("  - find", "  - telepathy") });
	assert.equal(main(["agents", "/out"], h.io), 1);
	assert.match(h.err(), /b\.md: craft-evaluator: no Claude Code equivalent for tool `telepathy`/);
});

test("missing arguments and empty directories exit 2 rather than writing nothing quietly", () => {
	const noArgs = harness({});
	assert.equal(main([], noArgs.io), 2);
	assert.match(noArgs.out(), /Usage:/);

	const empty = harness({});
	assert.equal(main(["agents", "/out"], empty.io), 2);
	assert.match(empty.err(), /no agent files/);
});
