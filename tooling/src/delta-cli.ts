#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPacketUntouched, collectDelta, serializeDelta } from "./delta.ts";

const USAGE = `Usage: craft-delta --base REF [--verify-command CMD --exit-code N] [--packet PATH] [--cwd PATH]\n`;

function values(flag: string, argv: string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1]) result.push(argv[++i]);
	return result;
}
function value(flag: string, argv: string[]): string | undefined {
	return values(flag, argv)[0];
}

export function main(argv: string[]): number {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(USAGE);
		return 0;
	}
	const base = value("--base", argv);
	if (!base) {
		process.stderr.write(`missing --base\n${USAGE}`);
		return 2;
	}
	const commands = values("--verify-command", argv);
	const codes = values("--exit-code", argv);
	if (commands.length !== codes.length) {
		process.stderr.write("each --verify-command needs a matching --exit-code\n");
		return 2;
	}
	try {
		const cwd = value("--cwd", argv) ?? process.cwd();
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
		const packet = value("--packet", argv);
		const mtime = packet ? statSync(packet).mtimeMs : undefined;
		const delta = collectDelta(
			root,
			base,
			commands.map((command, i) => ({ command, exit_code: Number(codes[i]) })),
		);
		assertPacketUntouched(packet, mtime);
		const dir = mkdtempSync(join(tmpdir(), "craft-delta-"));
		const path = join(dir, "delta.yaml");
		writeFileSync(path, serializeDelta(delta), { mode: 0o600 });
		process.stdout.write(path + "\n");
		return 0;
	} catch (error) {
		process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
		return 2;
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
