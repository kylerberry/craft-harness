# craft-routes

Merge CRAFT role primary + `fallbackModels` into a Pi settings file at `subagents.agentOverrides`. Same-role hops on provider/model failure. The DAG supervisor does not pick ad hoc models. Claude Code and other hosts fail explicitly.

```bash
craft-routes --host pi --settings PATH [--apply] [--dry-run]
```

| Flag | Meaning |
| --- | --- |
| `--host pi` | only supported host |
| `--settings` | Pi `settings.json` |
| `--apply` | replace CRAFT role routes, including `craft-node-writer`, and remove leftover `node-conductor` overrides |
| `--dry-run` | print what would change; do not write |

Without `--apply`, fills **missing or incomplete** role routes only and leaves a complete custom route alone. Unrelated keys (`theme`, `packages`, other agents, `modelScope`) are never touched.

Defaults (C→counsel, R→A, R→T **primary** families disjoint; fallbacks may overlap; moonshot never primary, always last):

| Role | Primary | Fallbacks |
| --- | --- | --- |
| `craft-planner` | `openai-codex/gpt-5.6-sol` | xai, zai, moonshot |
| `craft-counsel` | `zai/glm-5.3` | openai-codex, xai, moonshot |
| `craft-builder` | `zai/glm-5.2` | xai, openai-codex, moonshot |
| `craft-evaluator` | `xai/grok-4.6` | openai-codex, zai, moonshot |
| `craft-security-review` | `openai-codex/gpt-5.6-terra` | xai, zai, moonshot |
| `craft-node-writer` | `zai/glm-5.2` | xai, openai-codex, moonshot |

Failover onto another role's primary family can collapse diversity. Moonshot is last-resort only. These are session-level Pi subagent fallbacks. Account rotation (`provider-failover.json`) is separate. Do not pass `model:` on craft role spawns — that skips `fallbackModels`.

Bin: `tooling/bin/craft-routes.mjs` → `tooling/src/route-install-cli.ts`.
