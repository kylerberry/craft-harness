#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_EVENTS, withHooks, type Settings } from "./hooks-install.ts";

export interface Io {
	write(s: string): void;
	error(s: string): void;
	read(path: string): string | undefined;
	save(path: string, contents: string): void;
	backup(from: string, to: string): void;
}

export const defaultIo: Io = {
	write: (s) => process.stdout.write(s),
	error: (s) => console.error(s),
	read: (path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined),
	save: (path, contents) => {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, contents);
	},
	backup: (from, to) => copyFileSync(from, to),
};

export function defaultCommand(): string {
	return join(homedir(), ".local", "bin", "craft-hook");
}

export function main(argv: string[], io: Io = defaultIo, command = defaultCommand()): number {
	const path = argv[0];
	if (!path) {
		io.error("usage: craft-hooks-install <settings.json>");
		return 2;
	}

	const raw = io.read(path);
	let settings: Settings = {};
	if (raw !== undefined && raw.trim() !== "") {
		try {
			settings = JSON.parse(raw) as Settings;
		} catch (err) {
			// Never overwrite a settings file we could not read — that is the user's
			// whole configuration, and a parse failure here is far more likely to be a
			// transient edit than a file worth replacing.
			io.error(`refusing to touch ${path}: ${err instanceof Error ? err.message : String(err)}`);
			return 1;
		}
	}

	const { settings: next, added } = withHooks(settings, command);
	if (added.length === 0) {
		io.write(`craft hooks already registered in ${path}\n`);
		return 0;
	}

	if (raw !== undefined) io.backup(path, `${path}.craft-backup`);
	io.save(path, `${JSON.stringify(next, null, 2)}\n`);
	for (const event of added) {
		const why = HOOK_EVENTS.find((h) => h.event === event)?.why ?? "";
		io.write(`+ ${event.padEnd(20)} ${why}\n`);
	}
	io.write(`\nregistered ${added.length} hook${added.length === 1 ? "" : "s"} in ${path}\n`);
	if (raw !== undefined) io.write(`previous settings saved to ${path}.craft-backup\n`);
	// Hooks are read at startup, so a running session keeps the old set.
	io.write("Claude Code reads hooks at startup — restart any open session to pick these up.\n");
	return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
