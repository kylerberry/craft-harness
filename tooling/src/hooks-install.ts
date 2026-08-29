/**
 * Register the metrics hooks in a Claude Code settings file.
 *
 * This edits a file the user owns and did not necessarily write for us, so the rules
 * are: merge, never replace; add only what is missing; leave every other hook and
 * setting exactly as found. Re-running must be a no-op, because `link-global` is run
 * often and a settings file that grows a duplicate hook per run would slow every
 * tool call in every session.
 */

/** Which events the adapter needs, and the matcher each one is registered under. */
export const HOOK_EVENTS: Array<{ event: string; matcher?: string; why: string }> = [
	{ event: "SessionStart", why: "pick up a run that was already open in this cwd" },
	{ event: "UserPromptSubmit", why: "open a run when the prompt starts a CRAFTS protocol" },
	// Narrow on purpose: this is the only handler that rewrites a tool's input, and
	// it should not be in the path of every Read and Bash in the session.
	{ event: "PreToolUse", matcher: "Agent|Task", why: "blind a reviewer's payload before the subagent spawns" },
	{ event: "PostToolUse", why: "bill the turns and count the tool call" },
	{ event: "PostToolUseFailure", why: "same, plus classify quota / timeout / failover" },
	{ event: "SubagentStop", why: "bill a subagent from its own transcript" },
	{ event: "Stop", why: "bill the last turn of the exchange" },
	{ event: "SessionEnd", why: "final flush, then drop this session's bookkeeping" },
];

interface HookEntry {
	type?: string;
	command?: string;
}

interface MatcherEntry {
	matcher?: string;
	hooks?: HookEntry[];
}

export interface Settings {
	hooks?: Record<string, MatcherEntry[]>;
	[key: string]: unknown;
}

function registered(entries: MatcherEntry[], command: string, matcher?: string): boolean {
	return entries.some(
		(entry) => (entry.matcher ?? undefined) === matcher && (entry.hooks ?? []).some((h) => h.command === command),
	);
}

export interface InstallResult {
	settings: Settings;
	/** Events newly registered. Empty means the file already had everything. */
	added: string[];
}

/**
 * Return the settings with every missing hook added. The input is not mutated, so a
 * caller can compare before deciding whether the file needs rewriting at all.
 */
export function withHooks(settings: Settings, command: string): InstallResult {
	const next: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
	const added: string[] = [];
	for (const { event, matcher } of HOOK_EVENTS) {
		const entries = [...(next.hooks![event] ?? [])];
		if (registered(entries, command, matcher)) continue;
		entries.push({
			...(matcher ? { matcher } : {}),
			hooks: [{ type: "command", command }],
		});
		next.hooks![event] = entries;
		added.push(event);
	}
	return { settings: next, added };
}
