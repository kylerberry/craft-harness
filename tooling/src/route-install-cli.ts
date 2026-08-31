#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RouteError, SUPPORTED_HOST, installRoutes, type Settings } from "./route-install.ts";

const USAGE = `Usage: craft-routes --host pi --settings PATH [--apply] [--dry-run]
`;

function arg(flag: string, argv: string[]): string | undefined {
	const i = argv.indexOf(flag);
	return i === -1 ? undefined : argv[i + 1];
}

export function main(argv: string[]): number {
	if (argv.includes("-h") || argv.includes("--help")) {
		process.stdout.write(USAGE);
		return 0;
	}
	const host = arg("--host", argv);
	const path = arg("--settings", argv);
	if (!host || !path) {
		process.stderr.write(`missing --host or --settings\n${USAGE}`);
		return 2;
	}
	if (host !== SUPPORTED_HOST) {
		process.stderr.write(`unsupported host ${host}: only ${SUPPORTED_HOST} is supported\n`);
		return 2;
	}
	let parsed: Settings;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as Settings;
	} catch (error) {
		process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
		return 2;
	}
	try {
		const { settings, changed } = installRoutes(parsed, host, { apply: argv.includes("--apply") });
		if (!argv.includes("--dry-run")) writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
		process.stdout.write(changed.length === 0 ? "unchanged\n" : `updated ${changed.join(",")}\n`);
		return 0;
	} catch (error) {
		process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
		return error instanceof RouteError ? 2 : 1;
	}
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
