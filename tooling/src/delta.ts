import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join as joinPath } from "node:path";

export interface RenderDelta {
	r_base: string;
	changed_files: string[];
	validation: Array<{ command: string; exit_code: number }>;
	source_locations: string[];
}

function git(root: string, args: string[]): string {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8" });
	} catch (error) {
		const err = error as { stdout?: string };
		return err.stdout ?? "";
	}
}

export function collectDelta(
	root: string,
	base: string,
	validation: Array<{ command: string; exit_code: number }>,
): RenderDelta {
	const tracked = git(root, ["diff", "--name-only", "--no-renames", base]);
	const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]);
	const files = [...new Set([...tracked.split("\n"), ...untracked.split("\n")].map((line) => line.trim()).filter(Boolean))].sort();
	const locations: string[] = [];
	const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
	for (const file of files) {
		const trackedPatch = git(root, ["diff", "-U0", "--no-renames", base, "--", file]);
		const used = trackedPatch.trim()
			? trackedPatch
			: `@@ -0,0 +1,${Math.max(1, readFileSync(joinPath(root, file), "utf8").split("\n").length - 1)} @@\n`;
		for (const line of used.split("\n")) {
			const match = hunk.exec(line);
			if (!match) continue;
			const start = Number(match[1]);
			const count = match[2] === undefined ? 1 : Number(match[2]);
			if (count === 0) continue;
			locations.push(count === 1 ? `${file}:${start}` : `${file}:${start}-${start + count - 1}`);
		}
	}
	return {
		r_base: base,
		changed_files: files,
		validation: [...validation].sort((a, b) => a.command.localeCompare(b.command) || a.exit_code - b.exit_code),
		source_locations: locations.sort(),
	};
}

export function serializeDelta(delta: RenderDelta): string {
	const q = (value: string) => JSON.stringify(value);
	const lines = [`r_base: ${q(delta.r_base)}`, "changed_files:"];
	if (!delta.changed_files.length) lines[lines.length - 1] += " []";
	else for (const file of delta.changed_files) lines.push(`  - ${q(file)}`);
	lines.push("validation:");
	if (!delta.validation.length) lines[lines.length - 1] += " []";
	else {
		for (const item of delta.validation) {
			lines.push(`  - command: ${q(item.command)}`);
			lines.push(`    exit_code: ${item.exit_code}`);
		}
	}
	lines.push("source_locations:");
	if (!delta.source_locations.length) lines[lines.length - 1] += " []";
	else for (const loc of delta.source_locations) lines.push(`  - ${q(loc)}`);
	return lines.join("\n") + "\n";
}

export function assertPacketUntouched(path: string | undefined, beforeMtime: number | undefined): void {
	if (!path) return;
	if (!existsSync(path)) throw new Error(`discovery packet missing: ${path}`);
	if (beforeMtime !== undefined && statSync(path).mtimeMs !== beforeMtime) {
		throw new Error("discovery packet was rewritten");
	}
}
