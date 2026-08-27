# Roadmap

Explored but not built. Each entry records the reasoning and the open questions so the
decision can be resumed without re-deriving it.

---

## Tier by task value

**Status:** explored, not started · **Size:** comparable to the counsel collapse

Run the full `C → counsel → R → A → F → T → S` path on a two-file change and you pay
enterprise process for a typo fix. Scale the workflow to what the task is worth.

### What the numbers say

**Correction, superseding an earlier version of this entry:** the first pass used
`cost_usd` — what was actually billed. That figure is honest for metered models and
silently ~$0 for subscription models (Codex on a ChatGPT plan burns real tokens at no
marginal cost), so any phase running mostly on a subscription model looked artificially
cheap. `craft-metrics` now also computes **notional cost** — tokens priced at list rate
regardless of billing — which is the only figure comparable across phases. Numbers below
are notional; see `ROADMAP` entries on pricing for how it's derived and its known caveats.

| phase | notional $ | share | min/invoke |
| --- | --- | --- | --- |
| A | $57.73 | 61% | 7.3 |
| R | $14.25 | 15% | 11.8 |
| C | $9.98 | 11% | 7.3 |
| counsel | $5.96 | 6% | 12.0 |
| F | $4.72 | 5% | 5.0 |
| T | $1.21 | 1% | 2.3 |
| S | $0.48 | 1% | 2.1 |

**A alone is 61% of everything spent, by a wide margin.** Under `cost_usd` alone F looked
almost free ($0.02) because it happens to run on a subscription model — by notional cost
it's $4.72, larger than T and S combined. Ranks changed: C dropped from #2 to #3, R rose
from #4 to #2, F went from invisible to material.

This changes what a phase-presence tier buys. The `small`/`standard` split below keeps A
in *both* tiers — dropping to `small` only removes counsel, T, and S, which together are
**8% of notional spend**. Tiering by phase is a latency lever (it removes counsel's twelve
minutes) far more than a cost lever. The actual cost lever is A itself: its size, its
model, and the volume of context it's handed — the decision-record work (see the craft
commit history) was aimed exactly at that last part, by replacing A's payload with a
structured summary instead of R's full transcript.

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

Lever 1 is a latency saver, not a cost one — see the corrected numbers above: counsel,
T, and S together are 8% of notional spend, and A (which stays in every tier) is 61%.
Skipping counsel still removes twelve minutes, which may be reason enough on its own.
Lever 2 is where real cost reduction has to happen, specifically on A. Lever 3 partly
exists already.

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

## Notional pricing

**Status:** built · pi only, by design

`cost_usd` is what was actually billed — $0 for any model on a subscription plan (Codex
on ChatGPT, observed as `gpt-5.6-terra`/`sol`/`luna`) even though it burns real tokens.
That made cross-phase cost comparison silently wrong: a phase that happened to run on a
subscription model looked free next to one that did less work on a metered model. It is
what surfaced the corrected numbers above.

`craft-metrics` now reads pi's own model price registry (`~/.pi/agent/models-store.json`,
override via `CRAFT_METRICS_PRICES`) and prices every phase's tokens at list rate,
regardless of how the model is actually billed. `notional_cost_usd` sits beside
`cost_usd` everywhere — never replaces it. `cost_usd` answers "what did I pay";
`notional_cost_usd` answers "which phase is expensive." `craft-metrics totals` and
`models` print both.

Derived at read time from the current price table, not stamped into the event log — a
price correction re-prices every historical run on the next read, no migration.

**Known caveats, not bugs:**
- Some Codex tiers (`sol`, `terra`) charge a higher rate above a context threshold
  (`tiers: [{ inputTokensAbove: 272000, ... }]`). Tokens are aggregated across requests in
  a phase, so which individual requests crossed that threshold isn't reconstructable.
  Notional always prices at the base tier — an under-count on long-context phases.
- Notional uses the price table *as of now*. If a provider's rate changed during the
  window a run's tokens were spent, notional and `cost_usd` diverge even for a fully
  metered model. Observed on `grok-4.6`: actual $86.49 vs notional $152.24 despite being
  metered the whole time — the rate moved, not a collection error.
- **pi only**, deliberately — the price table lives in pi's local model registry. A
  Claude Code equivalent would need its own price source; not built, not requested.

---

## A's cost concentration

**Status:** open, most consequential item on this page

A is 61% of all notional spend across every phase, every run — not close to the next
phase (R, at 15%). This is the number the tiering exploration surfaced by accident: no
phase-presence tier touches it, because A stays in every tier down to the floor.

Contributing factors, not yet isolated:
- A's model tier (`xai/grok-4.6`, the heaviest-weighted model in the whole system by
  notional cost)
- Payload size — the decision-record change (replacing R's transcript with a structured
  summary) was aimed here; whether it moved A's token volume is unmeasured
- A's own workflow: it re-reads criteria, the plan, counsel findings, and the diff on
  every invocation regardless of change size

Before spending more design effort on tiering or blinding refinements, this is the
number worth explaining. A 10% reduction in A's cost is worth more than eliminating
counsel, T, and S combined.

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

Counsel is the slowest phase in the workflow at ~12 min/invoke. It was collapsed from
three parallel reviewers to one for cost, not latency — so the twelve minutes is one
reviewer's time, not a panel's. By notional cost it is a modest 6% of total spend, so the
case for isolating this is now about latency, not the "biggest saver" framing an earlier
version of this file used.

Unknown which of three causes dominates: prompt length, model tier, or the volume of plan
it must read. Worth isolating before either accepting the cost or cutting the phase.

---

## Objective test-weakening detection

**Status:** idea

A now judges whether tests were weakened to pass — deleted assertions, loosened matchers,
skipped cases, fixtures rewritten to match wrong output. That judgment is currently a
reading, and it is the one A duty with a mechanical alternative: coverage delta against the
base, or mutation testing on changed lines.

Heavier than it sounds, and mutation testing is slow enough to matter at these phase costs.
Worth it only if A's readings prove unreliable in practice — check before building.
