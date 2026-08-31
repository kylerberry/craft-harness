import type { Run } from "./schema.ts";

/**
 * Which revision of the CRAFTS workflow produced a run.
 *
 * The workflow changes — phases merge, agents collapse, gates appear. Metrics
 * collected across a change describe two different workflows averaged together,
 * which is worse than no metrics: it looks like signal. This happened already.
 * Every recorded `counsel` phase used the three-agent plan-review panel, so its
 * ~12 min/invoke is a panel's wall time; the single-reviewer `craft-counsel` that
 * replaced it has never been measured, and averaging the two would have silently
 * mixed them.
 *
 * Going forward the conductor declares the version at `start`. Backward, runs
 * predate the flag entirely, so their shape is inferred from what they actually
 * spawned. Inference is marked as such — a guess must never be mistaken for a
 * declaration.
 */

export type VersionSource = "declared" | "inferred" | "unknown";

/** Current toolkit version. Bump when a phase's shape changes: agents added or
 *  removed, duties moved between phases, gates introduced. Not for wording. */
export const CURRENT_CRAFT_VERSION = "5";

/**
 * Shape fingerprints, most recent first. Each entry lists agent-name fragments and
 * structural markers that only exist in that revision. Any single hit is decisive —
 * these are agents that were removed outright, not renamed, so their presence dates
 * a run unambiguously.
 */
const hasDiscovery = (run: Run) => run.phases.some((p) => p.name === "D");

const SIGNATURES: Array<{ version: string; agents: string[]; structural: (run: Run) => boolean }> = [
	{
		version: "5",
		agents: [],
		structural: hasDiscovery,
	},
	{
		version: "4",
		// Single merged counsel reviewer; simplify and Sharpen folded into the
		// conductor; verify gate, payload blinding, and the R decision record added.
		agents: ["craft-counsel"],
		structural: (run) =>
			run.verify_count > 0 ||
			run.phases.some((p) => p.decisions !== undefined || p.plan_deviations !== undefined || p.blinding_scrubs > 0),
	},
	{
		version: "3",
		// Three-agent plan-review panel, with simplify and Sharpen as spawned agents.
		agents: ["craft-plan-", "craft-code-simplifier", "craft-sharpener"],
		structural: () => false,
	},
];

function agentText(run: Run): string {
	// Agent fields have historically held a comma-joined list for parallel spawns
	// (one `phase_enter` naming all three counsel reviewers), so match on substrings
	// rather than comparing whole values.
	const parts: string[] = [];
	for (const p of run.phases) {
		if (p.agent) parts.push(p.agent);
		parts.push(...p.agents);
	}
	return parts.join(",");
}

/**
 * Infer which workflow revision a run came from. Returns undefined when the run
 * carries no distinguishing marks — a bare run with no agents recorded could be
 * any version, and saying so is more useful than picking one.
 */
export function inferCraftVersion(run: Run): string | undefined {
	const text = agentText(run);
	const matched = SIGNATURES.filter((s) => {
		if (s.version !== "5" && hasDiscovery(run)) return false;
		return s.agents.some((a) => text.includes(a)) || s.structural(run);
	});
	// Signals from two revisions in one run means the fingerprints are wrong or the
	// toolkit changed mid-run. Either way, refuse rather than pick.
	if (matched.length !== 1) return undefined;
	return matched[0].version;
}

/**
 * Resolve a run's version and how confidently. Declared always wins; inference
 * only fills gaps left by runs recorded before the flag existed.
 */
export function resolveCraftVersion(run: Run): { version: string | undefined; source: VersionSource } {
	if (run.craft_version) return { version: run.craft_version, source: "declared" };
	const inferred = inferCraftVersion(run);
	if (inferred) return { version: inferred, source: "inferred" };
	return { version: undefined, source: "unknown" };
}

/**
 * Annotate a folded run in place, so callers can group without re-deriving.
 *
 * A version already recorded in the log wins — whether the skill declared it or
 * an earlier inference was persisted. Re-inferring over a persisted value would
 * make the stored record pointless and could silently disagree with it after a
 * classifier change, which is the opposite of why it was stored.
 */
export function applyCraftVersion(run: Run): void {
	if (run.craft_version_source) return;
	const { version, source } = resolveCraftVersion(run);
	run.craft_version = version;
	run.craft_version_source = source;
}
