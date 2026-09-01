# Roadmap

Open work, plus the reasoning that produced it. Shipped items sit at the bottom so the decision trail survives.

> **Every measurement on this page is CRAFTS v3 data unless marked otherwise.** Two runs carry a v4 label and neither is a clean baseline. `a5469442` opened under v3, ran a full `craft-plan-feasibility` counsel and a C→counsel→R→A prefix, then declared version 4 mid-run. `edabc620` entered C twice, never exited, and recorded zero turns, zero tool calls, and zero tokens.
>
> Protocol is now **v5** (Discovery gate, single `craft-counsel`, inline simplify and Sharpen, depth-1 DAG with `craft-node-writer`, no `node-conductor`). v5 has no uncontaminated measurement. Directions are probably robust (A's turn count dwarfs every other phase). Magnitudes will move. Re-measure before acting on any specific figure here.
>
> Where a v4 figure is cited it comes from `a5469442` and is marked as such. Its wall-clock is unusable — HITL pauses count toward phase duration.

---

## Validate attribution on a real v5 run

**Status:** blocking · **Size:** one `/craft` run and one depth-1 `/execute-dag` run, plus a reading

Attribution was reworked so usage is stamped with the phase open when the work started. Post-fix days read 100% placed — on $0.17 across 23 runs, nearly all CLI smoke tests. Unreleased Pi metrics bill children from the `subagent` tool result; wave children are siblings with ambient extensions off. That path has never seen real traffic.

Until a genuine `/craft` and `/execute-dag` run land and hold near 100%, every per-phase figure in this file is provisional. Depth-1 DAG is a new attribution shape, not the nested `node-conductor` the older numbers assumed.

```bash
craft-metrics show --last 1
craft-metrics doctor
```

Watch for cost landing in `unattributed`, `ungated` on CRAFTS runs, and `costless-model` entries. This gates the honest version of A's cost, counsel latency, blinding scrubs, and DAG supervisor ratio.

---

## Version bump discipline

**Status:** open risk, no enforcement

The rule is "bump when a phase's shape changes — agents added or removed, duties moved, gates introduced; not for wording." Miss one and two workflows share a label. The retro-classifier cannot save a missed bump: it infers from agent names and structural markers, and those markers are then identical.

The observed failure was a bump **mid-run**, not a missed one. `a5469442` recorded `craft_version 3 (inferred)` then `craft_version 4 (declared)` and filed both workflows under v4. A declaration beating an inference is right in general; a late declaration silently relabels earlier work.

Cheap mitigations, neither built: refuse a `craft_version` declaration that contradicts an already-recorded inference for the same run, or record it and let `doctor` flag the run as version-mixed. The second is strictly better — a run whose version genuinely changed is a real event.

Treat any `skills/craft/SKILL.md` phase-structure edit as requiring a bump decision in the same commit.

---

## Tier by task value

**Status:** explored, not started · **Size:** comparable to the counsel collapse

`mode` still conflates two axes:

- **protocol shape** — `hitl` (human seam), `dag` (supervisor session)
- **task value** — `lite` (cheap work)

`lite` is a tier wearing a mode costume. Splitting the axes is the proposal:

```
mode:  full | hitl | dag   ← shape
tier:  small | standard    ← value
```

`/craft-lite` becomes `--tier small`, and that skill file goes away.

v3 notional spend (stale magnitudes; A-dominates direction still the working hypothesis):

| phase | notional $ | share |
| --- | --- | --- |
| A | $57.73 | 61% |
| R | $14.25 | 15% |
| C | $9.98 | 11% |
| counsel | $5.96 | 6% |
| F | $4.72 | 5% |
| T | $1.21 | 1% |
| S | $0.48 | 1% |

Dropping to `small` only removes counsel, T, and S — **8% of v3 notional spend**. Tiering by phase is a latency lever (it removes counsel wall-clock) far more than a cost lever. The cost lever is A.

| Lever | small | standard |
| --- | --- | --- |
| 1. phases | D→C→R→A | + counsel, T, S |
| 2. models | cheap except A | current pins |
| 3. verification | local | + clean-room at node exit |

v5 added D, so the floor is `D→C→R→A`, not `C→R→A`. Below that it is ordinary coding; do not invoke craft.

Security-critical work is not a third tier. `--force-tighten` plus a store guard that forbids `small` when `security_triggers` is non-empty is enough.

Selection must be asymmetric: escalation automatic, de-escalation explicit. `kind` seeds a default (`docs`/`chore` → small, `feature`/`bugfix` → standard). C may propose; the user overrides.

`tier` can land alongside `mode` with `lite` kept as an alias. Record `tier` on the run so `totals` can group by tier × kind.

---

## A's cost concentration

**Status:** open, most consequential item · data is v3

A was 61% of v3 notional spend (77% on the hybrid `a5469442` run). No phase-presence tier touches it. Round trips are not the cause: 29 of 31 runs entered A once.

v3 cause was **turn count** and cache that scales with it: A 20.8 turns, 3.39M cached tokens/invocation, cache ÷ fresh 47.3. Fresh input 65k, output 7k. It pays to re-read its own context.

Levers, in order of expected leverage:

1. Mechanical weakened-test detection (`craft-mutate`) so A does not grep-hunt. Built, unmeasured — see below.
2. Pre-digested findings where re-derivation is not the point. Decision record shipped. Discovery packet + `craft-delta` shipped as the file-relevance artifact. Whether either moved A's turns is unmeasured.
3. Depth-1 DAG changes A's context: fresh sibling spawn, not a nested conductor transcript. New, unmeasured.

Do not spend more design on payload trimming or model-tier swaps until a v5 A histogram exists. A 10% drop in A's cost still beats eliminating counsel, T, and S combined — if the concentration survived v5.

---

## Clarify gate

**Status:** explored, not started

A human-approved criteria checkpoint before implementation (Spec Kit: Specify → **Clarify** → Plan). C already emits `blocking_questions`; AFK mode charges past them. Approving criteria costs a sentence; approving an implementation costs a review.

Open: interaction with `afk_hitl_status`, and whether this is a distinct phase or a stop inside C. A distinct phase is measurable; a stop condition is cheaper.

---

## Single-threaded for small work

**Status:** blocked on data · overhead model changed in v5

The DAG layer earns its keep on genuinely parallel graphs. A three-node DAG may still pay supervisor cost — worktrees, dispatch, waiting, sequential merges — for coordination it does not need.

v5 removed nested `node-conductor`. Overhead is now supervisor + static wave script + worktrees. `dag` runs already bucket orchestration into the `supervisor` phase; the ratio of supervisor cost to summed node cost answers this. Needs several real depth-1 DAG runs. Decide the node-count threshold from that ratio.

---

## Does blinding need the safety net?

**Status:** open question, blocked on v5 reviewer spawns

The scrubber is built and records `blinding_scrubs`. Consistently zero means conductors compose clean payloads and the scrubber is insurance. Consistently non-zero means the prose rules are not landing and the mechanical net is the only leak prevention — which argues for mechanising other "the conductor should…" rules.

No reviewer spawn has a clean v5 reading.

---

## Counsel wall time

**Status:** open question — single-reviewer counsel is unmeasured

All 23 recorded `counsel` phases used the three-agent `craft-plan-*` panel. Zero runs of merged `craft-counsel`. The old "twelve minutes" is panel wall time (roughly the slowest of three), not one reviewer's latency.

v4/v5 counsel is one reviewer, three lenses. It may be faster (no fan-out) or slower (serial lenses). Collect v5 counsel wall time. By v3 notional cost counsel was 6%; the case is latency.

---

## Did mutation testing replace A's hunting, or add to it?

**Status:** built, unmeasured · blocked on v5 runs with a Stryker config

`craft-mutate` is wired into Render. A's weakened-test duty is conditional: adjudicate the survivor list when there is one, read for it when there is not. The job was never "find mutants"; it was "stop A from spending turns hunting." Verdict is **A's turn count**.

Adoption is per-repo. Mutation runs only where `stryker.config.json` exists. Everywhere else Render skips and A takes the reading path.

The 20.8-turn baseline is v3 and predates mutation, the decision record, and Discovery. A drop cannot be attributed to mutation alone.

Known limitation: mutation runs once, in R. If F adds a test in response to a survivor, that fix is verified but not re-mutated.

---

## blind.ts coverage

**Status:** known gap

54.4% mutation score, the lowest in `tooling`, on the code that enforces reviewer blinding. The breach counter counts what the scrubber *caught*, not what it missed.

---

## Claude Code host adapter

**Status:** built · unmeasured on a real protocol run

`extensions/claude-code.ts` stamps per-turn usage, scrubs reviewer payloads, and detects run open/close. Synthetic transcripts and one smoke test are the only figures. `/execute-dag` needs Pi `workflowScript`; the settling measurement is `/craft-lite` on Claude Code followed by `show --last 1` — every phase carrying nonzero tokens and tool calls, `unattributed` near zero.

Still cheap to settle on that run: whether `hookSpecificOutput.updatedInput` is honoured (blinding rests on it), and per-tool-call hook cost against a real log.

Documented silent-corruption traps (dedupe on `uuid`, last-message `tool_response.usage`, hooks inside subagents reporting the parent's `transcript_path`) stay relevant.

---

## Tier-aware notional pricing

**Status:** known limitation · low priority

Notional pricing is built. Codex `sol`/`terra` charge a higher rate above a per-request context threshold. Tokens are summed per phase, so which requests crossed the threshold is not reconstructable — notional always prices at the base tier. Systematic under-count on long-context phases, which is where the interesting costs are.

Fixing it means per-request token counts. Worth doing only if a phase comparison turns on a margin narrow enough for the under-count to flip it.

---

## Shipped in v5

Kept here so the next person does not re-propose them.

### Terminal contracts

Every role prompt ends in exactly one of two shapes: structured report, or `blocked` naming missing evidence. `doctor` flags `phase-never-exited` and `phase-usage-missing`. `completionGuard: false` on planner and builder is correct for those roles (Pi's guard checks implementation mutation), not a missing host feature. Residual: whether v5 planners still hang in practice.

### Turn-based health checks

Hard tool budgets stranded agents (retry on `edabc620`). Replaced by a configured health-check cadence (`craft-metrics intervene --kind health-check`) that records evidence, next action, and uncertainty without requesting completion. Only a host-level no-activity watchdog may synthesize a timeout. `finalization-request` remains in the schema for historical events.

### Discovery packet and Render delta

The spawned `craft-scout` / "C may inspect only the packet" design was rejected: a permissive gap-escape means C crawls anyway; a strict fence plans on compressed evidence. What shipped is a conductor-run `craft-discover` CLI (no spawn, not a fence) plus `craft-delta` after R (planned-relevant vs actually-touched). Graphify is never rebuilt mid-run. Whether the packet reduced A's tool calls is the unmeasured half, folded into A's cost above.
