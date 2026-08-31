# craft-hooks-install / craft-hook

Claude Code has no extension API. Metrics ride on hooks; each hook is a short-lived process that tails the session transcript.

```bash
craft-hooks-install <settings.json>
```

Merges this repo's hook command into existing Claude Code settings, backs the file up first, no-op on re-run. Claude Code reads hooks at startup — restart open sessions.

`craft-hook` is the hook entry the installer registers (`~/.local/bin/craft-hook` after `link-global`).

Transcript traps the adapter accounts for: one API response is several lines sharing `requestId` with growing usage; a subagent's `tool_response.usage` is only its last message (`SubagentStop.agent_transcript_path` is billed instead); hooks inside a subagent report the parent's `transcript_path`.

Bins: `tooling/bin/craft-hooks-install.mjs`, `tooling/bin/craft-hook.mjs`.
