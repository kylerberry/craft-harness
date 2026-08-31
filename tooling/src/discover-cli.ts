#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectEvidence, serializeEvidence } from "./discover.ts";

const USAGE = `Usage: craft-discover --task-source PATH [--task-source PATH ...] [--fact "CLAIM::PATH:LINE"] [--cwd PATH]\n`;

function values(flag: string, argv: string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1]) result.push(argv[++i]);
	return result;
}
function value(flag: string, argv: string[]): string | undefined { return values(flag, argv)[0]; }

export function main(argv: string[]): number {
	if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(USAGE); return 0; }
	const allowed = new Set(["--cwd", "--task-source", "--fact"]);
	for (let i = 0; i < argv.length; i += 2) {
		if (!allowed.has(argv[i]) || !argv[i + 1]) { process.stderr.write(`invalid argument: ${argv[i] ?? ""}\n${USAGE}`); return 2; }
	}
	const tasks = values("--task-source", argv);
	if (!tasks.length) { process.stderr.write(`missing --task-source\n${USAGE}`); return 2; }
	try {
		const cwd = value("--cwd", argv) ?? process.cwd();
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
		const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		const packet = collectEvidence(root, commit, tasks, values("--fact", argv));
		const dir = mkdtempSync(join(tmpdir(), "craft-discover-"));
		const path = join(dir, "evidence.yaml");
		writeFileSync(path, serializeEvidence(packet), { mode: 0o600 });
		process.stdout.write(path + "\n");
		const blocked = packet.evidence_gaps.some((gap) => gap.startsWith("authority conflict:") || gap.startsWith("unresolved authority source:"));
		if (blocked) process.stderr.write(packet.evidence_gaps.filter((gap) => gap.includes("authority")).join("; ") + "\n");
		return blocked ? 1 : 0;
	} catch (error) {
		process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
		return 2;
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
