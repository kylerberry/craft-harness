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

## Metrics

Open a supervisor run before dispatching:

```bash
RUN=$(craft-metrics start --kind scaffold --mode dag --host pi|claude-code --cwd "<meta.repo>")
```

`--mode dag` is not a CRAFTS protocol — it marks this session as the supervisor. You never enter a CRAFTS phase; each node-conductor opens its own run in its own worktree. Your orchestration cost (dispatch, waiting, merges, verification) is bucketed as `supervisor`, which is what makes DAG overhead comparable against the node work it coordinates. Record post-merge verification against this run, and `craft-metrics end --run "$RUN"` when the DAG is terminal.

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
  model: "inherit",
  cwd: <meta.repo>/tmp/worktree-<id>,
  worktree: false,
  skill: <protocol>,
  task: <node payload: protocol, id, intent, change_spec, acceptance_criteria verbatim,
         base branch, and "commit changes; report branch + worktree path + files + evidence on completion">
})
```

`model: "inherit"` pins the conductor to the current parent session model, even when cached agent overrides differ. `worktree: false` is intentional: the supervisor-created Git worktree already provides isolation, and runtime-managed worktrees are automatically removed. Each node still has one isolated writer.

Run one wave through `workflowScript`. Fill slots from the current wave → wait for completions → repeat until every node in that wave is terminal. Then apply the merge policy. Do not start the next wave first.

### Merge policy

When every node in the wave is terminal:

**`--merge auto`**

Merge passed nodes sequentially into the base branch (git merge; resolve trivially or mark `integration-failed`). **After each merge, run the repository's verification command on the base branch** and record the result:

```bash
craft-metrics verify --run "$RUN" --command "<cmd>" --exit-code $?
```

A red base is an integration failure, not a node failure — each node passed alone; together they do not. Handle it exactly like a merge conflict: undo the merge, mark the node `integration-failed`, and re-dispatch once against the clean head.

> **Undo before continuing.** A broken base poisons every later wave, and each subsequent merge makes the bisect harder. If the merge is still the branch tip, `git reset --hard HEAD~1`; otherwise `git revert -m 1 <merge-sha>`. Check `git status` first and never discard a dirty tree you did not create. Do not proceed to the next merge with the base red.

After each successful, verified merge, remove that node's worktree with `git worktree remove <path>` and delete its temporary branch. Retain failed, blocked, or integration-failed worktrees for diagnosis. Then open the next ready wave and dispatch it. You may loop auto waves in one turn.

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
- **integration-failed** (merge conflict, or base verification red after the merge) → undo the merge, then re-dispatch that node once against the new head (`attempt 2` in the key); a second failure freezes it and reports.
- **blocked/failed** → freeze transitive dependents immediately; do not wait for the wave gate.
- No automatic retry beyond the single re-derivation above. Failures surface to the user.

## Hard constraints

1. **One writer per worktree.** Every node-conductor gets a distinct supervisor-created Git worktree under `<meta.repo>/tmp/` and launches with that path as `cwd`. Never share a tree between nodes or ask the runtime to wrap it in another worktree.
2. **Depth 2, no deeper.** node-conductor is the only child you launch with the subagent tool. Conductors may spawn only protocol-directed phase agents (`craft-planner`, `craft-counsel`, `craft-builder`, `craft-evaluator`, `craft-security-review`). `craft-lite` must not spawn `craft-counsel` or `craft-security-review`. Render-exit simplify and Sharpen are performed by the conductor directly — never spawned. Anything else fails the node.
3. **Dependencies are merged code, not context.** A node's payload contains its own spec and the run protocol only — never the DAG, sibling payloads, or other nodes' transcripts.
4. **Do not override phase model routing.** The conductor inherits the parent model. Protocol-directed CRAFTS children use each phase agent's configured primary model and ordered fallbacks. The supervisor and conductor never invent, reorder, or manually switch those models. An exhausted configured fallback chain is a failed model result: report and freeze.
5. **Merge-back is yours.** Conductors commit in their worktree; only the supervisor merges into the base branch.
6. **Do not put `--merge` or `--protocol` on dag.json nodes.** Those are run policy.

## Result reporting (final)

| node | status | wave | attempts | worktree path | changed files | evidence |
plus: retained worktree list, frozen subtree list with blocking cause, merge order, merge mode, protocol, total tokens/cost if available, and recommended next actions (fix, re-decompose, manual intervention). Discovered work reported by conductors is summarized for the user — never silently implemented.
