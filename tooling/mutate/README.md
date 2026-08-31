# craft-mutate

Mutation testing scoped to the Render diff. Coverage says a line ran; mutation says whether any test objects when it is wrong.

```bash
craft-mutate --base <ref> [--cwd PATH] [--timeout SEC] [--max-lines N]
```

| Flag | Meaning |
| --- | --- |
| `--base` | git ref to diff against. Capture before Render edits; a conductor that commits as it goes otherwise diffs its own work |
| `--cwd` | repository root (default: cwd) |
| `--timeout` | seconds before giving up (default from `mutate.ts`) |
| `--max-lines` | skip if the scoped diff is larger than this |

Prints one JSON object. Exit 0 whenever it produced an answer, including `"skipped"` (no Stryker config is not a failure). Exit 1 only when a run was attempted and broke.

Survivors are findings to adjudicate, not a gate.

Bin: `tooling/bin/craft-mutate.mjs` → `tooling/src/mutate-cli.ts`.
