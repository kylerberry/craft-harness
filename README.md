# craft-metrics

Phase-grained collector for CRAFT runs. Skills emit semantics; hosts emit usage. Neither is complete alone.

```
skill          →  start / enter / exit / end
Pi extension   →  turn_end, tool_execution_end, agent_end (residual only)
Claude Code    →  (later: Stop / PostToolUse hooks)
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

## Install

```bash
# CLI
ln -sf "$(pwd)/bin/craft-metrics.mjs" ~/.local/bin/craft-metrics

# Pi adapter (auto-loads the extension)
pi install /absolute/path/to/craft-metrics
```

| env | effect |
|---|---|
| `CRAFT_METRICS_PATH` | override the event log |
| `CRAFT_METRICS_BACKFILL_MS` | grace window for route 4. Off (`0`) by default |

## Skill contract

At each CRAFT gate the conductor runs:

```bash
RUN=$(craft-metrics start --kind feature --mode full --host pi --cwd "$PWD")   # once
craft-metrics enter --run "$RUN" --phase C --agent craft-planner
# ... phase work ...
craft-metrics exit  --run "$RUN" --phase C --security-triggers untrusted-input
craft-metrics end   --run "$RUN" --outcome completed
```

Do not invent tokens or cost in the skill. The host adapter stamps those.

## Show

```bash
craft-metrics show --last 5
craft-metrics totals          # per phase: cost, time, turns, tokens
craft-metrics models          # per model: turns and tokens
craft-metrics doctor          # exits 1 if the data is lying to you
```

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

## Doctor

Silent collection bugs are the main risk here — the numbers stay plausible while
being wrong. `doctor` reports:

- **ungated** — `start` was called but no phase was ever entered, so the whole run's
  cost is unattributable
- **stale-open** — a run left open with no `run_end` (`--stale-hours`, default 12)
- **costless-model** — a model that burned tokens and reported `$0`, which makes
  cost incomparable across runs. Subscription-billed models (Codex) do this; compare
  tokens instead
- **unattributed** — share of total spend that landed outside any phase
