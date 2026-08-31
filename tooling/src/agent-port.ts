/**
 * Translate a CRAFTS agent definition into Claude Code's dialect.
 *
 * The agent files in `agents/` are written for Pi: lowercase tool names, an
 * `input_schema`, and presentation keys Claude Code has no use for. Claude Code
 * wants `name`, `description`, and a comma-separated `tools` line.
 *
 * These are *generated*, never hand-maintained. Two copies of an agent prompt drift,
 * and the drift is invisible until a reviewer behaves differently on one host than
 * the other — which is exactly the comparison the metrics exist to make.
 */

/**
 * Pi's tool vocabulary → Claude Code's, and Claude Code's onto itself.
 *
 * The identity half makes porting idempotent, so re-running the generator over its
 * own output is a no-op rather than an agent that silently comes back with no tools.
 */
export const TOOL_MAP: Record<string, string> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	grep: "Grep",
	// Pi's `find` is a path search, which is Glob here — not the Bash `find` binary.
	find: "Glob",
	bash: "Bash",
	// Claude Code has called this both things; `Agent` is the current name.
	subagent: "Agent",
	Read: "Read",
	Write: "Write",
	Edit: "Edit",
	Grep: "Grep",
	Glob: "Glob",
	Bash: "Bash",
	Agent: "Agent",
};

/** Pi-only tools. Omitted from Claude Code output rather than mapped or rejected. */
export const PI_ONLY_TOOLS = new Set(["subagent_wait"]);

/**
 * Frontmatter keys that exist only for Pi. Listed rather than inferred so that a new
 * key added upstream reaches `portAgent` as an unknown and gets a decision, instead
 * of being silently carried into a file Claude Code will not understand.
 */
const PI_ONLY = new Set([
	"context",
	"extensions",
	"input_schema",
	"color",
	"icon",
	"priority",
	"command",
	"acceptanceRole",
	"completionGuard",
]);

export interface PortedAgent {
	name: string;
	description: string;
	tools: string[];
	body: string;
}

export class PortError extends Error {}

interface Frontmatter {
	scalars: Map<string, string>;
	tools: string[];
	keys: string[];
}

/**
 * Read the leading `---` block. Deliberately not a YAML parser: the inputs are a
 * fixed set of `key: value` lines plus one list, and a real parser would be a
 * dependency this repo does not otherwise carry.
 */
function parseFrontmatter(source: string): { front: Frontmatter; body: string } {
	const lines = source.split("\n");
	if (lines[0]?.trim() !== "---") throw new PortError("no frontmatter block");
	const end = lines.indexOf("---", 1);
	if (end === -1) throw new PortError("unterminated frontmatter block");

	const scalars = new Map<string, string>();
	const keys: string[] = [];
	const tools: string[] = [];
	let inTools = false;
	for (const line of lines.slice(1, end)) {
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item) {
			if (inTools) tools.push(unquote(item[1]));
			continue;
		}
		const entry = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (!entry) continue;
		const [, key, rest] = entry;
		keys.push(key);
		inTools = key === "tools";
		if (inTools) {
			// Two spellings: Pi's block list (handled above) and the inline comma form
			// this generator itself emits. Reading only the first would drop every tool
			// when porting an already-ported file.
			for (const tool of rest.split(",")) {
				const name = unquote(tool);
				if (name) tools.push(name);
			}
			continue;
		}
		if (rest !== "") scalars.set(key, unquote(rest));
	}
	return { front: { scalars, tools, keys }, body: lines.slice(end + 1).join("\n") };
}

function unquote(value: string): string {
	const trimmed = value.trim();
	const quoted = /^"(.*)"$|^'(.*)'$/.exec(trimmed);
	return quoted ? (quoted[1] ?? quoted[2]) : trimmed;
}

/**
 * Port one agent file. Throws rather than guessing: an agent that silently loses a
 * tool still loads, still runs, and quietly cannot do its job.
 */
export function portAgent(source: string): PortedAgent {
	const { front, body } = parseFrontmatter(source);
	const name = front.scalars.get("name");
	const description = front.scalars.get("description");
	if (!name) throw new PortError("frontmatter has no name");
	if (!description) throw new PortError(`${name}: frontmatter has no description`);

	const tools = front.tools.flatMap((tool) => {
		if (PI_ONLY_TOOLS.has(tool)) return [];
		const mapped = TOOL_MAP[tool];
		if (!mapped) throw new PortError(`${name}: no Claude Code equivalent for tool \`${tool}\``);
		return [mapped];
	});

	for (const key of front.keys) {
		if (key === "name" || key === "description" || key === "tools") continue;
		if (PI_ONLY.has(key)) continue;
		// `model` is the one that matters: the repo sets none on purpose, so each host
		// routes the agent itself. A ported file that pins one would shadow that.
		throw new PortError(`${name}: unhandled frontmatter key \`${key}\` — decide whether Claude Code needs it`);
	}

	return { name, description, tools, body };
}

/** Render the ported agent as a Claude Code agent file. */
export function renderAgent(agent: PortedAgent): string {
	const front = [
		"---",
		`name: ${agent.name}`,
		`description: ${agent.description}`,
		// Omitting `tools` entirely would grant every tool, so an empty list is written
		// as an empty list.
		`tools: ${agent.tools.join(", ")}`,
		"---",
	];
	// No `model`: see portAgent. Body carried through byte-for-byte — it is the
	// agent's actual instructions, and this translation is about frontmatter only.
	return `${front.join("\n")}\n${agent.body}`;
}
