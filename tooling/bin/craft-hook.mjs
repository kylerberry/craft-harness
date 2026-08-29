#!/usr/bin/env node
// Claude Code hook entry point. Unlike the CLI shims this does the work in-process:
// it runs on every tool call, so a second node start would double the latency the
// agent loop pays for metrics it never asked for.
//
// Every failure path exits 0 with no output. A hook that errors is a hook that
// interrupts the session, and metrics are never worth that.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let raw = "";
try {
	raw = readFileSync(0, "utf8");
} catch {
	// No stdin (invoked by hand, or a host that sends nothing) — nothing to do.
}

try {
	const adapter = join(dirname(fileURLToPath(import.meta.url)), "../extensions/claude-code.ts");
	const { main } = await import(pathToFileURL(adapter).href);
	const output = main(raw);
	if (output) process.stdout.write(output);
} catch {
	// Includes the case where this node build cannot strip types from the adapter.
}

process.exit(0);
