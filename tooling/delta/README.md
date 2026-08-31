# craft-delta

Post-Render change artifact. Complements the Discovery packet; does not rediscover or spawn Graphify.

```bash
craft-delta --base REF [--verify-command CMD --exit-code N]... [--packet PATH] [--cwd PATH]
```

| Flag | Required | Meaning |
| --- | --- | --- |
| `--base` | yes | `R_BASE` captured before Render (`git rev-parse HEAD`) |
| `--verify-command` | no | recorded command; repeatable, each needs `--exit-code` |
| `--exit-code` | with verify | recorded exit code, not re-executed |
| `--packet` | no | Discovery YAML path; mtime must be unchanged |
| `--cwd` | no | git repo (default: process cwd) |

Stdout is a path under `$TMPDIR/craft-delta-*/delta.yaml` (mode `0600`). Missing `--base` or mismatched verify pairs → exit 2.

```yaml
r_base: "<git ref>"
changed_files:
  - "src.ts"
validation:
  - command: "npm test"
    exit_code: 0
source_locations:
  - "src.ts:1"
  - "new.ts:1-3"
```

Tracked diff vs `--base` plus untracked files. Hunks become `file:line` or `file:start-end` on the new side; pure deletions omitted. Lists sorted. No author, model, agent, workflow, branch, DAG, or first-person keys.

A and T receive this path and still inspect the final diff independently.

Bin: `tooling/bin/craft-delta.mjs` → `tooling/src/delta-cli.ts`.
