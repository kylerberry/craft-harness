---
name: craft
command: craft
argument-hint: "Optional: hitl"
icon: Hammer
description: >-
  Phase-gate execution workflow. Always C→R→A→F→T→S. Use /craft-hitl when
  Render contains a human-owned decision seam. Use /craft-lite to skip T.
---

# CRAFTS Workflow

Every run is `C → counsel → R → A → F → T → S`. There is no short path. Use `/craft-hitl` when Render must pause at a `TODO(human)` seam. Use `/craft-lite` when Tighten is out of scope.

## Core contract

CRAFTS is sequential: finish each gate before starting the next. Named role agents advise each phase; the conductor owns sequencing, edits, verification, and gate decisions. Counsel reviewers are the only agents that may run in parallel because they independently read the same C report.

The canonical acceptance criteria are the provided criteria verbatim, or C-authored criteria when none were provided. C records that provenance; counsel and A receive the canonical set unchanged, and A reviews both tests and implementation against it.

Host routing must preserve model-family diversity at the C→general-counsel, C→plan-security, R→A, and R→T seams. Exact models and fallback chains belong in host settings, not role prompts.

Reports must be concise and structured with the named fields below. JSON is optional unless the host enforces a schema.

## Metrics (required)

Every CRAFT run is recorded by `craft-metrics`. The conductor emits **semantics only** — never invent tokens or cost. The host adapter (Pi extension / Claude Code hooks) stamps usage onto the open phase.

At the start of the run, once. Infer `--kind` from the **user request**, not from files you expect to touch. One value: the primary intent. If two apply, pick the one that would change how you'd read the phase costs.

| `--kind` | Use when |
| --- | --- |
| `feature` | new behavior or API |
| `bugfix` | restore intended behavior |
| `refactor` | same behavior, different shape |
| `scaffold` | empty structure / wiring, little behavior |
| `docs` | skills, ADRs, README, comments-as-docs |
| `chore` | deps, config, CI, version, metrics plumbing |

Do not invent extra kinds. Security is `security_triggers` on C, not a kind. HITL is `--mode hitl`, not a kind. Lite is `--mode lite`, not a kind.

```bash
RUN=$(craft-metrics start --kind feature|bugfix|refactor|scaffold|docs|chore --mode full|hitl|lite --host pi|claude-code --cwd "$PWD")
```

Keep `$RUN` for the rest of the session. If `start` is missed, `craft-metrics current --cwd "$PWD"` may recover an id the host already opened. Wrong guess: `craft-metrics kind --run "$RUN" --kind feature` once, after C, not later.

At every gate:

```bash
craft-metrics enter --run "$RUN" --phase C|counsel|R|A|F|T|S --agent <role-agent>
```

Immediately after the phase report is in hand, before starting the next gate:

```bash
craft-metrics exit --run "$RUN" --phase C --security-triggers a,b --blocking-questions N --afk-hitl-status afk --criteria-provenance provided|authored
craft-metrics exit --run "$RUN" --phase counsel --counsel-status pass|blocked|needs-replan [--blocking-findings N] [--probe-required]
craft-metrics exit --run "$RUN" --phase A --verdict pass|fail --blocking-findings N
craft-metrics exit --run "$RUN" --phase T --t-status pass|fail --p0 N --non-p0 N
craft-metrics exit --run "$RUN" --phase S --docs-touched N
# R and F: exit with no extra fields
```

HITL pause/resume: `craft-metrics pause|resume --run "$RUN"`. Switch to HITL mid-run with `craft-metrics mode --run "$RUN" --mode hitl`.

When the run finishes or aborts:

```bash
craft-metrics end --run "$RUN" --outcome completed|aborted|blocked|hitl-paused
```

A missed emit is recoverable (host still records usage as `unattributed` or via named `craft-*` agents). A fabricated cost figure is not. Skip metrics only if the `craft-metrics` binary is missing.

## Flow

### C — Conceptualize

Use `craft-planner`. Pass the request, repository constraints, any provided acceptance criteria, and known HITL seams.

C returns: `status`, `scope`, `acceptance_criteria`, `criteria_provenance`, `afk_hitl_status`, `files`, `test_strategy`, `risks`, `render_plan`, `blocking_questions`, `security_triggers`, and `trust_boundaries`.

`security_triggers` is a unique subset of:

`trust-boundary-change`, `untrusted-input`, `authentication-authorization`, `secrets-sensitive-data`, `external-integration`, `file-command-execution`, `ci-deploy-permissions`, `tenant-isolation`.

Stop for unresolved requirements.

### Plan counsel

Send the completed C report and canonical criteria unchanged to independent reviewers:

| Agent | When |
| --- | --- |
| `craft-plan-feasibility` | Always |
| `craft-plan-scope` | Always |
| `craft-plan-security` | When `security_triggers` is non-empty |

Counsel is one pass: `C → counsel → C? → R`. Reviewers may run in parallel and must not see one another's findings before reporting.

General counsel returns `lens`, `status`, `findings`, and `residual_risks`; plan security returns `mode`, `status`, `findings`, `required_changes`, `planned_security_tests`, and `residual_risk`. Each finding identifies severity, whether it blocks, consequence, and required change. Feasibility may return `probe_required` with a hypothesis and required evidence rather than guessing.

If any report is `blocked` or `needs-replan`, or has blocking findings, C revises once and dispositions every blocker as `adopted` with the plan change or `rejected` with rationale. Pause for required evidence, clarification, or descoping before dispositioning a blocked or `probe_required` finding. There is no counsel re-review. R starts only after every blocker has a disposition; A later audits those dispositions.

### R — Render

Use `craft-builder` for test-first implementation guidance. Pass only the final C plan, adopted plan changes, rejected blockers whose rationale constrains implementation, and relevant plan-security findings, dispositions, and residual risks for triggered work. The conductor applies the changes.

1. **Red:** write the planned failing test. Return to C if it cannot be expressed.
2. **Green:** implement the minimum passing change.
3. **Refactor:** local cleanup while tests remain green. This is not the simplify gate.
4. Run proportionate tests, type checks, lint, and formatting.
5. **Simplify (R-exit, required):** after tests are green, spawn `craft-code-simplifier` on the Render diff only (changed lines; new files in full). If that agent is unavailable, apply the same pass yourself: preserve behavior, stay inside the diff, match repo conventions. Do not treat `/simplify` as available inside a subagent. Re-run focused tests. Stay in R until green. If simplify breaks tests, revert or fix those edits until green. If unrecoverable, revert simplify entirely, keep the last green Render, and enter A with that noted. Do not enter A red. Simplify is part of R; do not invent a metrics phase for it.

#### HITL Render override

When mode is HITL, Render stops at each approved human-owned seam:

1. Scaffold the surrounding types, tests, structure, and wiring.
2. Leave one specific `TODO(human)` describing the required decision or implementation.
3. Summarize what is ready, what the human must decide, and the relevant criteria; then stop.
4. After the human responds, read their implementation, run focused tests, integrate the remaining work, and remove the marker once verified.

The conductor must not implement past, stub, or work around an unresolved human seam. If the human delegates the decision back, continue in autonomous mode.

### A — Assess

Use `craft-evaluator` on a different model family from R. Pass the canonical criteria, final C plan, counsel findings and dispositions, changed files, and verification evidence.

A reviews the post-simplify tree. It checks the tests against the criteria, the implementation against both, and whether rejected or adopted counsel blockers were handled substantively. It returns `verdict`, `blocking_findings`, `verification_gaps`, and concise rationale. Residual style notes are optional and non-blocking; F does not apply them.

### F — Fix

Use `craft-builder`. Pass only blocking findings and the context required to change them safely.

Fix only blockers, apply the smallest safe change, rerun affected verification, and document justified disagreements. Repeat A only when the fix materially changes the assessed behavior.

### T — Tighten

Use `craft-security-review` on the final diff. Pass the task goal, changed files, verification evidence, C trust boundaries and triggers, and relevant plan-security findings, dispositions, and residual risks for triggered work.

T maps each declared C trust boundary to evidence, a P0 finding, or explicit non-applicability. Only P0 findings return to F and require T to repeat. P1/P2/P3 findings do not expand implementation scope; pass them to S.

T returns `mode`, `status`, `trust_boundaries_reviewed`, `blocking_findings`, `non_blocking_findings`, and `residual_risk`.

### S — Sharpen

Use `craft-sharpener`. Pass the final diff summary, verification results, issue status, durable discoveries, and T's non-P0 findings.

S identifies exact documentation updates and chooses the project's existing memory sink for non-P0 findings. In HITL mode, it captures the human-owned decision and rationale when durable. The conductor applies those updates, deduplicating existing entries and excluding transient noise.

Modify git state only when the user or repository workflow explicitly requires it.
