#!/usr/bin/env node
// Register the metrics hooks in a Claude Code settings file. Merges into what is
// already there, backs the file up first, and is a no-op on re-run.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "../src/hooks-install-cli.ts");
const result = spawnSync(process.execPath, ["--experimental-strip-types", cli, ...process.argv.slice(2)], {
	stdio: "inherit",
});
process.exit(result.status ?? 1);
