# craft-discover

`craft-discover` performs deterministic, read-only Discovery and writes a neutral YAML evidence packet beneath the OS temporary directory:

```bash
craft-discover --task-source src/file.ts \
  --fact 'supported statement::docs/spec.md:12'
```

`--task-source` and `--fact` are repeatable; paths are repository-relative. The command resolves applicable ancestor `AGENTS.md` files and a single Markdown link whose label contains `current` in `docs/wiki/index.md`. It hashes exact task-source bytes, verifies each claimed fact against its cited line, and records Graphify output as `current`, `stale`, or `unavailable` without rebuilding it. Exit 0 means authority resolved, exit 1 means a packet was written with unresolved/conflicting authority named in `evidence_gaps`, and exit 2 means invalid input (no packet). The packet always contains exactly `schema_version`, `base_commit`, `graph_status`, `authority_sources`, `task_sources`, `graph_candidates`, `verified_facts`, and `evidence_gaps`.

# craft-metrics

Phase-grained collector for CRAFT runs. Skills emit semantics; hosts emit usage. Neither is complete alone.

```
skill                →  start / enter / exit / end
Pi extension         →  turn_end, tool_execution_end, agent_end (residual only)
Claude Code hooks    →  PostToolUse / Stop (transcript tail), SubagentStop, PreToolUse
                       ↘
               ~/.local/share/craft-metrics/events.jsonl
```

## Attribution

A usage event lands on a phase by the first of these that applies:

| # | route | meaning |
|---|---|---|
| 1 | `stamped` | the emitter passed `--phase` — it knew what was open when the work *started* |
| 2 | `open-phase` | a phase is open right now |
| 3 | `agent-map` | a named `craft-*` agent whose phase is fixed by protocol |
| 4 | `backfilled` | the phase that just closed, within `CRAFT_METRICS_BACKFILL_MS` (off by default) |
| 5 | `unattributed` | nowhere — never folded into C or R |

**Emit per turn, not per session.** Pi reports a headless agent's entire run in one
`agent_end` lump that arrives *after* the skill has closed S and ended the run. That
lump spans every phase, so it belongs to none of them — the first six days of
collection put 86% of spend ($78 of $91) in `unattributed` this way. `turn_end` bills
each turn as it completes, inside whichever phase is open. `agent_end` now reports only
turns `turn_end` missed, deduped by message identity.

Backfill (route 4) is deliberately off. Charging a whole-session lump to whichever phase
happened to close last is worse than admitting it is unattributed. Turn it on only for a
host that genuinely reports small, late increments.

`show` prints `(backfilled $N)` on any phase holding guessed cost, and flags runs that
were started but never gated.

## Reading a Claude Code transcript

Claude Code has no extension API, so the adapter is a set of hooks — each one a
separate short-lived process — and usage is read out of the session transcript.
Probing a real session turned up three traps, all of which corrupt quietly rather
than crashing:

**One response is written as several lines.** A single API response appears once per
content block (thinking, text, tool_use), sharing a `requestId`, with a `usage` that
*grows* across them. Deduping on the per-line `uuid` triples the bill; taking the
first line reported 3 output tokens where the response produced 184. The adapter
keys on `requestId` and bills the increase.

**A subagent's `tool_response.usage` is only its last message.** In the probe it read
225 tokens against an actual 441. `SubagentStop` carries `agent_transcript_path` — the
subagent's own transcript — and that is what gets billed.

**Hooks fired inside a subagent report the parent's `transcript_path`.** So the main
transcript is flushed only from the main thread; a subagent's spend arrives once, at
its own stop, marked `subagent`.

Cost is recorded as `$0` because Claude Code reports none. That is honest, and it is
also why the bundled price table matters: without it a Claude Code phase prices at
zero and reads as free beside a metered Pi phase. Compare hosts by `notional` or
tokens, never by `cost`.

## Install

```bash
# Everything, on the author's machine
../bin/link-global

# Or piecemeal
ln -sf "$(pwd)/bin/craft-metrics.mjs" ~/.local/bin/craft-metrics
ln -sf "$(pwd)/bin/craft-hook.mjs"    ~/.local/bin/craft-hook
pi install "$(pwd)"                                    # Pi adapter
./bin/craft-agents.mjs ../agents ~/.claude/agents      # Claude Code agent files
./bin/craft-hooks-install.mjs ~/.claude/settings.json  # Claude Code hooks
```

Claude Code reads hooks at startup, so an already-running session keeps the old set —
restart it. `craft-hooks-install` merges into the existing settings, backs the file up
first, and is a no-op on re-run.

| env | effect |
|---|---|
| `CRAFT_METRICS_PATH` | override the event log (the hook adapter honours it too) |
| `CRAFT_METRICS_PRICES` | use exactly this price table, instead of bundled + host registry |
| `CRAFT_METRICS_BACKFILL_MS` | grace window for route 4. Off (`0`) by default |

## Skill contract

At each CRAFT gate the conductor runs:

```bash
RUN=$(craft-metrics start --kind feature --mode full --host pi --cwd "$PWD")   # once
craft-metrics enter --run "$RUN" --phase C --agent craft-planner
# ... phase work ...
craft-metrics exit  --run "$RUN" --phase C --reason report --security-triggers untrusted-input
craft-metrics end   --run "$RUN" --outcome completed
```

Every explicit phase exit supplies `--reason report|blocked|timeout`. Blocked and timeout exits also require `--blocked-detail-ref`, a single-line reference of at most 256 characters to the missing evidence or pending decision; `show` renders both fields. A timeout exit is therefore a closed terminal artifact, unlike a phase that was entered but never exited.

Do not invent tokens or cost in the skill. The host adapter stamps those.

A conductor can record a bounded finalization request against the currently open phase:

```bash
craft-metrics intervene --run "$RUN" --phase C --kind finalization-request \
  --observed-turns 12 --observed-tools 20
```

This append-only control event records the observed limits and timestamp. It is not model
usage and does not change phase cycles, turns, tool calls, timeouts, or failovers.

Workflow validation, packet parsing, and dispatch defects belong to the run rather than a phase attempt:

```bash
craft-metrics orchestration-failure --run "$RUN" --kind validation --evidence "unknown dependency"
```

Kinds are `validation`, `parse`, or `dispatch`. Evidence must be non-empty, single-line,
control-free, and at most 1,024 UTF-8 bytes. Recording this event never enters or exits a
phase and does not change phase entries, cycles, or retry counts.
## Show

```bash
craft-metrics show --last 5
craft-metrics totals          # per phase, split by workflow version
craft-metrics totals --all    # ... blended across versions
craft-metrics models          # per model: turns and tokens
craft-metrics doctor          # exits 1 if the data is lying to you
```

## Workflow versions

The workflow being measured changes. Phases merge, agents collapse, gates appear — and a
phase averaged across such a change describes a workflow that never existed, which is
worse than missing data because it looks like signal.

Pass `--craft-version N` at `start`. Runs recorded before that flag existed are classified
from what they actually spawned: `craft-plan-*` or a spawned `craft-code-simplifier` /
`craft-sharpener` marks v3; `craft-counsel`, a recorded verify, blinding scrubs, or an R
decision record marks v4. Inference is always labelled — `~` in `show`, `(n inferred)` in
`totals` — and conflicting or absent signals resolve to unknown rather than a guess.

`totals` splits by version by default. This is not cosmetic: all 23 recorded `counsel`
phases used the three-agent panel, so their ~12 min/invoke is a panel's wall time, and the
single reviewer that replaced it has never been measured. A blended table would have hidden
that permanently.

## Tokens, not just dollars

Cost is not comparable across models. Subscription-billed models (Codex) report real
token counts and `$0`, so a cost-only view makes them look free and silently understates
whichever phases they ran — in the first six days, 1,180 Codex turns and 104M tokens
rendered as `$0.0000`.

`totals`, `models`, and `show` all print tokens alongside cost, and a model that burned
tokens without a price prints `n/a` rather than `$0.00`. Every phase keeps a `by_model`
split, so a phase running a conductor and a subagent on different models attributes each
one's tokens correctly instead of collapsing to whichever model it saw last.

`cacheWrite` is genuinely 0 for xAI / OpenAI / zAI — those providers cache implicitly and
bill no separate write. Only Anthropic reports that split.

Seams (`counsel≠C`, `A≠R`, `T≠R`) are computed from actual models, not prompts.

Prices come from the bundled table (`src/prices/anthropic.json`) with the host's own
registry merged over the top — Pi's registry knows the models Pi routes to, and
nothing on the machine knows Anthropic's. `CRAFT_METRICS_PRICES` replaces both.

## Two harnesses, two populations

`host` is not a label, it is an axis. `totals` splits by workflow version **and**
harness, and `models` reports one row per host per model — the same model runs under
both, so merging on the model id alone averages two harnesses into one number.

The split is not cosmetic. Turning it on immediately surfaced a Claude Code run that
had been sitting inside the Pi averages with zero recorded usage, quietly dragging
every per-phase figure down.

`doctor` reports `unknown-host` for a run that names no harness: it sits in its own
bucket and compares against nothing. `craft-metrics host --run ID --host claude-code`
fixes one after the fact — and both adapters correct it on sight, because an adapter
observes its host first-hand while `start --host` only repeats what the conductor
typed.

## Doctor

Silent collection bugs are the main risk here — the numbers stay plausible while
being wrong. `doctor` reports:

- **ungated** — `start` was called but no phase was ever entered, so the whole run's
  cost is unattributable
- **stale-open** — a run left open with no `run_end` (`--stale-hours`, default 12)
- **phase-never-exited** — a phase with more `phase_enter` events than explicit
  `phase_exit` events, even if `run_end` or a later phase implicitly closed it
- **costless-model** — a model that burned tokens and reported `$0`, which makes
  cost incomparable across runs. Subscription-billed models (Codex) do this; compare
  tokens instead
- **unattributed** — share of total spend that landed outside any phase
- **phase-usage-missing** — an entered phase recorded tool or subagent activity but
  has zero attributed turns and tokens; phase-level activity and usage counts identify
  where attribution was lost, while genuinely zero-work phases remain valid
- **unknown-host** — a run that names no harness, so it compares against nothing
- **orchestration-failure** — a bounded run-level validation, parse, or dispatch defect;
  reported separately from phase failures
