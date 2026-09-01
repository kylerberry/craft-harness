# Changelog

Protocol versions follow `craft-version` in `skills/craft/SKILL.md`. Bump when a phase's shape changes — agents added or removed, duties moved, gates introduced — not for wording.

## [Unreleased]

- DAG execution is depth 1: `/execute-dag` launches a static wave workflow of Discovery, phase advisors, and `craft-node-writer`. `node-conductor` is removed.
- `craft-routes --apply` replaces CRAFT role routes including `craft-node-writer` and deletes leftover `node-conductor` overrides; default fill still preserves complete custom routes.
- Role defaults: primary families stay disjoint; fallbacks may overlap; order is openai-codex → xai → zai → moonshot last. Moonshot is never a primary. Failover can collapse diversity.
- Pi metrics: drop cached `runId` after `run_end`; bill child spend from the `subagent` tool result (children disable ambient extensions); seams use child models and stay `?` when unmeasured.
- Per-CLI API docs under `tooling/<tool>/README.md`.

## [5] — 2026-08-31

Discovery is a real gate. Advisory phases must finish. Launch defects are not phase retries.

### Added

- **D — Discovery** before Conceptualize on `/craft`, `/craft-hitl`, and `/craft-lite`. Conductor runs `craft-discover`; C does not start without the immutable evidence packet.
- `craft-discover`: deterministic authority scan, hashed task sources, cited-fact verification, Graphify `current|stale|unavailable` without rebuilding. Packet is identity-neutral, size-bounded, and secret-rejecting. Written under the OS temporary directory.
- Graphify candidates (path, reason, source location) only when `graphify-out/graph.json` matches the base commit. Candidates are never facts until the cited source supports them.
- `craft-delta --base <R_BASE>`: post-Render changed files, validation exit codes, and source locations. Does not rewrite the Discovery packet or invoke Graphify.
- Report-or-blocked terminal contracts on planner, counsel, builder, evaluator, and security-review. Soft inspection warnings finalize from current evidence.
- Phase health: one awaited terminal result (`subagent_wait` on Pi), one `finalization-request` intervention at the no-report threshold, timeout/blocked on deadline exhaustion. Claude Code has no `subagent_wait`; that unavailability is explicit.
- `craft-metrics` D phase, `intervene`, `orchestration-failure`, explicit exit `--reason report|blocked|timeout`, and doctor rules for never-exited phases and entered phases with activity but zero usage.
- `craft-routes --host pi`: idempotent installer for role primary + `fallbackModels` chains. Overlapping families at C→counsel, R→A, or R→T are rejected. Unsupported hosts fail explicitly.
- Static execute-dag workflow script. Node packets live under the OS temporary directory; task text is never interpolated into JavaScript. `subagent action: validate` runs on that exact script before every launch.

### Changed

- Canonical sequence is `D → C → counsel → R → A → [F] → T → S` (lite: `D → C → R → A → [F] → S`).
- DAG nodes run D before C. Validation/parse/dispatch failures are orchestration defects that do not consume a node or CRAFT phase attempt.
- Timeout or model failure retries only the same role through host-configured fallbacks. Conductors do not select a model id.
- Metrics inference: an entered D phase marks v5. v4 fingerprints still apply when D is absent.

### Docs

- Root README, `tooling/README.md`, and skill cross-references agree on version 5, the D contract, and the new CLIs.
