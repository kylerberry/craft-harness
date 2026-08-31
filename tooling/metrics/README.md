# craft-metrics

Phase-grained collector. Skills emit semantics; host adapters stamp usage. Store: `~/.local/share/craft-metrics/events.jsonl`.

```
skill                →  start / enter / exit / end
Pi extension         →  turn_end, tool_execution_end, agent_end (residual only)
Claude Code hooks    →  PostToolUse / Stop / SubagentStop / PreToolUse
```

```bash
craft-metrics start  --kind feature|bugfix|refactor|scaffold|docs|chore
                     --mode full|hitl|lite|dag [--host pi|claude-code]
                     [--cwd PATH] [--repo NAME] [--craft-version V]
craft-metrics enter  --run ID --phase D|C|counsel|R|A|F|T|S [--agent NAME]
craft-metrics exit   --run ID --phase PHASE --reason report|blocked|timeout
                     [--blocked-detail-ref REF]  # required for blocked|timeout, ≤256 chars
craft-metrics intervene --run ID --phase PHASE --kind finalization-request
                     --observed-turns N --observed-tools N
craft-metrics verify --run ID --command "npm test" --exit-code N
craft-metrics orchestration-failure --run ID --kind validation|parse|dispatch --evidence TEXT
craft-metrics pause|resume --run ID
craft-metrics mode --run ID --mode MODE
craft-metrics end  --run ID [--outcome completed|aborted|blocked|hitl-paused]
craft-metrics current [--cwd PATH]
craft-metrics show [--run ID] [--last N]
craft-metrics totals [--all]
craft-metrics models
craft-metrics doctor [--stale-hours N]
craft-metrics pin-versions [--apply]
```

Do not invent tokens or cost in the skill. `--craft-version` is the frontmatter value in `skills/craft/SKILL.md` (currently 5).

`intervene` is not usage and does not change cycles, turns, tools, timeouts, or failovers. `orchestration-failure` evidence is single-line, control-free, ≤1024 bytes; it does not enter a phase.

## Attribution

| # | route | meaning |
|---|---|---|
| 1 | `stamped` | emitter passed `--phase` |
| 2 | `open-phase` | a phase is open |
| 3 | `agent-map` | named `craft-*` agent |
| 4 | `backfilled` | just-closed phase within `CRAFT_METRICS_BACKFILL_MS` (off by default) |
| 5 | `unattributed` | nowhere |

Emit per turn. A session-end lump after `end` belongs to no phase.

| env | effect |
|---|---|
| `CRAFT_METRICS_PATH` | event log path |
| `CRAFT_METRICS_PRICES` | exact price table |
| `CRAFT_METRICS_BACKFILL_MS` | route 4 window; `0` off |

## Doctor

Exits 1 on: `ungated`, `stale-open`, `phase-never-exited`, `costless-model`, `unattributed`, `phase-usage-missing`, `unknown-host`, `orchestration-failure`.

v3 infers from `craft-plan-*` / spawned simplifier; v4 from `craft-counsel`, verify, blinding, R decision record; v5 from an entered `D` phase.

Bin: `tooling/bin/craft-metrics.mjs` → `tooling/src/cli.ts`.
