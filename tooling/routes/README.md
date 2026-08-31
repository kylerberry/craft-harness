# craft-routes

Merge CRAFT role primary + `fallbackModels` into a Pi settings file at `subagents.agentOverrides`. Same-role hops on provider/model failure. Conductors do not pick ad hoc models. Claude Code and other hosts fail explicitly.

```bash
craft-routes --host pi --settings PATH [--apply] [--dry-run]
```

| Flag | Meaning |
| --- | --- |
| `--host pi` | only supported host |
| `--settings` | Pi `settings.json` |
| `--apply` | replace the five CRAFT roles and pin `node-conductor` to `{ "model": "inherit" }` from repo defaults |
| `--dry-run` | print what would change; do not write |

Without `--apply`, fills **missing or incomplete** role routes only and leaves a complete custom route alone. Unrelated keys (`theme`, `packages`, other agents, `modelScope`) are never touched.

Defaults (C→counsel, R→A, R→T family sets disjoint):

| Role | Primary | Fallback |
| --- | --- | --- |
| `craft-planner` | `openai-codex/gpt-5.6-sol` | `xai/grok-4.6`, then `openai-codex/gpt-5.6-terra` |
| `craft-counsel` | `zai/glm-5.3` | `moonshot/kimi-k3` |
| `craft-builder` | `zai/glm-5.2` | `moonshot/kimi-k2.7-code` |
| `craft-evaluator` | `xai/grok-4.6` | `openai-codex/gpt-5.6-sol` |
| `craft-security-review` | `openai-codex/gpt-5.6-terra` | `xai/grok-4.3` |

These are session-level Pi subagent fallbacks. Account rotation (`provider-failover.json`) is separate.

Bin: `tooling/bin/craft-routes.mjs` → `tooling/src/route-install-cli.ts`.
