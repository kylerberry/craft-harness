---
name: decompose-to-dag
description: Decompose a feature spec, issue, or free-form work request into a validated DAG of independently verifiable work nodes (JSON artifact) ready for execute-dag. Use when the user wants to plan multi-node work, slice a spec into buildable units, or produce a DAG/plan graph before implementation.
---

# decompose-to-dag

Turn a spec or work request into a validated DAG artifact. You are the decomposer: you own **structure** (carving units and wiring dependencies), not implementation detail.

## Input

Anything: a spec file, issue text, pasted requirements, or a rough goal. Ask for the target repository/branch if not obvious from context.

## Output artifact

Write `dag.json` next to the work (or the path the user names):

```json
{
  "meta": {
    "spec": "<one-line source description>",
    "repo": "<repo path>", "branch": "<base branch>",
    "created": "<date>"
  },
  "nodes": [
    {
      "id": "n1",
      "intent": "One observable outcome, imperative",
      "change_spec": "What changes, where, and how it is verified — 1-4 sentences",
      "acceptance_criteria": ["<testable criterion>", "..."],
      "depends_on": []
    }
  ]
}
```

Exactly five node fields. No status, no owner, no model, no estimates.

## Slicing rules

1. **One independently verifiable outcome per node.** A node must be acceptable on its own: its criteria can be checked without an uncommitted sibling. Keep together only when one correct outcome requires an inseparable cross-surface change (note the exception in `change_spec`). Composing already-accepted pieces is not that exception. Every node must pass these split tests:
   - **Cover-up:** hide one AC; if the rest is still a mergeable outcome, split.
   - **Disjoint oracle:** disjoint fixture families, Reason Codes, Destinations, or pipeline stages → split.
   - **Reviewer budget:** a human can confirm pass/fail from this node's diff + ACs in 5–10 minutes, spec closed except rows the ACs cite.
2. **No bundling.** Unrelated cleanup, refactors, or docs not required for a node's outcome become their own node or get dropped.
3. **Dependencies are semantic, not sequential convenience.** `depends_on` only when node B literally cannot be built or verified without node A's output.
4. **Compose nodes stay thin.** A node that wires previously accepted modules may only assert order, short-circuit, and that child outputs are used. If its ACs re-prove child behavior, split.
5. **Intent smells → split before validation.** `and`; a comma-separated family list; `orchestrate`; `all` / `every` scenario or gate; `ordered … guards`.
6. **Probe nodes for material uncertainty.** If an unresolved boundary could change the design or invalidate several nodes (integration contract, framework behavior, migration viability, performance assumption), emit a probe node: a `Probe: ...` intent whose change_spec names the hypothesis, and whose acceptance_criteria demand a **durable, mergeable artifact** (fixture, contract test, interface, benchmark result, seam) — never a report-only outcome. Local uncertainty that affects one node stays inside that node; do not create probe nodes for it.
7. **Probe failure semantics live in the criteria.** A probe that disproves its hypothesis fails; it never passes merely for "learning something."

## Validation checklist (run before finishing)

- [ ] ids unique; every `depends_on` reference exists
- [ ] no cycles (topological sort succeeds)
- [ ] every node has ≥1 testable acceptance criterion
- [ ] every node traces to the spec intent; nothing invented, nothing dropped
- [ ] no node contains two independently acceptable outcomes
- [ ] cover-up, disjoint-oracle, and reviewer-budget pass for every node
- [ ] no compose node restates child ACs
- [ ] no intent smell remains
- [ ] probe nodes produce durable artifacts, not prose

## Finish

Default on: before presenting, run an adversarial pass in this session as reviewer, not decomposer. Opt out only if the user says `--review-budget off`. Do not defer this to `execute-dag`. Fixed attacks:

- Two-PR test: if one node's ACs can name two mergeable PRs, split.
- Count distinct Reason Codes, Destinations, and pipeline stages in the ACs.
- Intent smells.
- 10-minute accept with the spec closed except cited rows.

On any fail: split, re-validate, then present.

Present the DAG as a summary table (id, intent, deps, wave number) plus the validation results, and stop. **Do not begin implementation.** The DAG is executed by the `execute-dag` skill only after the user approves the artifact (`--merge auto|hitl`, `--protocol craft|craft-hitl|craft-lite`).
