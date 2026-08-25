---
name: craft-lite
command: craft-lite
icon: Feather
description: >-
  CRAFTS adapter that skips Tighten. C→counsel→R→A→F→S.
  Use for prototypes and other work that does not need a T security gate.
---

# CRAFT Lite Adapter

Before execution, read the sibling [`../craft/SKILL.md`](../craft/SKILL.md) completely. This file defines only the entry condition and overrides; `/craft` owns every other phase, counsel, reporting, and escalation contract — including the R-exit `craft-code-simplifier` gate.

Use `/craft-lite` when Tighten is out of scope (prototype, spike, or the user says skip T). Use `/craft` when the full `C → R → A → F → T → S` path is required. Use `/craft-hitl` when Render must pause at a `TODO(human)` seam.

## Flow

`C → counsel → R → A → F → S`

There is no T. Do not spawn `craft-security-review`. Do not emit a T metrics phase.

Render, including the required simplify exit gate, is unchanged from `/craft`.

### S — Sharpen without T

Pass an empty T non-P0 list. S still records durable docs and process notes. Do not use S to backfill a security review.

## Metrics

Start with `--mode lite` and the same `--kind` rules as `/craft`. Skip T `enter`/`exit`. All other gates emit as in `/craft`.
