# Roadmap

Explored but not built. Each entry records the reasoning and the open questions so the
decision can be resumed without re-deriving it.

> **Every measurement on this page is CRAFTS v3 data, and still is.** Two runs now
> carry a v4 label and neither is a clean baseline. `a5469442` opened under v3, ran a
> full `craft-plan-feasibility` counsel and a C→counsel→R→A prefix, then declared
> version 4 mid-run — a v3 workflow's cost sits inside the v4 totals, which is exactly
> the failure the version-bump entry below predicted. `edabc620` entered C twice,
> never exited, and recorded zero turns, zero tool calls, and zero tokens.
>
> So: v4 — single merged counsel, inline simplify and Sharpen, blinded reviewers, the
> verify gate, the R decision record — still has no uncontaminated measurement.
> Directions are probably robust (A's turn count dwarfs every other phase by a wide
> margin, and the hybrid run puts A at 77% rather than 61%), magnitudes will move.
> Re-measure before acting on any specific figure here.
>
> Where a v4 figure is cited below it comes from `a5469442` and is marked as such.
> Its wall-clock is unusable — every phase reads ~512,000s because HITL pauses count
> toward phase duration.

---

## Phases that never terminate

**Status:** open bug with a recorded instance · cheapest fix on this page

`edabc620` — v4, `full`, feature — recorded two `phase_enter C` events and no
`phase_exit`, ever. The run closed `blocked` after 193.4s having produced no plan. A
read-only planner holding `read`/`grep`/`find` kept crawling documentation and never
returned; two explicit finalization steers did not land, and the permitted retry failed
the same way under a narrower scope.

The protocol's guarantee held — the conductor stopped rather than starting R without a
plan — so this is a robustness failure, not a correctness one. That is the only reason
it is not the top item on this page.

`craft-planner.md:37` already says "Return the exact clarification required when
requirements remain ambiguous," and the Output section requires a `status` field, so a
blocked path exists. What is missing is that it is step 7 of 7 rather than a terminal
contract: nowhere does the prompt say *you end in exactly one of two shapes*. An agent
that has not decided it is finished has no instruction telling it that finishing is
mandatory.

Two mechanisms, in order of expected reliability:

1. **State the contract in every phase prompt.** A complete structured report, or a
   structured `blocked` naming the exact missing evidence. No third outcome.
2. **Enforce it at the store.** `craft-metrics` already refuses
   `exit --phase A --verdict pass` against a red verify — mechanical refusal at the
   boundary is the established pattern here, and it is the half that keeps working when
   prose does not. A `doctor` rule for *phase entered, never exited* costs almost
   nothing and would have surfaced `edabc620` without anyone reading a transcript. No
   rule catches it today: a phase was entered, so it is not `ungated`.

The same run exposes a second recording defect worth fixing alongside: C ran twice and
`edabc620` attributes **zero** usage to it. Whatever dropped that usage makes the run
invisible to every cost question on this page.

Check before designing anything larger: `agents/craft-planner.md:11` sets
`completionGuard: false`, as does `craft-builder.md:11`. No other craft agent sets it,
and it is documented nowhere in this repository. An option named "completion guard",
disabled on the one agent that failed to complete, is the first thing to run down — if
the host already has this mechanism and it is switched off, item 1 is a one-line change.

This is prompt hardening plus a store rule, not a phase-shape change. No version bump.

---

## Hard tool budgets strand the agent

**Status:** open · the deadline half needs host support

The retry on `edabc620` narrowed scope to five files and imposed a hard tool budget.
Once the budget was spent the agent kept attempting tools it could no longer call, and
still returned nothing. The budget converted a slow phase into a stuck one: a hard block
removes the agent's ability to act without giving it a reason to stop.

What is wanted instead:

- a **soft warning** once the normal inspection allowance is spent, carrying an explicit
  instruction to finalize from the evidence already in hand;
- a **phase deadline**, short relative to the phase's measured wall time;
- **automatic conversion of a timeout into a structured `blocked`**, so a phase that runs
  out of time produces evidence rather than silence.

The first is a prompt change. The last two are host capabilities — the pi extension and
the Claude Code hooks, not the skill files — which puts the deadline half behind the
Claude Code adapter still unvalidated on a real run. Do the prompt half first; it is free
and it is most of the value.

One caution on choosing the deadline: do not derive it from v4 wall-clock. Every phase in
`a5469442` reads ~512,000s because HITL pauses count toward phase duration. Use v3
figures or turn counts.

---

## Version bump discipline

**Status:** open risk, no enforcement possible

Run versioning is built (see `tooling/README.md`). What is *not* solved: the bump
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

### Addendum — it happened, in a way not anticipated here

The predicted failure was a *missed* bump. The observed one is a bump landing **mid-run**.
`a5469442` opened, ran C → counsel → R and entered A using `craft-plan-feasibility` — a v3
panel agent — then recorded `craft_version 3 (inferred)` followed immediately by
`craft_version 4 (declared)`, and continued with `craft-counsel` and the v4 shape. One run
holds both workflows and the store files all of it under v4.

The retro-classifier worked correctly and was overridden: it inferred 3 from the agent
names, and the later declaration won. That ordering is right in general — a declaration
should beat an inference — but it means a declaration arriving after work has been done
silently relabels that work.

Cheap mitigations, neither yet built: refuse a `craft_version` declaration that contradicts
an already-recorded inference for the same run, or record it and let `doctor` flag the run
as version-mixed. The second is strictly better, because a run whose version genuinely
changed is a real event and losing it is worse than labelling it.

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
are notional; see `tooling/README.md` for how it's derived and its known caveats.

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

Notional pricing is built (see `tooling/README.md`). One gap remains: some Codex
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

## The file-relevance packet

**Status:** proposed, unmeasured · supersedes a "Discovery phase before C" proposal

**What this replaces.** The original proposal was a read-only Discovery phase before C,
justified as a fix for the non-termination above: C would receive a curated evidence
packet and "may inspect only it unless it reports a concrete evidence gap." That framing
does not survive examination. Discovery is a read-only agent holding the same three tools
whose entire job is to crawl — nothing in it prevents the failure it was introduced to
prevent, and when Discovery hangs you are one phase further from implementation. The
termination fix is the two entries above, and it works whether or not any of this is built.

The constraint was worse than redundant. Restrict C to the packet and no setting avoids
both failure modes: a permissive evidence-gap escape means C crawls anyway and Discovery
is pure overhead, while a strict one means C plans on compressed evidence. The second
pushes on the loop that is already the most cycle-heavy structure on record — `a5469442`
ran **C four times** and took `needs-replan` from counsel twice, once with
`probe_required`. One extra C cycle costs more than the enumeration saves. **Drop the
constraint.** The packet is a head start, not a fence.

**What survives, and why it is worth building anyway.** Two arguments the original
proposal never made out loud:

*Model arbitrage.* Enumerating which files matter is a cheap-model task. It currently
happens inside expensive agents — C at 21 turns / 51 tool calls, A at 597 / 1013
(`a5469442`). Moving those turns down a price tier is a saving at constant total work,
which is the opposite of the usual phase-shape trade.

*The artifact is durable.* Framed as C's private input, the packet is read once and
discarded, and total turns almost certainly rise — the same files get read, plus a
serialization boundary, and C re-opens whatever the packet compressed away. Framed as a
run artifact that C, R, A, and T all consume, the target moves from C to A. C is 1.4% of
notional in the v4 run and 11% in v3; **A is 77%**. Every phase re-derives file relevance
from scratch today. That is the turn-count intervention the cost analysis above asked
for, aimed at the phase that actually costs something.

A second property comes free. If R appends the files it actually touched, A receives
*planned-relevant* against *actually-touched* as a diff. Judging plan deviation is already
A's duty (`SKILL.md:214`), and today A derives it by hand from the tree.

**The gating measurement, before any of this is built.** Whether the packet helps A
depends entirely on what A's 1013 tool calls are doing. If they are repeated re-reads of a
small file set, the packet removes them. If they are reasoning loops over code A has
already read, it removes nothing and adds a payload. A tool-call histogram by file across
A's window answers it. Do not build against the assumption.

**Open questions**

1. **Phase or artifact?** A phase costs a version bump, a metrics enum entry, `doctor`
   coverage, and blinding rules for its payload. An artifact the conductor composes costs
   none of that — but it is then invisible to metrics, and unmeasurable changes are how
   the version confusion above happened. Current lean: a spawned `craft-scout` recorded as
   its own phase, accepting the bump, because a change justified on cost that cannot be
   costed is not worth making.
2. **Staleness.** The packet is composed before R and consumed by A after R has changed
   the tree. R appending touched files covers additions; it does not cover an entry that
   stopped being relevant.
3. Whether enumeration is genuinely cheap-model work, or whether knowing *which* files
   matter requires the same judgment that makes C expensive in the first place.

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
  today is `tooling` and nothing else. Everywhere else Render gains one skipped call
  and A takes the reading path. The skip branch is the norm, not the exception.
- **The comparison baseline is v3.** The 20.8-turn figure comes from runs that predate
  every change made since. A's duties narrowed at the same time mutation arrived, so a
  drop cannot be attributed to mutation alone without holding the rest still.

Known limitation, not worth fixing yet: mutation runs once, in R. If F adds a test in
response to a survivor, that fix is verified but not re-mutated.

---

## blind.ts coverage

**Status:** known gap · smallest of the remaining ones

54.4% mutation score, the lowest in `tooling`, on the code that enforces reviewer
blinding. Everything around it was brought up during the coverage pass and this was left.

It matters more than the number suggests: the scrubber is the mechanical half of blinding,
and the prose half is an instruction that may or may not land. If the scrubber is quietly
wrong, nothing else reports it — the breach counter counts what the scrubber *caught*, not
what it missed.

---

## Claude Code host adapter

**Status:** built · unmeasured on a real run

`extensions/claude-code.ts` supplies the same three things pi's extension does —
per-turn usage against the phase open at the time, interception that scrubs authorship
from a reviewer's payload before the subagent spawns, and run open/close detection —
plus the price source that was the other blocker: `src/prices/anthropic.json`, merged
underneath whatever the host's own registry knows.

Host became a comparison axis rather than a label in the same change. `totals` splits
by workflow version *and* harness, `models` reports one row per host, and `doctor`
flags a run belonging to neither. Turning that on immediately surfaced a Claude Code
run that had been sitting inside the pi averages with zero usage recorded, quietly
dragging every phase figure down — the argument for the split, in one observation.

Three things a probe of a live session turned up, none of them documented, all of them
silent corruption rather than crashes:

- one API response is written to the transcript **once per content block**, sharing a
  `requestId`, with usage that *grows* across the lines. Deduping on the per-line
  `uuid` triples the bill; taking the first line reports 3 output tokens for a
  184-token response
- a subagent's `tool_response.usage` is only its **last message** — 225 tokens of an
  actual 441. `SubagentStop` carries an undocumented `agent_transcript_path`, which is
  the real source, and it works for background subagents too
- hooks fired **inside** a subagent report the *parent's* `transcript_path`

**What is still unknown: whether it attributes correctly under a real protocol run.**
Every figure so far comes from synthetic transcripts and one smoke test. The
measurement that settles it is a `/craft-lite` run on Claude Code followed by
`show --last 1` — every phase carrying nonzero tokens and tool calls, `unattributed`
near zero. Pi's first implementation failed exactly that check, at 86%.

Two smaller unknowns, both cheap to settle on that same run: whether
`hookSpecificOutput.updatedInput` is honoured (the blinding guarantee rests on it, and
it is the one part of the design tested only against a mock), and what the per-tool-call
hook costs in practice — 82 ms measured against a small store, where the real log is
1.5 MB and growing.
