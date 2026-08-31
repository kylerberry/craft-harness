# tooling

CLIs and host adapters for CRAFTS. Source stays in `src/`; each command’s API is documented next to its name:

| Command | Docs |
| --- | --- |
| `craft-discover` | [discover/README.md](discover/README.md) |
| `craft-delta` | [delta/README.md](delta/README.md) |
| `craft-routes` | [routes/README.md](routes/README.md) |
| `craft-metrics` | [metrics/README.md](metrics/README.md) |
| `craft-mutate` | [mutate/README.md](mutate/README.md) |
| `craft-agents` | [agents/README.md](agents/README.md) |
| `craft-hooks-install` / `craft-hook` | [hooks/README.md](hooks/README.md) |

```bash
../bin/link-global          # agents, skills, bins, Pi extension, Claude Code generate+hooks
pi install "$(pwd)"         # Pi adapter only
```
