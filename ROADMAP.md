# Roadmap

Explored but not built. Each entry records the reasoning and the open questions so the
decision can be resumed without re-deriving it.

---

## Tier by task value

**Status:** explored, not started · **Size:** comparable to the counsel collapse

Run the full `C → counsel → R → A → F → T → S` path on a two-file change and you pay
enterprise process for a typo fix. Scale the workflow to what the task is worth.

### What the numbers say

Per-invocation cost and wall time, from `craft-metrics` (sample: runs with usage recorded,
Aug 2026):

| phase | n | $/invoke | min/invoke | total $ |
| --- | --- | --- | --- | --- |
| A | 30 | $0.136 | 7.3 | $4.08 |
| counsel | 21 | $0.102 | 12.0 | $2.13 |
| C | 39 | $0.086 | 7.3 | $3.35 |
| R | 32 | $0.075 | 11.8 | $2.39 |
| T | 11 | $0.029 | 2.3 | $0.32 |
| S | 29 | $0.010 | 2.1 | $0.29 |
| F | 16 | $0.001 | 5.0 | $0.02 |

`A + counsel + C + R` is **95% of spend and ~38 of ~40 minutes**. `T`, `S`, and `F`
together are 5%. Tiering the cheap phases saves nothing — the lever is C, counsel, and A.
Counsel is also the single slowest phase: twelve minutes to review a plan.

### The design problem

`mode` currently conflates two orthogonal axes:

- **protocol shape** — `hitl` (human seam), `dag` (supervisor session)
- **task value** — `lite` (cheap work)

`lite` is a tier wearing a mode costume. The conflation is why the workflow cannot be
evaluated against itself: you cannot ask "was counsel worth its twelve minutes?" while
"this run was HITL" and "this run was cheap" live in the same field.

Splitting the axes is the actual proposal. Tiering is the mechanism; the measurable
comparison is the point.

```
mode:  full | hitl | dag   ← shape
tier:  small | standard    ← value
```

`/craft-lite` becomes `--tier small`, and that skill file goes away.

### Levers a tier could control

| Lever | small | standard |
| --- | --- | --- |
| 1. phases | C→R→A | + counsel, T, S |
| 2. models | cheap except A | current pins |
| 3. verification | local | + clean-room at node exit |

Lever 1 is the large saver — skipping counsel alone is $0.10 and twelve minutes. Lever 2
is real but smaller. Lever 3 partly exists already.

Security-critical work is **not** a third tier. Its only distinct behavior was "run T even
when untriggered", which a `--force-tighten` flag gives without the extra schema, and the
trigger guard below already forces such work up to `standard`. Two tiers discriminate as
well as three and cost less to carry.

**Floor:** `small` is `C→R→A`. Below that it is ordinary coding; do not invoke craft.

### Who selects the tier

An agent that picks its own thoroughness drifts cheap. Selection must be asymmetric:
**escalation automatic, de-escalation explicit.**

- Non-empty `security_triggers` forbids `small` — enforced in the store, same class as the
  `mode=lite` counsel/T guard.
- `kind` seeds a default: `docs`/`chore` → small, `feature`/`bugfix` → standard.
- C proposes a tier from planned files, criterion count, and triggers; the user overrides.

### Open questions

1. **Migrate `lite` now or later?** `tier` can land alongside `mode` with `lite` kept as an
   alias, migrating when convenient — slower, but nothing breaks mid-flight.

Resolved: two tiers, not three (see above).

### Blast radius

`mode` appears in the metrics schema, the CLI, three skill files, and the `mode=lite`
counsel/T guard. Record `tier` on the run so `totals` can group by tier × kind — without
that, the change buys flexibility but not the evaluation it is meant to enable.

---

## Validate attribution on a real run

**Status:** blocking · **Size:** one run plus a reading

Attribution was reworked so usage is stamped with the phase open when the work started.
Post-fix days read 100% placed — on $0.17 across 23 runs, nearly all CLI smoke tests. The
mechanism looks right and has never seen real traffic.

Until a genuine `/craft` or `/execute-dag` run lands and holds near 100%, every per-phase
figure in this file is provisional, including the table above. This gates the honest
version of every other item here.

Check after the next real run:

```bash
craft-metrics show --last 1
craft-metrics doctor
```

Watch for cost landing in `unattributed`, `ungated` complaints on CRAFTS runs, and
`costless-model` entries — a model that burns tokens and reports $0 makes cross-run cost
incomparable and would quietly invalidate tier comparisons.

---

## Clarify gate

**Status:** explored, not started

A human-approved criteria checkpoint before implementation, following GitHub Spec Kit's
Clarify phase (Constitution → Specify → **Clarify** → Plan → Analyze → Tasks → Implement).

C already emits `blocking_questions`, but AFK mode charges past them. The cheapest approval
to obtain is the one before code exists: approving criteria costs a sentence, approving an
implementation costs a review. This is the most direct lever on first-pass acceptance of
both the criteria and the resulting code.

Open: how it interacts with `afk_hitl_status`, and whether the gate is a distinct phase or
a stop condition inside C. A distinct phase is measurable; a stop condition is cheaper.

---

## Single-threaded for small work

**Status:** blocked on data

The DAG layer earns its overhead on genuinely parallel graphs. A three-node DAG likely pays
supervisor cost — worktree setup, dispatch, waiting, sequential merges — for coordination
it does not need.

Now measurable: `dag` runs bucket orchestration into the `supervisor` phase, so the ratio
of supervisor cost to summed node cost answers this directly. Needs several real DAG runs
first. Decide the node-count threshold from that ratio, not from taste.

---

## Mode re-fold

**Status:** known bug · **Size:** small

`fold` resolves each usage event against `run.mode` as it stands at that moment in the log.
A `mode` event appended later therefore relabels the run without moving any cost that was
already folded. `craft-metrics mode` does not do what it appears to do.

Fix: pre-scan each run for its final mode before resolving usage. Two payoffs beyond
correctness — mid-run mode corrections start working, and the historical `/execute-dag`
supervisor session currently sitting in `unattributed` (~$36, the single largest orphaned
bucket) reclassifies to `supervisor` retroactively.

---

## Blinding leak rate

**Status:** built, unexercised

The pi `tool_call` hook scrubs authorship from A and T payloads and records
`blinding_scrubs` on the open phase. No real reviewer spawn has exercised it.

The count is the interesting signal, not the scrub itself. Zero means conductors compose
clean payloads and the net is redundant insurance. Consistently non-zero means the payload
instructions are not landing and the net is doing the actual work — worth knowing which,
since only one of those justifies keeping the prose rules.

---

## Counsel's twelve minutes

**Status:** open question

Counsel is the slowest phase in the workflow at ~12 min/invoke, and second priciest at
$0.102. It was collapsed from three parallel reviewers to one for cost, not latency — so
the twelve minutes is one reviewer's time, not a panel's.

Unknown which of three causes dominates: prompt length, model tier, or the volume of plan
it must read. Worth isolating before either accepting the cost or cutting the phase, since
the tier work above treats "skip counsel" as its single largest saver.

---

## Objective test-weakening detection

**Status:** idea

A now judges whether tests were weakened to pass — deleted assertions, loosened matchers,
skipped cases, fixtures rewritten to match wrong output. That judgment is currently a
reading, and it is the one A duty with a mechanical alternative: coverage delta against the
base, or mutation testing on changed lines.

Heavier than it sounds, and mutation testing is slow enough to matter at these phase costs.
Worth it only if A's readings prove unreliable in practice — check before building.
