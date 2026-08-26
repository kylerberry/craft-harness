# Agent Utilities

A distributable CRAFTS toolkit for AI coding agents. It mirrors the current global `~/.agents` CRAFTS workflow and its role agents, including bundled security review guidance — plus a DAG layer (`/decompose-to-dag`, `/execute-dag`, and the `node-conductor` agent) that slices multi-node work into supervised CRAFTS runs.

```mermaid
flowchart LR
    C["C — Conceptualize"] --> FEAS["Feasibility counsel"]
    C --> SCOPE["Scope counsel"]
    C -. "security triggers" .-> PLANSEC["Plan-security counsel"]

    FEAS --> GATE{"Blocking findings?"}
    SCOPE --> GATE
    PLANSEC --> GATE
    GATE -- "yes" --> REVISE["C revises and dispositions"]
    REVISE -. "no re-review" .-> R["R — Render"]
    GATE -- "no" --> R

    R -. "HITL seam" .-> HUMAN["TODO(human) pause"]
    HUMAN --> R
    R --> SIM["craft-code-simplifier; tests stay green"]
    SIM --> A["A — Assess"]
    A -- "blockers" --> FA["F — Fix"]
    FA --> A
    A -- "/craft pass" --> T["T — Tighten"]
    T -- "P0" --> FT["F — Fix P0"]
    FT --> T
    T -- "pass; non-P0 forwarded" --> S["S — Sharpen"]
    A -- "/craft-lite pass" --> S
```

## Contents

```text
skills/
├── craft/                    # Autonomous CRAFTS workflow
├── craft-hitl/               # CRAFTS with a TODO(human) Render seam
├── craft-lite/               # CRAFTS without T
├── decompose-to-dag/         # Spec → validated dag.json artifact
├── execute-dag/              # Supervised DAG execution (wave barrier)
└── guided-tour/              # One-concept-at-a-time codebase teaching

agents/
├── craft-planner.md          # C — Conceptualize
├── craft-builder.md          # R/F — Render and Fix
├── craft-code-simplifier.md  # R-exit simplify gate
├── craft-evaluator.md        # A — Assess
├── craft-plan-security.md    # Pre-implementation security counsel lens
├── craft-security-review.md  # T — Tighten final-diff review (P0 gate)
├── craft-sharpener.md        # S — Sharpen
├── craft-plan-feasibility.md # Plan counsel: executable here & internally consistent
├── craft-plan-scope.md       # Plan counsel: exactly the criteria, no more
└── node-conductor.md         # Conducts one DAG node through a CRAFTS protocol
```

## CRAFTS at a glance

CRAFTS is a sequential delivery workflow:

`C → R → A → F → T → S`

| Phase | Role | Purpose |
| --- | --- | --- |
| **C**onceptualize | `craft-planner` | Scope, acceptance criteria, tests, plan, and security triggers |
| *Plan counsel* | `craft-plan-feasibility` · `craft-plan-scope` (+ `craft-plan-security` when triggered) | Independent one-pass review of the C plan before Render |
| **R**ender | `craft-builder` then `craft-code-simplifier` | Test-first implementation, then required simplify exit gate |
| **A**ssess | `craft-evaluator` | Independent review of implementation and tests |
| **F**ix | `craft-builder` | Minimal fixes for blocking findings |
| **T**ighten | `craft-security-review` | Bundled final-diff security review; only P0 findings block |
| **S**harpen | `craft-sharpener` | Durable documentation and process learning |

| Command | Path | When |
| --- | --- | --- |
| `/craft` | `C → counsel → R → A → F → T → S` | Default. No short path. |
| `/craft-hitl` | Same as `/craft`, HITL Render | A `TODO(human)` seam is reserved. |
| `/craft-lite` | `C → counsel → R → A → F → S` | Tighten is out of scope (prototype, spike). |

Every protocol runs the R-exit `craft-code-simplifier` gate after Render is green (tests must stay green; unrecoverable simplify is reverted). `/craft-lite` only skips Tighten and uses `--mode lite`.

### Plan counsel gate and security triggers

C emits `security_triggers` from a closed vocabulary (`trust-boundary-change`, `untrusted-input`, `authentication-authorization`, `secrets-sensitive-data`, `external-integration`, `file-command-execution`, `ci-deploy-permissions`, `tenant-isolation`) instead of a subjective risk score; an empty list means low-risk work.

Every task then runs the **plan counsel gate** between C and R:

1. The C report goes verbatim to independent read-only reviewers: feasibility-and-coherence and scope guardian always; security only when a trigger is declared. They may run in parallel; none sees another's findings first.
2. Any blocking finding returns all reports to C, which revises once and dispositions every blocking finding: `adopted` (with the plan change) or `rejected` (with rationale).
3. Render begins only when every blocking finding has a disposition — dispositions are the gate, not agreement. There is no counsel re-review round.
4. Feasibility reports `probe_required` instead of guessing when an assumption needs execution to settle; the user supplies evidence, descopes, or confirms.
5. Counsel reports and dispositions forward to Assess, which treats thin rejections or cosmetic adoptions as blocking findings.

Tighten maps every declared trust boundary to evidence, a P0 finding, or explicit non-applicability. It returns only P0 findings as blockers; Sharpen selects the project's existing memory sink for all non-P0 findings and the conductor records them. Security agents carry bundled review guidance with no external skill dependency. Role reports require named semantic fields; JSON is optional unless the host enforces a schema.

## DAG workflow

A single CRAFTS run stays in one session. When a spec slices into several independently verifiable outcomes, decompose first and execute as a supervised DAG:

```mermaid
flowchart LR
    SPEC["Spec / issue / request"] --> DEC["/decompose-to-dag"]
    DEC --> DAG["dag.json (five-field nodes)"]
    DAG --> APPROVE{"User approves"}
    APPROVE --> EXE["/execute-dag supervisor"]
    EXE --> WAVE["Wave barrier: max 3 node-conductors"]
    WAVE --> NC["node-conductor runs a CRAFTS protocol per node"]
    NC --> MERGE["Supervisor merges passed nodes"]
    MERGE --> WAVE
    MERGE --> REPORT["Final report"]
```

### `/decompose-to-dag`

Turns a spec, issue, or free-form request into a validated `dag.json` written next to the work. Each node has exactly five fields — `id`, `intent`, `change_spec`, `acceptance_criteria`, `depends_on` — and one independently verifiable outcome; `depends_on` exists only where a node literally cannot be built or verified without another's output. Material uncertainty becomes a probe node whose criteria demand a durable, mergeable artifact, never a report. The skill validates the graph (unique ids, acyclic, testable criteria, no bundled outcomes, no intent smells) and runs an adversarial review pass before presenting a summary table. It stops at the artifact — implementation belongs to `/execute-dag`, and only after the user approves the DAG.

### `/execute-dag`

Executes an approved `dag.json` as the supervisor: it owns dispatch, merging, and reporting, and never implements node work itself.

```text
/execute-dag [--merge auto|hitl] [--protocol craft|craft-hitl|craft-lite] [dag.json]
```

- `--merge auto` (default): after a wave is terminal, merge passed nodes sequentially into the base branch, clean up their worktrees, then open the next wave.
- `--merge hitl`: present a per-node review table (status, branch, worktree path, diffstat, evidence) and stop; nothing merges and no worktree is removed without explicit approval.
- `--protocol` passes through to every node-conductor. Default `craft`; use `craft-hitl` only when nodes actually have `TODO(human)` seams; `craft-lite` skips Tighten.

Dispatch is a **wave barrier**: a node is ready when every dependency is passed *and merged*; at most 3 node-conductors run per wave; the next wave opens only after the current one is terminal and its approved passed nodes are merged. Each node gets a supervisor-created Git worktree (`<repo>/tmp/worktree-<id>`, branch `dag/<id>`) — never a runtime-managed disposable worktree — so failed nodes stay browsable for diagnosis. An integration conflict gets exactly one re-derivation (`-attempt-2`); a failed or blocked node freezes its transitive dependents in both merge modes.

### `node-conductor`

The `node-conductor` agent conducts exactly one DAG node end-to-end. It loads the named protocol skill (`craft`, `craft-hitl`, or `craft-lite`), spawns each directed phase agent sequentially, executes the implementation itself in its worktree — including the required R-exit simplify gate — and commits with the node id prefix (`[n3] ...`). Fanout is depth 2: the supervisor launches only node-conductors, and a conductor launches only protocol phase agents. Dependencies arrive as already-merged code in the worktree, never as transcripts or sibling payloads. `craft-lite` nodes never spawn `craft-security-review`.

## Installation

Copy the directories into either a project's `.agents/` folder or your global `~/.agents/` folder:

```bash
# From this repository
cp -R skills/* /path/to/project/.agents/skills/
cp -R agents/* /path/to/project/.agents/agents/
```

Then invoke `/craft`, `/craft-hitl`, or `/craft-lite`. Ensure the host supports the agent frontmatter and bundled security-review guidance; `/execute-dag` additionally requires a subagent runtime with scripted orchestration (pi's `workflowScript`/`runs.run`).

### Author-machine live install (symlinks)

On the author's machine, the listed entries under `~/.agents` point at this repository so the global workflow always matches git — one copy, no sync step:

```bash
for f in craft-builder craft-code-simplifier craft-evaluator craft-planner craft-plan-security craft-security-review craft-sharpener craft-plan-feasibility craft-plan-scope node-conductor; do
  ln -sf ~/Projects/agent-utilities/agents/$f.md ~/.agents/agents/$f.md
done
for skill in craft craft-hitl craft-lite guided-tour decompose-to-dag execute-dag; do
  ln -sfn ~/Projects/agent-utilities/skills/$skill ~/.agents/skills/$skill
done
```

Edits through these links change the repository files; commit from this repository.

## Model routing

Agent frontmatter intentionally sets **no `model`** — with one deliberate exception, noted below — because in pi frontmatter outranks `agentOverrides`, so a baked-in value would shadow each host's routing. Route per host via `subagents.agentOverrides` (or your harness's equivalent). The intended tiering:

| Role | Tier | Author-machine pin |
| --- | --- | --- |
| C — planner | heavy | `openai-codex/gpt-5.6-sol` |
| Counsel: feasibility | medium | `zai/glm-5.2` |
| Counsel: scope | light | `xai/grok-4.3` |
| Counsel: security (plan mode) | medium, different family from planner | `zai/glm-5.3` |
| R/F — builder | medium, different family from evaluator | `zai/glm-5.2` |
| R-exit — `craft-code-simplifier` | medium, different family from builder | host default |
| A — evaluator | heavy, different family from builder | `xai/grok-4.6` |
| T — tighten | medium, different family from builder | `openai-codex/gpt-5.6-terra` |
| S — sharpener | light | `openai-codex/gpt-5.6-luna` |
| DAG — `node-conductor` | medium, pinned (see below) | `openai-codex/gpt-5.6-terra` |

`node-conductor` is the one deliberate exception to that rule: its frontmatter pins `openai-codex/gpt-5.6-terra` so every DAG node gets the same conductor regardless of host overrides — it is a node's sole orchestrator and sole writer, not an advisory lens a host should re-tier per phase.

Give every pin a `fallbackModels` chain (rate-limit and overload errors walk it automatically); keeping subscription-capped providers out of primary positions and fallback-only models in the chain degrades gracefully instead of failing the phase.

## Design principles

- **Acceptance criteria remain the reference.** Assess reviews the test suite against the canonical criteria—provided verbatim or C-authored when absent—not just passing tests.
- **Independent review reduces correlated blind spots.** Builders do not approve their own work; plan counsel challenges the plan before code exists, and elevated plan review is independent of planning and implementation.
- **Security starts in planning.** Threat boundaries and abuse cases are considered before code exists, then rechecked against the final diff.
- **Knowledge compounds.** Sharpen records durable lessons without turning ordinary fixes into documentation churn.
- **Humans own consequential judgment.** HITL reserves explicit seams for people while the agent handles surrounding implementation and verification.

## License

MIT
