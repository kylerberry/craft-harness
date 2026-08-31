---
name: craft
command: craft
craft-version: "4"
argument-hint: "Optional: hitl"
icon: Hammer
description: >-
  Phase-gate execution workflow. Always C→counsel→R→A→[F]→T→S; F runs only on a
  blocking finding. Use /craft-hitl when Render contains a human-owned decision
  seam. Use /craft-lite to skip plan counsel and T.
---

# CRAFTS Workflow

Every run is `C → counsel → R → A → [F] → T → S`. There is no short path: no gate is skipped to save time, and none is reordered.

`F` is bracketed because it is the one phase that runs on condition rather than on schedule — it exists to resolve blocking findings, so with none to resolve there is nothing for it to do. Skipping it for that reason is the protocol working; skipping any other gate is not.

Use `/craft-hitl` when Render must pause at a `TODO(human)` seam. Use `/craft-lite` when Tighten is out of scope.

## Core contract

CRAFTS is sequential: finish each gate before starting the next. Named role agents advise each phase; the conductor owns sequencing, edits, verification, and gate decisions — including the Render-exit simplify pass and Sharpen, which the conductor performs directly rather than delegating.

The canonical acceptance criteria are the provided criteria verbatim, or C-authored criteria when none were provided. C records that provenance; counsel and A receive the canonical set unchanged, and A reviews both tests and implementation against it.

Host routing must preserve model-family diversity at the C→counsel, R→A, and R→T seams — these are the adversarial checks, where an independent model earns its cost. Render's simplify pass, Fix, and Sharpen inherit the default model; no forced diversity. Exact models and fallback chains belong in host settings, not role prompts.

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
RUN=$(craft-metrics start --kind feature|bugfix|refactor|scaffold|docs|chore --mode full|hitl|lite --host pi|claude-code --cwd "$PWD" --craft-version 4)
```

`--craft-version` is the `craft-version` field in this file's frontmatter — pass it verbatim, do not infer it. The workflow itself changes: phases merge, agents collapse, gates appear. Without the version, metrics from two different workflows average into a figure describing neither. This is not hypothetical — every `counsel` measurement on record came from the three-agent panel that v4 replaced with a single reviewer, and a blended average would have hidden that entirely.

Keep `$RUN` for the rest of the session. If `start` is missed, `craft-metrics current --cwd "$PWD"` may recover an id the host already opened. Wrong guess: `craft-metrics kind --run "$RUN" --kind feature` once, after C, not later.

At every gate:

```bash
craft-metrics enter --run "$RUN" --phase C|counsel|R|A|F|T|S --agent <role-agent>
```

Omit `--agent` for S — the conductor performs Sharpen directly; there is no role agent to name.

Immediately after the phase report is in hand, before starting the next gate:

```bash
craft-metrics exit --run "$RUN" --phase C --reason report --security-triggers a,b --blocking-questions N --afk-hitl-status afk --criteria-provenance provided|authored
craft-metrics exit --run "$RUN" --phase counsel --reason report --counsel-status pass|blocked|needs-replan [--blocking-findings N] [--probe-required]
craft-metrics exit --run "$RUN" --phase A --reason report --verdict pass|fail --blocking-findings N
craft-metrics exit --run "$RUN" --phase T --reason report --t-status pass|fail --p0 N --non-p0 N
craft-metrics exit --run "$RUN" --phase S --reason report --docs-touched N
# R and F: exit with --reason report and no phase-specific fields. F only appears when it ran — a clean A
# means no F gate at all, not an F gate with nothing recorded.
```

Every explicit exit requires `--reason report|blocked|timeout`. For `blocked` and `timeout`, also pass `--blocked-detail-ref REF`: a single-line, at-most-256-character pointer to the missing evidence or pending decision. A timeout closes the phase explicitly; do not leave the phase open and rely on absence to imply timeout.

Whenever the verification command runs — in R, after a fix in F, and after each DAG merge — record its real exit code:

```bash
craft-metrics verify --run "$RUN" --command "<cmd>" --exit-code $?
```

The store refuses `exit --phase A --verdict pass` while the last recorded verify is red. Recording an honest red result is how the gate works; omitting the call to keep the gate quiet defeats the only ground truth in the run.

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

Use `craft-counsel` on a different model family from C. Send the completed C report and canonical criteria unchanged.

Counsel is one pass: `C → counsel → C? → R`. One reviewer, one report, three lenses — feasibility and scope always; security only when `security_triggers` is non-empty.

Counsel returns `status`, `findings`, and `residual_risks`. Each finding carries `lens` (`feasibility` | `coherence` | `scope` | `security`), `severity`, `blocking`, `consequence`, and `required_change`. A feasibility finding may return `probe_required` with a hypothesis and required evidence rather than guessing; a security finding also carries `planned_security_tests` when relevant.

If the report is `blocked` or `needs-replan`, or has blocking findings, C revises once and dispositions every blocker as `adopted` with the plan change or `rejected` with rationale. Pause for required evidence, clarification, or descoping before dispositioning a blocked or `probe_required` finding. There is no counsel re-review. R starts only after every blocker has a disposition; A later audits those dispositions.

### R — Render

Use `craft-builder` for test-first implementation guidance. Pass only the final C plan, adopted plan changes, rejected blockers whose rationale constrains implementation, and relevant plan-security findings, dispositions, and residual risks for triggered work. The conductor applies the changes.

Before touching anything, record the ref Render starts from:

```bash
R_BASE=$(git rev-parse HEAD)
```

Step 6 diffs against it. Capture it first — a DAG conductor commits as it goes, so reading `HEAD` at the end of Render diffs its own work against itself and finds nothing changed.

1. **Red:** write the planned failing test. Return to C if it cannot be expressed.
2. **Green:** implement the minimum passing change.
3. **Refactor:** local cleanup while tests remain green. This is not the simplify gate.
4. **Verify.** Run the repository's declared verification command — the one a human PR must pass (test script, type check, lint, format). Record the real exit code:

   ```bash
   craft-metrics verify --run "$RUN" --command "<cmd>" --exit-code $?
   ```

   Record what actually ran, not what should have. A red result recorded honestly is a working gate; a green result asserted in prose is not evidence. If the repository declares no verification command, C must name one in the plan; a task with no way to be verified returns to C.
5. **Simplify (R-exit, required):** after tests are green, review the Render diff yourself — changed lines; new files in full — for reuse, dead code, naming, and unnecessary nesting or abstraction. No separate agent spawn: this is the conductor's own pass over its own diff, behavior-preserving only (same invariants as `craft-code-simplifier`, which exists as a standalone tool but is not part of this flow). Re-run focused tests. Stay in R until green. If a simplify edit breaks tests, revert or fix it until green. If unrecoverable, revert simplify entirely, keep the last green Render, and enter A with that noted. Do not enter A red. Simplify is part of R; do not invent a metrics phase for it.
6. **Mutation-test the diff.** Verification proves the suite passes. It cannot prove the suite would *notice* if the code were wrong — a loosened matcher or a fixture edited to match wrong output keeps every test green. Run it after simplify, since simplify edits the code:

   ```bash
   craft-mutate --base "$R_BASE" --timeout 60
   ```

   One JSON object comes back. `status: "ran"` carries `tested`, `killed`, `survived`, `no_coverage`, and up to twenty `survivors` — lines a test executed and did not object to — plus `survivors_omitted` when there were more.

   **This does not gate.** A survivor is sometimes an equivalent mutant: semantically identical, unkillable, correctly ignored. Deciding which is a judgment, so survivors go to A as findings to adjudicate rather than blocking Render.

   `status: "skipped"` is normal and not a failure. Most repositories have no `stryker.config.json`, and TypeScript/JavaScript is the only stack supported. `no-backend`, `oversize`, `timeout`, and an outright error all mean the same thing here: carry on, and tell A which it was so it knows to read for weakened tests itself.

   Pass the survivor block to A wrapped in verbatim markers:

   ```
   <!--craft:verbatim-->
   src/parser.ts:59  StringLiteral  → ""   covered_by: test/parser.test.ts
   <!--/craft:verbatim-->
   ```

   Mutant replacements are quoted source, not prose. Without the markers the blinding scrubber rewrites any agent name appearing inside a mutated string literal and the finding stops making sense.

7. **Record the decisions.** A reads a diff, which shows *what* changed and never *why*. An edge case left alone because the plan scoped it out and one left alone because it was awkward look identical. Before exiting R, write the implementation choices the plan did not dictate:

   ```
   decision:      what was chosen
   alternatives:  what else was considered, if anything
   rationale:     why, in one line
   criterion:     which acceptance criterion it serves, or "incidental"
   deviation:     yes | no — did this depart from the approved plan
   ```

   Include choices the plan left open, approaches tried and abandoned (so A does not propose them again), and any assumption you made that the plan did not state — those unstated assumptions are the ones that cause trouble later. Omit anything the plan already dictated; restating the plan is noise.

   Write these in neutral voice — "chose X over Y because Z", never "I decided". They go to a blinded reviewer, and first-person phrasing is an authorship signal the scrubber cannot remove.

   ```bash
   craft-metrics exit --run "$RUN" --phase R --reason report --decisions N --plan-deviations N \
     --mutants-tested N --mutants-survived N
   ```

#### HITL Render override

When mode is HITL, Render stops at each approved human-owned seam:

1. Scaffold the surrounding types, tests, structure, and wiring.
2. Leave one specific `TODO(human)` describing the required decision or implementation.
3. Summarize what is ready, what the human must decide, and the relevant criteria; then stop.
4. After the human responds, read their implementation, run focused tests, integrate the remaining work, and remove the marker once verified.

The conductor must not implement past, stub, or work around an unresolved human seam. If the human delegates the decision back, continue in autonomous mode.

### A — Assess

Use `craft-evaluator` on a different model family from R. Pass the canonical criteria, the approved plan, prior plan-review findings and their dispositions, the implementation decision record from R, changed files, and verification evidence.

Pass the decision record, not the Render transcript. A transcript is mostly authorship signal and re-derivable detail, and it is the single most expensive thing you could put in front of your priciest phase. The decision record carries the part a diff cannot: intent.

**Compose A's payload blind.** Different-family routing removes same-model self-preference; it does not remove the larger effect, which is that naming an author shifts the verdict on identical code. Use role-neutral vocabulary — "the approved plan", "prior plan-review findings", "the change set" — and keep these out of the payload entirely:

- `craft-*` agent names other than the reviewer's own, and `node-conductor`
- model or provider ids (`zai/glm-5.2`, `grok-4.6`)
- DAG identity: `[nN]` commit prefixes, `dag/nN` branches, `worktree-nN` paths
- first-person attribution ("I chose", "the builder decided")

Keep findings and dispositions in full — A must still judge whether a rejected blocker was rejected substantively. Strip *who produced them*, not what they said.

A reviews the post-simplify tree. **The verify command already settled whether the tree is green — A does not re-adjudicate that.** A judges only what an exit code cannot:

- do the tests actually encode every canonical criterion;
- were tests weakened to pass. When Render supplied mutation survivors, adjudicate that list instead of searching: each entry is a line a test ran and did not object to. When mutation was skipped — no backend, oversize, timeout — read for it as before: assertions deleted or loosened, cases skipped, fixtures rewritten to match wrong output. Do both and the phase costs more than it saves;
- is the implementation sound at behavior, edge cases, boundary error handling, and type safety;
- were rejected or adopted counsel blockers handled substantively;
- **is each plan deviation justified.** Judge the stated rationale, not the fact of deviating — plans are wrong sometimes and a good reason to depart is not a defect. A deviation with a thin, absent, or post-hoc rationale is a blocking finding; so is a change visible in the diff that departs from the plan and appears in no decision record at all.

It returns `verdict`, `blocking_findings`, `verification_gaps`, and concise rationale. Residual style notes are optional and non-blocking; F does not apply them.

A cannot report `verdict: pass` while the recorded verify is red — `craft-metrics exit` rejects it. A red tree is R's problem, not A's judgment call.

### F — Fix

**Conditional.** Enter F only when A returned `verdict: fail`, or T returned a P0 finding. A passing A with no blocking findings means there is nothing to fix: skip to the next phase and do not emit an F gate at all.

This is not a formality. Every F phase on record — sixteen of sixteen — ran with no blocking finding from either reviewer, because the phase was entered as part of the sequence rather than in response to something. That is 5% of all spend performing work nobody asked for, and worse, it invites edits that no reviewer has seen. `craft-metrics doctor` reports this as `fix-without-findings`.

When it does run: use `craft-builder`, and pass only blocking findings and the context required to change them safely.

Fix only blockers, apply the smallest safe change, rerun affected verification, and document justified disagreements. Repeat A only when the fix materially changes the assessed behavior — and expect that repeat to show up as a second cycle on A, which is the intended record of an argument, not a defect.

### T — Tighten

Use `craft-security-review` on the final diff. Pass the task goal, changed files, verification evidence, declared trust boundaries and triggers, and relevant plan-security findings, dispositions, and residual risks for triggered work. Compose T's payload blind, under the same rules as A.

T maps each declared C trust boundary to evidence, a P0 finding, or explicit non-applicability. Only P0 findings return to F and require T to repeat. P1/P2/P3 findings do not expand implementation scope; pass them to S.

T returns `mode`, `status`, `trust_boundaries_reviewed`, `blocking_findings`, `non_blocking_findings`, and `residual_risk`.

### S — Sharpen

The conductor performs Sharpen directly — no separate agent spawn. Using the final diff summary, verification results, issue status, durable discoveries, and T's non-P0 findings, identify exact documentation updates and the project's existing memory sink for non-P0 findings, deduplicating existing entries and excluding transient noise. In HITL mode, capture the human-owned decision and rationale when durable.

Modify git state only when the user or repository workflow explicitly requires it.
