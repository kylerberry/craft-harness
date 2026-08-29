import { test } from "node:test";
import assert from "node:assert/strict";
import { HOOK_EVENTS, withHooks, type Settings } from "../src/hooks-install.ts";
import { main, type Io } from "../src/hooks-install-cli.ts";

const COMMAND = "/home/k/.local/bin/craft-hook";

test("every event the adapter handles is registered, with PreToolUse narrowed", () => {
	const { settings, added } = withHooks({}, COMMAND);
	assert.deepEqual(added.sort(), HOOK_EVENTS.map((h) => h.event).sort());
	assert.equal(settings.hooks!.PostToolUse[0].hooks![0].command, COMMAND);
	assert.equal(settings.hooks!.PostToolUse[0].matcher, undefined, "usage billing runs on every tool");
	// The one handler that rewrites tool input should not sit in front of every Read.
	assert.equal(settings.hooks!.PreToolUse[0].matcher, "Agent|Task");
});

test("re-running adds nothing — link-global is run often", () => {
	const once = withHooks({}, COMMAND).settings;
	const twice = withHooks(once, COMMAND);
	assert.deepEqual(twice.added, []);
	assert.deepEqual(twice.settings, once);
});

test("existing hooks and unrelated settings survive untouched", () => {
	const before: Settings = {
		model: "opus",
		permissions: { allow: ["Bash(git add *)"] },
		hooks: {
			PostToolUse: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-linter" }] }],
			PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "/usr/local/bin/guard" }] }],
		},
	};
	const { settings } = withHooks(before, COMMAND);

	assert.equal(settings.model, "opus");
	assert.deepEqual(settings.permissions, { allow: ["Bash(git add *)"] });
	assert.equal(settings.hooks!.PostToolUse[0].hooks![0].command, "/usr/local/bin/my-linter");
	assert.equal(settings.hooks!.PostToolUse[1].hooks![0].command, COMMAND);
	// A different matcher on the same event is a different registration, not a clash.
	assert.equal(settings.hooks!.PreToolUse.length, 2);
	assert.equal(settings.hooks!.PreToolUse[0].matcher, "Write");
	assert.equal(settings.hooks!.PreToolUse[1].matcher, "Agent|Task");
	assert.equal((before.hooks!.PostToolUse as unknown[]).length, 1, "the input is not mutated");
});

test("the same command under a different matcher still registers", () => {
	const before: Settings = {
		hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: COMMAND }] }] },
	};
	const { added } = withHooks(before, COMMAND);
	assert.equal(added.includes("PreToolUse"), true, "an Edit-scoped hook does not cover Agent|Task");
});

function harness(files: Record<string, string>) {
	const out: string[] = [];
	const err: string[] = [];
	const saved: Record<string, string> = { ...files };
	const io: Io = {
		write: (s) => out.push(s),
		error: (s) => err.push(s),
		read: (path) => files[path],
		save: (path, contents) => {
			saved[path] = contents;
		},
		backup: (from, to) => {
			saved[to] = files[from];
		},
	};
	return { io, out: () => out.join(""), err: () => err.join(""), saved };
}

test("the previous settings file is backed up before it is rewritten", () => {
	const h = harness({ "/s.json": JSON.stringify({ model: "opus" }) });
	assert.equal(main(["/s.json"], h.io, COMMAND), 0);
	assert.equal(JSON.parse(h.saved["/s.json.craft-backup"]).model, "opus");
	assert.equal(JSON.parse(h.saved["/s.json"]).hooks.Stop[0].hooks[0].command, COMMAND);
	assert.match(h.out(), /restart any open session/, "hooks are read at startup, not live");
});

test("a settings file that will not parse is left completely alone", () => {
	const h = harness({ "/s.json": "{ not json" });
	assert.equal(main(["/s.json"], h.io, COMMAND), 1);
	assert.equal(h.saved["/s.json"], "{ not json");
	assert.equal(h.saved["/s.json.craft-backup"], undefined, "nothing was touched, so nothing was backed up");
	assert.match(h.err(), /refusing to touch/);
});

test("a missing settings file is created without a backup of nothing", () => {
	const h = harness({});
	assert.equal(main(["/new.json"], h.io, COMMAND), 0);
	assert.equal(h.saved["/new.json.craft-backup"], undefined);
	assert.ok(JSON.parse(h.saved["/new.json"]).hooks.SessionStart);
});

test("a second run reports the no-op instead of rewriting the file", () => {
	const first = harness({});
	main(["/s.json"], first.io, COMMAND);
	const second = harness({ "/s.json": first.saved["/s.json"] });
	assert.equal(main(["/s.json"], second.io, COMMAND), 0);
	assert.match(second.out(), /already registered/);
	assert.equal(second.saved["/s.json.craft-backup"], undefined);
});

test("no path argument exits 2", () => {
	const h = harness({});
	assert.equal(main([], h.io, COMMAND), 2);
	assert.match(h.err(), /usage:/);
});
