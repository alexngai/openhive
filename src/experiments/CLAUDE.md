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

Stage A: the data model + DAL (slice 1), the API + ingest projection (slice 2),
the runner worker + tracker (slice 3), the process-host launcher + scheduler
`experiment` payload (slice 4), **both runner paths** — deployment
(content-hash-locked, verifiable) and lightweight **inline-config**
(fast-iteration) — and the **management UI** (slice 5: list → experiment hub →
run detail, monitoring + launch/cancel/pause/resume/archive, in `src/web/pages/Experiment*.tsx`)
are landed. **Stage A is complete.** The UI is read-mostly: it never exposes a
keep/discard control (promotion is recorded from autonomation), surfaces
verifiability honestly (locked vs exploratory, claim regime, the train/held-out
overfit signal), and degrades null content_hash / claim_strength / held-out to
"exploratory / not available".

## Files

- **`src/db/dal/experiments.ts`** — the DAL (house rule: all DB access via
  `src/db/dal/`). CRUD + projection helpers for the four tables; `schedules.ts`
  conventions (prefixed-nanoid ids `exp_`/`exrun_`/`excand_`/`exev_`, ISO-8601
  timestamps, JSON `TEXT`, all via `getDatabase()`).
- **`src/api/routes/experiments.ts`** + **`src/api/schemas/experiments.ts`** —
  operator routes + worker-write routes (PATCH run, POST events, POST finalize)
  behind a row-scoped per-run token; registered in `src/api/index.ts`.
- **`src/experiments/ingest.ts`** — the projection: live events → candidate rows
  + monotonic incumbent; the finalization handler (run lock/claim + score cards).
- **`src/realtime/experiment-events.ts`** — `broadcastExperimentLifecycleEvent`
  fans out to `map:experiments` + `experiment:<id>`.
- **`src/experiments/run-token.ts`** — the per-run worker token (`ohw_`, sha256,
  constant-time verify); minted on run create, cleared on finalize/cancel.
- **`src/experiments/worker/`** — the runner worker (autonomation-side process):
  - `openhive-tracker.ts` — `OpenHiveExperimentTracker implements ExperimentTracker`
    (autonomation interface imported **type-only**), POSTs the live event firehose.
  - `hub-client.ts` — the HTTP client (PATCH run / POST events / POST finalize);
    `fetchImpl` injectable for tests.
  - `run-experiment-worker.ts` — orchestration: **dynamically** imports
    `autonomation/experiment`, builds the runner via
    `createExperimentRunnerFromDeployment`, wires the tracker, runs the loop, and
    POSTs the finalization (content_hash from the plan lock, claim_strength + the
    train/held-out seesaw read from `runner.lineage`).
  - Driven by the `openhive experiment-worker` CLI subcommand (`src/cli.ts`).
- **`src/experiments/launcher.ts`** — the run launcher: a **dedicated process-host**
  (not the hosted-swarm manager — see the design-doc revision log). `launchRun`
  mints a fresh per-run token, persists its hash, and spawns the worker as a
  detached child (token-in-env, never argv), tracked in-memory for `cancel = kill`.
  `POST /experiments/:id/runs/:runId/{launch,cancel}` (**admin-only** — they spawn
  or kill OS processes; the operator authenticates with the admin key, an
  `is_admin` agent, or local-auth `trustLocalMode` — `npm run dev` sets
  `OPENHIVE_ADMIN_TRUST_LOCAL_MODE=1` so the dev UI can launch, and a self-host on
  `0.0.0.0` must opt in the same way or the UI's launch/cancel return 401) drive
  it; launch atomically claims the `queued` run
  (`claimRunForLaunch`) so concurrent launches can't double-spawn, and `cancel`
  falls back to the persisted `proc:<pid>` marker when the process isn't tracked
  (e.g. after a hub restart). The worker dials the hub's **actual bound port**
  (`setHubBaseUrl`, set post-`listen` — may differ from `config.port`). A spawn
  error finalizes the run `failed`. The scheduler `experiment` payload-kind drives
  the same launcher via `runScheduledExperiment` (recurring runs). Spawn is
  injectable (`setLauncherSpawnForTest`). `experiment.config` selects the path
  (XOR): `deployment.{deploymentPath,runPath}` → the deployment worker, or
  `inline` (an autonomation domain config) → the lightweight worker, passed to
  the child via the `OPENHIVE_EXPERIMENT_CONFIG` env var (not argv).

## Optional `autonomation` dependency

`autonomation` is an **optional peer dependency** (`peerDependenciesMeta.optional`)
— the hub never loads it. The tracker imports its **types only** (erased at build);
the worker loads the runtime via a **dynamic import** with a graceful
"install autonomation to manage experiments" error. It is `external` in
`tsup.config.ts` so the bundle never pulls it. For local dev, symlink it
(`node_modules/autonomation → ../autonomation/packages/ts-sdk`) so `tsc` resolves
the type-only imports.

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
- `experiment_events` is append-only; `appendEvent` is idempotent on `(run_id, seq)`
  and reports whether it inserted a new row. Projection code must skip duplicate
  seqs so retried event bodies cannot mutate candidate/incumbent state.
- `content_hash` uniqueness is partial (`WHERE content_hash IS NOT NULL`), so any
  number of exploratory (null-hash) experiments coexist while a locked config maps
  to exactly one experiment (`upsertExperimentByContentHash`).
- `upsertCandidate` requires a `status` on insert but treats it as optional on
  update — so the finalization pass (scores only) never clobbers an event-projected
  terminal `keep`/`discard`.
- No SQL foreign keys (house convention — matches `dispatches`/`schedules`), hence
  no `ON DELETE` cascade: a future delete/lifecycle route must cascade
  runs/candidates/events in app code.
- The worker PATCH route is non-terminal only; terminal transitions go through
  `finalize`/`cancel` (which set the terminal state **and** clear the per-run
  token). A setup failure in the worker still finalizes the run as `failed` so it
  is never left stuck `running`. The tracker flush is serialized and restores the
  un-sent batch on failure (no lost events / seq gaps).

## Known limitations (Stage A)

- **Two runner paths; lightweight trades away verifiability.** The deployment
  path (`createExperimentRunnerFromDeployment`) yields a real `content_hash` +
  claims gate + held-out scores. The lightweight path (autonomation's
  `autonomation/experiment-config` → `createExperimentRunnerFromConfigObject`,
  fed the experiment's inline domain config) is for fast iteration: it has **no
  deployment lock → `content_hash` is null**, no pre-registered claims gate
  (`claim_strength` null), and no `gateCard` → no held-out scores; lineage
  candidates need a `deploymentRun` substrate, so a pure inline run's candidates
  come from live events only. Use deployment for verifiable/comparable/promotable
  runs. The worker injects its own tracker as an observer on both paths (the
  config factory takes injected observers — monitoring is the hub's job).
- **Single-process per run; no resume.** The tracker assigns `seq` from 0 in the
  worker process. If a worker is restarted against the same run (a future resume
  feature), `seq` would collide with already-ingested rows on `uq_exev_seq` and the
  restart's early events would be dropped as idempotent dups. Resume must seed
  `seq` from the hub's `max_seq` — out of scope until the launcher slice wires
  restart/resume. A failed worker today finalizes the run `failed` (terminal), not
  resumes it.
