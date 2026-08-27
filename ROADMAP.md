# Roadmap

Explored but not built. Each entry records the reasoning and the open questions so the
decision can be resumed without re-deriving it.

---

## Tier by task value

**Status:** explored, not started · **Size:** comparable to the counsel collapse

Run the full `C → counsel → R → A → F → T → S` path on a two-file change and you pay
enterprise process for a typo fix. Scale the workflow to what the task is worth.

### What the numbers say

Per-invocation cost and wall time, from `craft-metrics` (sample: runs with usage recorded,
Aug 2026):

| phase | n | $/invoke | min/invoke | total $ |
| --- | --- | --- | --- | --- |
| A | 30 | $0.136 | 7.3 | $4.08 |
| counsel | 21 | $0.102 | 12.0 | $2.13 |
| C | 39 | $0.086 | 7.3 | $3.35 |
| R | 32 | $0.075 | 11.8 | $2.39 |
| T | 11 | $0.029 | 2.3 | $0.32 |
| S | 29 | $0.010 | 2.1 | $0.29 |
| F | 16 | $0.001 | 5.0 | $0.02 |

`A + counsel + C + R` is **95% of spend and ~38 of ~40 minutes**. `T`, `S`, and `F`
together are 5%. Tiering the cheap phases saves nothing — the lever is C, counsel, and A.
Counsel is also the single slowest phase: twelve minutes to review a plan.

### The design problem

`mode` currently conflates two orthogonal axes:

- **protocol shape** — `hitl` (human seam), `dag` (supervisor session)
- **task value** — `lite` (cheap work)

`lite` is a tier wearing a mode costume. The conflation is why the workflow cannot be
evaluated against itself: you cannot ask "was counsel worth its twelve minutes?" while
"this run was HITL" and "this run was cheap" live in the same field.

Splitting the axes is the actual proposal. Tiering is the mechanism; the measurable
comparison is the point.

```
mode:  full | hitl | dag   ← shape
tier:  small | standard    ← value
```

`/craft-lite` becomes `--tier small`, and that skill file goes away.

### Levers a tier could control

| Lever | small | standard |
| --- | --- | --- |
| 1. phases | C→R→A | + counsel, T, S |
| 2. models | cheap except A | current pins |
| 3. verification | local | + clean-room at node exit |

Lever 1 is the large saver — skipping counsel alone is $0.10 and twelve minutes. Lever 2
is real but smaller. Lever 3 partly exists already.

Security-critical work is **not** a third tier. Its only distinct behavior was "run T even
when untriggered", which a `--force-tighten` flag gives without the extra schema, and the
trigger guard below already forces such work up to `standard`. Two tiers discriminate as
well as three and cost less to carry.

**Floor:** `small` is `C→R→A`. Below that it is ordinary coding; do not invoke craft.

### Who selects the tier

An agent that picks its own thoroughness drifts cheap. Selection must be asymmetric:
**escalation automatic, de-escalation explicit.**

- Non-empty `security_triggers` forbids `small` — enforced in the store, same class as the
  `mode=lite` counsel/T guard.
- `kind` seeds a default: `docs`/`chore` → small, `feature`/`bugfix` → standard.
- C proposes a tier from planned files, criterion count, and triggers; the user overrides.

### Open questions

1. **Migrate `lite` now or later?** `tier` can land alongside `mode` with `lite` kept as an
   alias, migrating when convenient — slower, but nothing breaks mid-flight.

Resolved: two tiers, not three (see above).

### Blast radius

`mode` appears in the metrics schema, the CLI, three skill files, and the `mode=lite`
counsel/T guard. Record `tier` on the run so `totals` can group by tier × kind — without
that, the change buys flexibility but not the evaluation it is meant to enable.

---

## Also open

- **Clarify gate** — a human-approved criteria checkpoint before code exists, following
  Spec Kit's Clarify phase. Aimed at raising first-pass acceptance of both criteria and
  code; the cheapest approval to get is the one before implementation.
- **Single-threaded for small work** — the DAG layer earns its overhead on genuinely
  parallel graphs. A three-node DAG probably pays supervisor cost for nothing. Needs the
  `supervisor` phase bucket to accumulate real data before deciding.
- **Mode re-fold** — `fold` resolves each usage event against `run.mode` as of that moment,
  so a `mode` event appended later relabels the run without moving its cost.
  `craft-metrics mode` therefore does not do what it appears to. A pre-scan for the run's
  final mode before folding usage would fix it, and would retroactively recover the
  supervisor spend currently sitting in `unattributed`.
