#!/usr/bin/env node
// Generate Claude Code agent definitions from `agents/*.md`.
//
//   craft-agents <source-dir> <output-dir>
//
// Exits nonzero on the first file it cannot port. `link-global` calls this, and an
// agent that silently lost a tool is worse than a link step that stops and says so.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(
	process.execPath,
	["--experimental-strip-types", join(here, "../src/agent-port-cli.ts"), ...process.argv.slice(2)],
	{ stdio: "inherit" },
);
process.exit(result.status ?? 1);
