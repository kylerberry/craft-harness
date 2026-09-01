/**
 * Authorship blinding for adversarial reviewers.
 *
 * A and T are routed to a different model family from R to buy independent
 * judgment. That only removes same-model self-preference; the larger measured
 * effect is that *authorship labels* shift verdicts on identical text — judges
 * inflate under self-labels and deflate under other-labels. Under genuinely
 * blind evaluation the effect largely disappears.
 *
 * So strip author identity from the payload before it reaches the reviewer.
 * Decision provenance stays (A must still catch a thinly-rejected blocker);
 * only *who produced it* goes.
 */

/** Agents whose incoming payload gets scrubbed. */
export const BLIND_TARGETS = new Set(["craft-evaluator", "craft-security-review"]);

/** Payload fields that may carry the task text, in the order we try them. */
export const PAYLOAD_FIELDS = ["task", "prompt", "input", "message", "instructions"];

/**
 * Phase agents rewritten to their role, not their name. A neutral noun keeps the
 * sentence readable and carries no self/other signal; `[redacted]` everywhere
 * would be louder and harder to read for the same benefit.
 */
const AGENT_ROLE: Array<[RegExp, string]> = [
	[/\bcraft-planner\b/gi, "the planning step"],
	[/\bcraft-counsel\b/gi, "plan review"],
	[/\bcraft-plan-(?:feasibility|scope|security)\b/gi, "plan review"],
	[/\bcraft-code-simplifier\b/gi, "the cleanup step"],
	[/\bcraft-builder\b/gi, "the implementation step"],
	[/\bcraft-node-writer\b/gi, "the implementation step"],
	[/\bcraft-sharpener\b/gi, "the documentation step"],
];

/**
 * Model identity. Provider-qualified ids first, then bare family names, so
 * `zai/glm-5.2` collapses in one hit rather than leaving a dangling `glm-5.2`.
 */
const MODEL_PATTERNS: RegExp[] = [
	/\b(?:openai-codex|openai|anthropic|zai|xai|google|deepseek|mistralai|mistral|meta|openrouter|groq|ollama)\/[\w.\-:]+/gi,
	// Version suffixes stop at the last word char so a sentence-final period survives.
	/\b(?:gpt|claude|glm|grok|gemini|llama|qwen|deepseek|mistral|codestral|kimi)-\w+(?:\.\w+)*/gi,
	/\b(?:opus|sonnet|haiku|fable|terra|sol|luna)-\d+(?:\.\d+)*\b/gi,
	/\bo[1-9]-(?:mini|preview|pro)\b/gi,
];

/** DAG bookkeeping that reveals the node/branch a change came from. */
const DAG_PATTERNS: Array<[RegExp, string]> = [
	[/(?:^|(?<=\s))\[n\d+\]\s*/gm, ""],
	[/\btmp\/worktree-n\d+(?:-attempt-\d+)?\b/gi, "the worktree"],
	[/\bworktree-n\d+(?:-attempt-\d+)?\b/gi, "the worktree"],
	[/\bdag\/n\d+(?:-attempt-\d+)?\b/gi, "the branch"],
];

export interface ScrubResult {
	text: string;
	/** Distinct authorship signals removed, for metrics and doctor. */
	hits: string[];
}

/**
 * Remove authorship signals from reviewer payload text.
 *
 * `self` is the target agent's own name — its identity is not an authorship
 * leak, so it is left alone.
 */
export function scrub(text: string, self?: string): ScrubResult {
	if (!text) return { text, hits: [] };
	const hits: string[] = [];
	let out = text;

	const record = (label: string) => {
		if (!hits.includes(label)) hits.push(label);
	};

	for (const [pattern, replacement] of AGENT_ROLE) {
		if (self && pattern.source.includes(self)) continue;
		out = out.replace(pattern, (m) => {
			record(m.toLowerCase());
			return replacement;
		});
	}

	for (const pattern of MODEL_PATTERNS) {
		out = out.replace(pattern, (m) => {
			record(m.toLowerCase());
			return "a model";
		});
	}

	for (const [pattern, replacement] of DAG_PATTERNS) {
		out = out.replace(pattern, (m) => {
			record(m.trim().toLowerCase());
			return replacement;
		});
	}

	return { text: out, hits };
}

/**
 * Regions the scrubber must leave alone, marked inline in the payload.
 *
 * Mutation survivors carry fragments of source as `replacement` values. In a
 * repository that mentions the agents by name — this one does — a mutated string
 * literal can legitimately contain `craft-evaluator`, and rewriting it to a role
 * noun corrupts the finding into something the reviewer cannot act on.
 *
 * The exemption is for code quoted as evidence, never for prose. Anything a
 * conductor writes about the work still goes through the scrubber.
 */
export const EXEMPT_OPEN = "<!--craft:verbatim-->";
export const EXEMPT_CLOSE = "<!--/craft:verbatim-->";

/** Wrap a block so `scrubPayload` passes it through untouched. */
export function verbatim(text: string): string {
	return `${EXEMPT_OPEN}\n${text}\n${EXEMPT_CLOSE}`;
}

/**
 * Split on exempt regions, returning alternating [scrubbable, verbatim, ...]
 * segments. An unclosed marker leaves the remainder verbatim: failing to scrub
 * is a defect the breach counter reports, while wrongly scrubbing a survivor
 * silently destroys evidence.
 */
export function splitExempt(text: string): Array<{ text: string; exempt: boolean }> {
	const parts: Array<{ text: string; exempt: boolean }> = [];
	let rest = text;
	while (rest.length > 0) {
		const open = rest.indexOf(EXEMPT_OPEN);
		if (open === -1) {
			parts.push({ text: rest, exempt: false });
			break;
		}
		if (open > 0) parts.push({ text: rest.slice(0, open), exempt: false });
		const after = open + EXEMPT_OPEN.length;
		const close = rest.indexOf(EXEMPT_CLOSE, after);
		if (close === -1) {
			parts.push({ text: rest.slice(open), exempt: true });
			break;
		}
		parts.push({ text: rest.slice(open, close + EXEMPT_CLOSE.length), exempt: true });
		rest = rest.slice(close + EXEMPT_CLOSE.length);
	}
	return parts;
}

/**
 * Scrub every payload field in place. Returns the distinct signals removed
 * across all fields. Mutates `input` — pi's `tool_call` hook patches arguments
 * by mutation, and the scrubbed payload is what the reviewer must actually see.
 *
 * Regions between the verbatim markers are copied through unchanged.
 */
export function scrubPayload(input: Record<string, unknown>, self?: string): string[] {
	const hits: string[] = [];
	for (const field of PAYLOAD_FIELDS) {
		const value = input[field];
		if (typeof value !== "string" || !value) continue;
		const segments = splitExempt(value);
		let changed = false;
		const rebuilt = segments
			.map((seg) => {
				if (seg.exempt) return seg.text;
				const result = scrub(seg.text, self);
				if (result.hits.length === 0) return seg.text;
				changed = true;
				for (const h of result.hits) if (!hits.includes(h)) hits.push(h);
				return result.text;
			})
			.join("");
		if (changed) input[field] = rebuilt;
	}
	return hits;
}
