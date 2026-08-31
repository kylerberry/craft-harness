# craft-discover

Deterministic, read-only Discovery. Writes an immutable YAML evidence packet under the OS temporary directory. Does not plan, reinterpret criteria, expand scope, or rebuild Graphify.

```bash
craft-discover --task-source PATH [--task-source PATH ...] \
  [--fact "CLAIM::PATH:LINE"] [--cwd PATH]
```

| Flag | Required | Meaning |
| --- | --- | --- |
| `--task-source` | yes | repository-relative file; repeatable |
| `--fact` | no | `claim::path:line`; omitted from `verified_facts` until that line contains the claim |
| `--cwd` | no | git repo (default: process cwd) |

| Exit | Meaning |
| --- | --- |
| 0 | packet written; authority resolved |
| 1 | packet written with unresolved/conflicting authority in `evidence_gaps`, or secret/bound rejection with **no** file |
| 2 | invalid input; no packet |

Stdout is `$TMPDIR/craft-discover-*/evidence.yaml` (mode `0600`) on 0/1 when a packet exists.

Packet keys, always exactly these: `schema_version`, `base_commit`, `graph_status`, `authority_sources`, `task_sources`, `graph_candidates`, `verified_facts`, `evidence_gaps`.

- Nested `AGENTS.md` from each task source to repo root
- `docs/wiki/index.md` plus one Markdown link whose label contains `current`
- Task bytes hashed `sha256:…`
- `graph_status`: `current` \| `stale` \| `unavailable` against `graphify-out/graph.json` vs HEAD. Candidates (path, reason, source_location) only when current and grounded in task vocabulary. Graph claims are never facts until cited.
- Secrets (`token=`, `sk-…`, etc.) block before write. Size/item caps enforced. No identity metadata.

Bin: `tooling/bin/craft-discover.mjs` → `tooling/src/discover-cli.ts`.
