# craft-agents

Generate Claude Code agent files from `agents/*.md` (Pi dialect). Names stay exact — phase map, blinding targets, and the PreToolUse matcher key on them.

```bash
craft-agents <source-dir> <output-dir>
```

Exits nonzero on the first file it cannot port (unknown tool, unhandled frontmatter). `subagent_wait` is Pi-only and omitted from the Claude Code output.

`link-global` runs this into `~/.claude/agents/`.

Bin: `tooling/bin/craft-agents.mjs` → `tooling/src/agent-port-cli.ts`.
