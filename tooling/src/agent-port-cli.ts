#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PortError, portAgent, renderAgent } from "./agent-port.ts";

/** Injected so the command can be tested without writing to a real agents directory. */
export interface Io {
	write(s: string): void;
	error(s: string): void;
	read(path: string): string;
	list(dir: string): string[];
	save(path: string, contents: string): void;
}

export const defaultIo: Io = {
	write: (s) => process.stdout.write(s),
	error: (s) => console.error(s),
	read: (path) => readFileSync(path, "utf8"),
	list: (dir) => readdirSync(dir),
	save: (path, contents) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, contents);
	},
};

const USAGE = `craft-agents — generate Claude Code agent definitions from CRAFTS agents

Usage:
  craft-agents <source-dir> <output-dir>

Reads every *.md in <source-dir> and writes the Claude Code form to <output-dir>,
keeping the agent name and body identical. Names are load-bearing: the phase map,
the blinding targets, and the hook matcher all key on them.
`;

export function main(argv: string[], io: Io = defaultIo): number {
	const [source, out] = argv;
	if (!source || !out || source === "-h" || source === "--help") {
		io.write(USAGE);
		return source && out ? 0 : 2;
	}

	let files: string[];
	try {
		files = io.list(source).filter((f) => f.endsWith(".md")).sort();
	} catch (err) {
		io.error(`cannot read ${source}: ${err instanceof Error ? err.message : String(err)}`);
		return 2;
	}
	if (files.length === 0) {
		io.error(`no agent files in ${source}`);
		return 2;
	}

	for (const file of files) {
		let ported;
		try {
			ported = portAgent(io.read(join(source, file)));
		} catch (err) {
			// Naming the file matters — the error text only knows the agent's own name.
			io.error(`${file}: ${err instanceof PortError ? err.message : String(err)}`);
			return 1;
		}
		// Written under the agent's own name, not the source filename, so the file a
		// matcher or phase map refers to is the file on disk.
		io.save(join(out, `${ported.name}.md`), renderAgent(ported));
		io.write(`${ported.name}  ${ported.tools.join(", ") || "(no tools)"}\n`);
	}
	io.write(`\n${files.length} agent${files.length === 1 ? "" : "s"} → ${out}\n`);
	return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
