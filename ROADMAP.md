# Roadmap

Explored but not built. Each entry records the reasoning and the open questions so the
decision can be resumed without re-deriving it.

> **Every measurement on this page is CRAFTS v3 data.** v4 — single merged counsel,
> inline simplify and Sharpen, blinded reviewers, the verify gate, the R decision
> record — has produced **zero** recorded runs. `craft-metrics totals` confirms: 26
> v3 runs carry all the cost, v4 none. Directions are probably robust (A's turn count
> dwarfs every other phase by a wide margin), magnitudes will move. Re-measure before
> acting on any specific figure here.

---

## Version bump discipline

**Status:** open risk, no enforcement possible

Run versioning is built (see `craft-tooling/README.md`). What is *not* solved: the bump
itself is a judgment call, and nothing can check it. The rule is "bump when a phase's
shape changes — agents added or removed, duties moved, gates introduced; not for
wording." Miss one and v4 quietly becomes two different workflows sharing a label, which
is the exact failure versioning was added to prevent, just harder to spot the second
time.

The retro-classifier cannot save this case: it infers from agent names and structural
markers, and a missed bump means those markers are identical. Only two partial mitigations
exist — treat any `craft/SKILL.md` phase-structure edit as requiring a bump decision in
the same commit, and watch for a version whose per-phase numbers shift discontinuously
mid-sequence.

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
are notional; see `craft-tooling/README.md` for how it's derived and its known caveats.

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

## Tier-aware notional pricing

**Status:** known limitation · low priority

Notional pricing is built (see `craft-tooling/README.md`). One gap remains: some Codex
models (`sol`, `terra`) charge a higher rate above a per-request context threshold
(`tiers: [{ inputTokensAbove: 272000, ... }]`). Tokens are summed across every request in
a phase, so which individual requests crossed the threshold is not reconstructable from
the aggregate — notional always prices at the base tier.

The result is a **systematic under-count on long-context phases**, which is precisely
where the interesting costs are. A is the worst affected: 3.39M cached tokens per
invocation is many requests deep into tiered territory.

Fixing it means recording per-request token counts rather than per-phase sums, which is a
real schema change for a correction of unknown size. Worth doing only if a phase
comparison ever turns on a margin narrow enough for the under-count to flip it.

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

### Addendum — cause isolated

Measured, not inferred. The obvious hypothesis was A→F round trips inflating A. **It is
not that.** Counting `phase_enter` events for A per run: 29 of 31 runs enter A exactly
once; only 2 re-enter. Round trips are rare and cannot explain the concentration.

The cause is **turn count**, and cache cost that scales with it:

| phase | avg turns | avg tools | avg cacheRead | cache ÷ fresh tokens |
| --- | --- | --- | --- | --- |
| C | 5.7 | 24.8 | 0.15M | 3.8 |
| counsel | 8.0 | 52.6 | 0.16M | 3.1 |
| R | 10.7 | 33.1 | 0.88M | 23.1 |
| **A** | **20.8** | **48.3** | **3.39M** | **47.3** |
| F | 10.2 | 21.8 | 0.65M | 12.8 |
| T | 4.0 | 21.6 | 0.09M | 2.9 |
| S | 1.7 | 13.6 | 0.06M | 4.7 |

A runs 20.8 turns — nearly double R, 3.6× C. Every turn resends the conversation so far
as cached input, so cache read compounds with turn count *and* with context growth per
turn. A reads 3.39M cached tokens per invocation against C's 0.15M — 22×, which tracks
the turn ratio multiplied by that compounding.

Cache alone accounts for essentially the whole cost: 3.39M × $0.50/M (grok-4.6 cacheRead)
≈ $1.70, against a measured average of $1.86 notional per A invocation. Fresh input is
65k and output only 7k — A barely *writes* anything. It is paying almost entirely to
re-read its own accumulated context.

Why A takes so many turns: its checklist is the widest in the workflow — criteria
coverage, weakened-test detection, plan-deviation judgment, maintainability, type safety,
edge cases — and every item is verified independently against the tree rather than
trusted from a report. Its 48.3 tool calls are second only to counsel's 52.6, but counsel
converges in 8 turns against A's 20.8: counsel answers a narrower question per lookup,
while A keeps digging.

This reframes the lever. A's cost is not the model tier and not the initial payload
size — those set the per-turn floor, and the floor is small. It is the **number of
turns**, so anything that reduces A's need to loop reduces cost roughly proportionally.
Two candidates, in order of expected leverage:

1. Make weakened-test detection mechanical rather than a manual grep hunt — a coverage
   delta or mutation-testing signal answers in one tool call what A currently explores
   across many. See the test-weakening entry below.
2. Narrow what A must independently re-derive, giving it pre-digested findings where the
   derivation is not itself the point. The decision record is the first instance; whether
   it moved the turn count is still unmeasured.

Both are turn-count interventions. Model-tier changes and payload trimming address the
smaller term.

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

## Does blinding need the safety net?

**Status:** open question, blocked on v4 runs

The scrubber is built and records `blinding_scrubs`. The open question is whether the
prose payload rules in `craft/SKILL.md` are doing any work, or whether the scrubber is
carrying them.

The count answers it. Consistently zero means conductors compose clean payloads unaided
and the scrubber is redundant insurance — keep it, but the prose is what works.
Consistently non-zero means the instructions are not landing and the mechanical net is
the only thing preventing leaks, which would make the same argument for mechanising other
"the conductor should…" rules rather than writing more of them.

No reviewer spawn has run under v4, so there is no data either way.

---

## Counsel's twelve minutes

**Status:** open question — but the measurement is stale, see below

**Correction.** An earlier version of this entry claimed the twelve minutes was "one
reviewer's time, not a panel's." That was wrong. Checking agent names on every recorded
`counsel` phase: all 23 used the three-agent `craft-plan-*` panel. Zero runs of the
single merged `craft-counsel` exist. The twelve minutes is a **panel's** wall time —
three reviewers in parallel, so roughly the slowest of three, not one reviewer's latency.

Single-reviewer counsel is entirely unmeasured. It may be faster (one agent, no
fan-out/fan-in), or slower (one agent doing three lenses' work serially instead of three
in parallel). Both are plausible and the data cannot distinguish them.

By notional cost counsel is a modest 6% of v3 spend, so the case for looking at this is
latency, not the "biggest saver" framing an even earlier version of this file used.

First step is no longer analysis — it is **collecting any v4 counsel data at all.**

---

## Did mutation testing replace A's hunting, or add to it?

**Status:** built, unmeasured · blocked on v4 runs

`craft-mutate` is wired into Render and A's weakened-test duty is now conditional:
adjudicate the survivor list when there is one, read for it when there is not. The design
is settled and the tool works — 6.6s for a 412-line diff, ~2s for a 20-line one, capped at
twenty survivors with the remainder counted.

What is not settled is whether it does its actual job. That job was never "find mutants";
it was "stop A from spending turns hunting". The verdict is **A's turn count**. If it still
runs ~20.8 turns with a survivor list in hand, the feature added a step instead of
replacing one, and the conditional in `craft-evaluator.md` is not landing.

Two reasons the answer will be slow to arrive:

- **Adoption is per-repo.** Mutation runs only where a `stryker.config.json` exists, which
  today is `craft-tooling` and nothing else. Everywhere else Render gains one skipped call
  and A takes the reading path. The skip branch is the norm, not the exception.
- **The comparison baseline is v3.** The 20.8-turn figure comes from runs that predate
  every change made since. A's duties narrowed at the same time mutation arrived, so a
  drop cannot be attributed to mutation alone without holding the rest still.

Known limitation, not worth fixing yet: mutation runs once, in R. If F adds a test in
response to a survivor, that fix is verified but not re-mutated.

---

## blind.ts coverage

**Status:** known gap · smallest of the remaining ones

54.4% mutation score, the lowest in `craft-tooling`, on the code that enforces reviewer
blinding. Everything around it was brought up during the coverage pass and this was left.

It matters more than the number suggests: the scrubber is the mechanical half of blinding,
and the prose half is an instruction that may or may not land. If the scrubber is quietly
wrong, nothing else reports it — the breach counter counts what the scrubber *caught*, not
what it missed.

---

## Claude Code host adapter

**Status:** not started · deliberately deferred

`craft-tooling` is host-agnostic except for `extensions/pi.ts` — 282 lines against ~1,900
of host-neutral code. Everything else (store, schema, pricing, versioning, blinding,
mutation) works anywhere.

A Claude Code adapter would need to supply the same three things pi's extension does:
per-turn usage with the phase open at the time, the `tool_call` interception that scrubs
authorship from reviewer payloads before spawn, and run open/close detection. Claude Code
has hooks in the same family, so the shape should carry over.

Also needed: a price source. Notional pricing reads pi's local model registry
(`~/.pi/agent/models-store.json`), which Claude Code has no equivalent of — that would
need a bundled table or another source.

Not worth doing on speculation. It becomes worth doing if CRAFTS ever needs to run on
Claude Code, or ship to someone who does.
