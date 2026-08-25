---
name: craft-lite
command: craft-lite
icon: Feather
description: >-
  CRAFTS adapter that skips Tighten. C→counsel→R→simplify→A→F→S.
  Use for prototypes and other work that does not need a T security gate.
---

# CRAFT Lite Adapter

Before execution, read the sibling [`../craft/SKILL.md`](../craft/SKILL.md) completely. This file defines only the entry condition and overrides; `/craft` owns every other phase, counsel, reporting, and escalation contract.

Use `/craft-lite` when Tighten is out of scope (prototype, spike, or the user says skip T). Use `/craft` when the full `C → R → A → F → T → S` path is required. Use `/craft-hitl` when Render must pause at a `TODO(human)` seam.

## Flow

`C → counsel → R → simplify → A → F → S`

There is no T. Do not spawn `craft-security-review`. Do not emit a T metrics phase.

### R — Render, then simplify

Follow `/craft` Render (red → green → refactor, tests green).

Then, before exiting R:

1. Spawn `code-simplifier` on the Render diff only (changed lines; new files in full). If that agent is unavailable, apply the same pass yourself: preserve behavior, stay inside the diff, match repo conventions.
2. Do not treat `/simplify` as available inside a subagent.
3. Re-run the focused tests. They must stay green. If simplify breaks them, revert or fix the simplify edits until green. Do not exit R red.
4. Simplify is part of R. Do not invent a metrics phase for it.

### A and F

Unchanged from `/craft`. A still reviews tests and implementation against the canonical criteria. F still fixes blockers only.

### S — Sharpen without T

Pass an empty T non-P0 list. S still records durable docs and process notes. Do not use S to backfill a security review.

## Metrics

Start with `--mode lite` and the same `--kind` rules as `/craft`. Skip T `enter`/`exit`. All other gates emit as in `/craft`.
