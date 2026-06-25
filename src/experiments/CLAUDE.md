# src/experiments — autonomation experiment control plane

OpenHive as the control plane for [autonomation](https://github.com/alexngai/autonomation)
harness-optimization loops: it **defines, schedules, hosts, persists, and
visualizes** experiments across a fleet, while the **optimization decision (gate,
claims, held-out split) stays inside autonomation**. The hub carries the work out
and manages its lifecycle; it never decides keep/discard.

**Design of record:** [`docs/design/autonomation-experiments.md`](../../docs/design/autonomation-experiments.md).
Read it before changing anything here — it carries the staged plan (A→B→C), the
verifiability rules, and the resolved decisions ([D1]–[D9]).

## Status

Stage A, first slice: the data model + DAL. Routes, the ingest projection, the
`OpenHiveExperimentTracker`, the hosted-swarm runner worker, the scheduler
payload, and the UI are subsequent slices (see the design doc §16).

## Files

The DAL lives at **`src/db/dal/experiments.ts`** (house rule: all database access
goes through `src/db/dal/`). Subsystem business logic — launcher, ingest
projection, tracker, worker, lifecycle — will live here in `src/experiments/` in
later slices. `src/db/dal/experiments.ts` provides CRUD + projection helpers for
the four tables, following the `src/db/dal/schedules.ts` conventions:
prefixed-nanoid ids (`exp_`/`exrun_`/`excand_`/`exev_`), ISO-8601 string
timestamps, JSON `TEXT` columns, all access via `getDatabase()`.

## Data model (migrations V60–V63)

| Table | Role | Notes |
|---|---|---|
| `experiments` | the optimization line | `content_hash` is the natural key when present (partial-unique); NULL = exploratory/fast-iteration. `name` is a free human label. Experiments are **independent** — the incremental lineage lives in the candidate graph, not an experiment-to-experiment edge. |
| `experiment_runs` | one loop invocation | Hosted as a **hosted swarm** (`hosted_swarm_id`), not a dispatch. `worker_token_hash` holds the launch-minted per-run auth token. `content_hash` / `claim_strength` arrive via the worker's finalization POST. |
| `experiment_candidates` | candidate-lineage projection | Maintained from events + the finalization snapshot — never operator-authored. `score_train`/`score_held_out` (the seesaw) come from the lineage snapshot, not the event stream. `dispatch_id` (B seam) / `cascade_stream_id` (C seam) stay NULL in A. |
| `experiment_events` | append-only live telemetry | Source of truth for the candidate projection. `(run_id, seq)` unique → at-least-once idempotent. |

## Invariants

- The hub never writes a keep/discard decision; candidate rows are a projection of
  the runner's reported `promotion_keep`/`promotion_discard` events.
- `experiment_events` is append-only; `appendEvent` is idempotent on `(run_id, seq)`.
- `content_hash` uniqueness is partial (`WHERE content_hash IS NOT NULL`), so any
  number of exploratory (null-hash) experiments coexist while a locked config maps
  to exactly one experiment (`upsertExperimentByContentHash`).
- `upsertCandidate` requires a `status` on insert but treats it as optional on
  update — so the finalization pass (scores only) never clobbers an event-projected
  terminal `keep`/`discard`.
- No SQL foreign keys (house convention — matches `dispatches`/`schedules`), hence
  no `ON DELETE` cascade: a future delete/lifecycle route must cascade
  runs/candidates/events in app code.
