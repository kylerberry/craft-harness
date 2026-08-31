import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const PACKET_BYTE_LIMIT = 65536;
export const PACKET_ITEM_LIMIT = 200;
const SECRET = /(?:token|password|secret|api[_-]?key)\s*[=:]\s*\S+|sk-[A-Za-z0-9_-]{8,}/i;

export class PacketBlocked extends Error {
	reason: string;
	constructor(reason: string) {
		super(reason);
		this.reason = reason;
	}
}

export interface EvidencePacket {
	schema_version: 1;
	base_commit: string;
	graph_status: "current" | "stale" | "unavailable";
	authority_sources: Array<{ path: string; lines: string }>;
	task_sources: Array<{ path: string; lines: string; content_hash: string }>;
	graph_candidates: Array<{ path: string; reason: string }>;
	verified_facts: Array<{ fact: string; source: string }>;
	evidence_gaps: string[];
}

function posix(path: string): string { return path.split(sep).join("/"); }
function lineRange(text: string): string { return `1-${Math.max(1, text.split("\n").length - (text.endsWith("\n") ? 1 : 0))}`; }
function inside(root: string, path: string): boolean { return path === root || path.startsWith(root + sep); }
function rel(root: string, path: string): string { return posix(relative(root, path)); }

function checkedFile(root: string, path: string): string {
	const resolved = realpathSync(path);
	if (!inside(root, resolved) || !statSync(resolved).isFile()) throw new Error(`source is not a repository file: ${path}`);
	return resolved;
}

/** Classify graph.json against the current revision. Never spawn or rebuild Graphify. */
function graphEvidence(root: string, commit: string): Pick<EvidencePacket, "graph_status" | "graph_candidates"> {
	const graph = join(root, "graphify-out", "graph.json");
	if (!existsSync(graph)) return { graph_status: "unavailable", graph_candidates: [] };
	try {
		const parsed = JSON.parse(readFileSync(graph, "utf8"));
		const current = parsed.base_commit === commit || parsed.commit === commit || parsed.revision === commit;
		if (!current) return { graph_status: "stale", graph_candidates: [] };
		const candidates = Array.isArray(parsed.graph_candidates) ? parsed.graph_candidates : Array.isArray(parsed.candidates) ? parsed.candidates : [];
		return {
			graph_status: "current",
			graph_candidates: candidates
				.filter((item: unknown): item is { path: string; reason: string } => !!item && typeof (item as any).path === "string" && typeof (item as any).reason === "string")
				.map((item: { path: string; reason: string }) => ({ path: item.path, reason: item.reason }))
				.sort((a: { path: string; reason: string }, b: { path: string; reason: string }) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason)),
		};
	} catch { return { graph_status: "stale", graph_candidates: [] }; }
}

export function collectEvidence(rootInput: string, commit: string, taskInputs: string[], factInputs: string[]): EvidencePacket {
	const root = realpathSync(rootInput);
	const gaps: string[] = [];
	const authority = new Map<string, { path: string; lines: string }>();
	const tasks = taskInputs.map((input) => {
		const full = checkedFile(root, resolve(root, input));
		const text = readFileSync(full, "utf8");
		if (SECRET.test(text)) throw new PacketBlocked(`secret or credential in ${rel(root, full)}`);
		for (let dir = dirname(full); inside(root, dir); dir = dirname(dir)) {
			const candidate = join(dir, "AGENTS.md");
			if (existsSync(candidate)) {
				const file = checkedFile(root, candidate);
				const body = readFileSync(file, "utf8");
				authority.set(rel(root, file), { path: rel(root, file), lines: lineRange(body) });
			}
			if (dir === root) break;
		}
		return { path: rel(root, full), lines: lineRange(text), content_hash: `sha256:${createHash("sha256").update(readFileSync(full)).digest("hex")}` };
	});

	const indexPath = join(root, "docs", "wiki", "index.md");
	if (existsSync(indexPath)) {
		const index = checkedFile(root, indexPath);
		const body = readFileSync(index, "utf8");
		authority.set(rel(root, index), { path: rel(root, index), lines: lineRange(body) });
		const links = [...body.matchAll(/\[([^\]]*current[^\]]*)\]\(([^)]+)\)/gi)].map((m) => m[2].trim()).sort();
		const resolved: string[] = [];
		for (const link of links) {
			if (/^[a-z]+:/i.test(link)) { gaps.push(`unresolved authority source: ${link}`); continue; }
			try { resolved.push(checkedFile(root, resolve(dirname(index), link))); }
			catch { gaps.push(`unresolved authority source: ${link}`); }
		}
		if (links.length === 0) gaps.push(`unresolved authority source: ${rel(root, index)} has no current link`);
		if (resolved.length > 1) gaps.push(`authority conflict: ${resolved.map((p) => rel(root, p)).sort().join(", ")}`);
		for (const raw of resolved) {
			const rawBody = readFileSync(raw, "utf8");
			authority.set(rel(root, raw), { path: rel(root, raw), lines: lineRange(rawBody) });
		}
	}

	const verified: EvidencePacket["verified_facts"] = [];
	for (const input of factInputs) {
		const split = input.indexOf("::");
		const claim = split < 0 ? input : input.slice(0, split);
		const citation = split < 0 ? "" : input.slice(split + 2);
		const match = /^(.*):(\d+)$/.exec(citation);
		if (!match) { gaps.push(`unsupported fact: ${claim} (invalid citation ${citation})`); continue; }
		try {
			const file = checkedFile(root, resolve(root, match[1]));
			const line = Number(match[2]);
			const sourceLine = readFileSync(file, "utf8").split("\n")[line - 1];
			if (sourceLine?.includes(claim)) verified.push({ fact: claim, source: `${rel(root, file)}:${line}` });
			else gaps.push(`unsupported fact: ${claim} at ${rel(root, file)}:${line}`);
		} catch { gaps.push(`unsupported fact: ${claim} at ${citation}`); }
	}

	const graph = graphEvidence(root, commit);
	const packet: EvidencePacket = {
		schema_version: 1,
		base_commit: commit,
		graph_status: graph.graph_status,
		authority_sources: [...authority.values()].sort((a, b) => a.path.localeCompare(b.path)),
		task_sources: tasks.sort((a, b) => a.path.localeCompare(b.path)),
		graph_candidates: graph.graph_candidates,
		verified_facts: verified.sort((a, b) => a.source.localeCompare(b.source) || a.fact.localeCompare(b.fact)),
		evidence_gaps: [...new Set(gaps)].sort(),
	};
	for (const list of [packet.authority_sources, packet.task_sources, packet.graph_candidates, packet.verified_facts, packet.evidence_gaps]) {
		if (list.length > PACKET_ITEM_LIMIT) throw new PacketBlocked(`packet exceeds item bound ${PACKET_ITEM_LIMIT}`);
	}
	return packet;
}

const q = (value: string) => JSON.stringify(value);
export function serializeEvidence(packet: EvidencePacket): string {
	const lines = [`schema_version: ${packet.schema_version}`, `base_commit: ${q(packet.base_commit)}`, `graph_status: ${packet.graph_status}`];
	const objectList = (name: string, values: Array<Record<string, string>>, keys: string[]) => {
		lines.push(`${name}:`);
		if (!values.length) { lines[lines.length - 1] += " []"; return; }
		for (const value of values) {
			lines.push(`  - ${keys[0]}: ${q(value[keys[0]])}`);
			for (const key of keys.slice(1)) lines.push(`    ${key}: ${q(value[key])}`);
		}
	};
	objectList("authority_sources", packet.authority_sources, ["path", "lines"]);
	objectList("task_sources", packet.task_sources, ["path", "lines", "content_hash"]);
	objectList("graph_candidates", packet.graph_candidates, ["path", "reason"]);
	objectList("verified_facts", packet.verified_facts, ["fact", "source"]);
	lines.push("evidence_gaps:" + (packet.evidence_gaps.length ? "" : " []"));
	for (const gap of packet.evidence_gaps) lines.push(`  - ${q(gap)}`);
	const yaml = lines.join("\n") + "\n";
	if (Buffer.byteLength(yaml, "utf8") > PACKET_BYTE_LIMIT) throw new PacketBlocked(`packet exceeds size bound ${PACKET_BYTE_LIMIT}`);
	return yaml;
}
