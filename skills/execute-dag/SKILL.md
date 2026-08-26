---
name: execute-dag
command: execute-dag
argument-hint: "[--merge auto|hitl] [--protocol craft|craft-hitl|craft-lite] [dag.json]"
description: >-
  Execute an approved work DAG using the supervisor pattern. Wave-barrier
  dispatch (3 concurrent max), sequential merge-back, freeze-on-failure.
  Optional HITL merge review and selectable execution protocol
  (craft, craft-hitl, craft-lite). Use when the user provides a dag.json
  and wants it built.
---

# execute-dag

Build an approved DAG. You (this session) are the supervisor: you own dispatch, merging, and reporting. The `node-conductor` agent owns each node's protocol execution. Never implement node work yourself unless the DAG has exactly one node.

## Arguments

Parse from the invocation (skill args or the user message). Unknown flags are an error; stop.

| Flag | Values | Default |
| --- | --- | --- |
| `--merge` | `auto` \| `hitl` | `auto` |
| `--protocol` | `craft` \| `craft-hitl` \| `craft-lite` | `craft` |
| path | `dag.json` path | `./dag.json` |

`--merge` is supervisor policy. `--protocol` is passed through to every node-conductor; do not inline CRAFTS phases here.

`--protocol craft-hitl` means every node may pause inside Render at a `TODO(human)` seam. Use it only when nodes actually have those seams. Wave-merge review is `--merge hitl` and is independent of protocol.

## Preconditions

- A `dag.json` with `meta.repo`/`meta.branch` and a `nodes` array (five-field schema from `decompose-to-dag`).
- Explicit user approval of that DAG ("build it", a prior approval, or they authored it).
- Working tree clean; you are on `meta.branch` or will create nodes from it.
- `<meta.repo>/tmp/` exists or can be created and is ignored by Git (`git check-ignore -q tmp/`). Add `tmp/` to the repository `.gitignore` before dispatch if needed.

## Dispatch model — wave barrier

A node is **ready** when every `depends_on` node has status `passed` *and is merged* into the base branch.

A **wave** is the full ready set at dispatch time. Dispatch at most 3 node-conductors from that set. If the wave is larger than 3, the remainder stays queued in the same wave. Do not admit newly unblocked dependents until this wave is terminal and its approved passed nodes are merged.

### Worktree setup and launch (one per wave member, while slots remain)

The supervisor creates every node worktree before dispatch. Never use the subagent runtime's disposable managed worktrees for DAG nodes.

- Path: `<meta.repo>/tmp/worktree-<id>`; use `<meta.repo>/tmp/worktree-<id>-attempt-2` for the integration retry.
- Branch: `dag/<id>`; use `dag/<id>-attempt-2` for the integration retry.
- Base: the current `meta.branch` head after all dependencies have merged.
- Command shape: `git worktree add -b <branch> <path> <base-head>`.
- Refuse dispatch if the path or branch already exists unexpectedly; report it instead of deleting or reusing it.

```
runs.run(`node-${id}`, {
  agent: "node-conductor",
  cwd: <meta.repo>/tmp/worktree-<id>,
  worktree: false,
  skill: <protocol>,
  task: <node payload: protocol, id, intent, change_spec, acceptance_criteria verbatim,
         base branch, and "commit changes; report branch + worktree path + files + evidence on completion">
})
```

`worktree: false` is intentional: the supervisor-created Git worktree already provides isolation, and runtime-managed worktrees are automatically removed. Each node still has one isolated writer.

Run one wave through `workflowScript`. Fill slots from the current wave → wait for completions → repeat until every node in that wave is terminal. Then apply the merge policy. Do not start the next wave first.

### Merge policy

When every node in the wave is terminal:

**`--merge auto`**

Merge passed nodes sequentially into the base branch (git merge; resolve trivially or mark `integration-failed`). After each successful merge, remove that node's worktree with `git worktree remove <path>` and delete its temporary branch. Retain failed, blocked, or integration-failed worktrees for diagnosis. Then open the next ready wave and dispatch it. You may loop auto waves in one turn.

**`--merge hitl`**

Do not merge or remove any wave worktree. Present a review table (id, status, branch, **worktree path**, diffstat, evidence). Stop the turn. Do not keep a workflowScript blocked waiting for the human. Every worktree remains browsable under `<meta.repo>/tmp/` until the human explicitly requests cleanup.

On explicit user approval of this waiting wave:

- Default approval merges every **passed** node in the wave, sequentially.
- The user may name a subset. Unapproved passed nodes stay unmerged; their worktrees remain present and their dependents stay closed.
- Do not remove worktrees or delete temporary branches after merge approval. In HITL merge mode, every node worktree and branch remains until the user separately and explicitly authorizes cleanup.
- Rejected, failed, blocked, unapproved, integration-failed, and merged worktrees all follow that same explicit-cleanup rule.
- Then open the new ready set and dispatch that wave.

Failed/blocked nodes still freeze all transitive dependents in both modes. Never dispatch frozen nodes.

### On node result

- **passed** → eligible to merge under the merge policy above. Not merged until the wave gate says so.
- **integration-failed** (merge conflict) → re-dispatch that node once against the new head (`attempt 2` in the key); a second failure freezes it and reports.
- **blocked/failed** → freeze transitive dependents immediately; do not wait for the wave gate.
- No automatic retry beyond the single re-derivation above. Failures surface to the user.

## Hard constraints

1. **One writer per worktree.** Every node-conductor gets a distinct supervisor-created Git worktree under `<meta.repo>/tmp/` and launches with that path as `cwd`. Never share a tree between nodes or ask the runtime to wrap it in another worktree.
2. **Depth 2, no deeper.** node-conductor is the only child you launch with the subagent tool. Conductors may spawn only protocol-directed phase agents (`craft-planner`, counsel, `craft-builder`, `craft-code-simplifier`, `craft-evaluator`, `craft-security-review`, `craft-sharpener`). `craft-lite` must not spawn `craft-security-review`. Anything else fails the node.
3. **Dependencies are merged code, not context.** A node's payload contains its own spec and the run protocol only — never the DAG, sibling payloads, or other nodes' transcripts.
4. **No model fallback logic.** Provider-level availability is handled by the environment. A failed model is a failed node: report and freeze.
5. **Merge-back is yours.** Conductors commit in their worktree; only the supervisor merges into the base branch.
6. **Do not put `--merge` or `--protocol` on dag.json nodes.** Those are run policy.

## Result reporting (final)

| node | status | wave | attempts | worktree path | changed files | evidence |
plus: retained worktree list, frozen subtree list with blocking cause, merge order, merge mode, protocol, total tokens/cost if available, and recommended next actions (fix, re-decompose, manual intervention). Discovered work reported by conductors is summarized for the user — never silently implemented.
