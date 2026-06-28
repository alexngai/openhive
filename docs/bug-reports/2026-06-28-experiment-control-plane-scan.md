# Bug report: experiment control-plane regressions (2026-06-28)

Scope: newer autonomation experiment work across `src/experiments`,
`src/api/routes/experiments.ts`, `src/scheduler`, and experiment UI pages.

Verification note: local Docker Compose verification was attempted but this cloud
image has no Docker binary:

```bash
docker --version && docker compose version
# docker: command not found
```

Per the repo testing rule, no direct `npm`/Vitest commands were run outside
Docker Compose. The findings below are code-backed and include targeted
reproduction steps/tests to run once Docker is available.

## 1. Duplicate event retries can corrupt candidate projection

**Severity:** high

**Root cause**

`dal.appendEvent()` is idempotent on `(run_id, seq)` and returns the existing row
for duplicates (`src/db/dal/experiments.ts:793-798`), but
`ingestEvents()` always treats the submitted payload as newly applied
(`src/experiments/ingest.ts:47-100`). On a duplicate sequence number, it still:

- increments `applied`;
- upserts candidate status from the retry payload;
- updates incumbent for promoting events;
- broadcasts `experiment.candidate`.

That means the append-only event log can preserve the original event while the
projection mutates from a conflicting duplicate payload.

**Steps to reproduce**

1. Create an experiment and a run:
   - `POST /api/v1/experiments`
   - `POST /api/v1/experiments/:id/runs`
2. POST worker events with the returned token:
   ```json
   { "events": [{ "seq": 2, "type": "promotion_keep", "candidateId": "c1" }] }
   ```
3. Retry the same `seq` with conflicting data:
   ```json
   { "events": [{ "seq": 2, "type": "promotion_discard", "candidateId": "c1" }] }
   ```
4. Fetch:
   - `GET /api/v1/experiments/:id/runs/:runId/events`
   - `GET /api/v1/experiments/:id/candidates`

**Expected**

The duplicate event is a no-op for both event storage and projection. Candidate
`c1` remains `keep`/promoted and no extra projection broadcast occurs.

**Actual**

The event table still has one row for `seq=2`, but the candidate projection is
re-run from the duplicate request body and can change to `discard`.

**Suggested targeted test**

Add a case to `src/__tests__/experiments/routes.test.ts` near the existing
idempotency test that reposts the same `seq` with a different event type and
asserts the candidate row remains unchanged.

## 2. Terminal experiment runs can be revived or overwritten

**Severity:** high

**Root cause**

Worker `PATCH /experiments/:id/runs/:runId` blocks setting a terminal status in
the request body, but it does not reject writes when the current run is already
terminal (`src/api/routes/experiments.ts:369-395`). By contrast, events and
finalize routes explicitly reject terminal runs
(`src/api/routes/experiments.ts:406-409`, `426-429`).

The cancel route also unconditionally writes `status='cancelled'` with no
terminal-state guard (`src/api/routes/experiments.ts:306-328`).

**Steps to reproduce: PATCH revival**

1. Create an experiment/run.
2. Finalize the run:
   ```json
   POST /api/v1/experiments/:id/runs/:runId/finalize
   { "content_hash": "sha256:done" }
   ```
3. With the admin key, patch the finalized run:
   ```json
   PATCH /api/v1/experiments/:id/runs/:runId
   { "status": "running" }
   ```

**Expected**

`409 Conflict`; terminal runs are immutable except for explicitly supported
metadata backfills.

**Actual**

`200 OK`; run status becomes `running` while stale terminal fields such as
`finished_at` remain.

**Steps to reproduce: cancel overwrite**

1. Finalize a run as `complete`.
2. POST `/api/v1/experiments/:id/runs/:runId/cancel` with admin auth.

**Expected**

`409 Conflict`; a complete/failed/cancelled run should not be overwritten.

**Actual**

`200 OK`; the completed run is rewritten to `cancelled`.

**Related token leak**

The async spawn-error path marks a run failed but does not clear
`worker_token_hash` (`src/experiments/launcher.ts:147-156`). Combined with the
PATCH revival bug, a launch-minted worker token can revive a failed run after a
spawn error.

## 3. Experiment schedules ignore `skipIfRunning`

**Severity:** high

**Root cause**

The scheduler's `skipIfRunning` probe only checks unfinished dispatch rows:
`hasUnfinishedDispatchForSchedule()` queries `dispatches` by
`initiator_id='schedule:<id>'` (`src/db/dal/schedules.ts:315-326`) and is wired
unconditionally in `src/scheduler/setup.ts:79-82`.

Experiment schedules do not create dispatches. They create `experiment_runs`
with the same `initiator_id` convention (`src/experiments/launcher.ts:222-226`).
The probe therefore returns false while a scheduled experiment run is queued or
running.

**Steps to reproduce**

1. Create an active experiment with launchable config.
2. Create a schedule:
   ```json
   {
     "cron": "* * * * *",
     "policy": { "skipIfRunning": true },
     "payload": { "kind": "experiment", "experiment_ref": "<exp_id>" }
   }
   ```
3. Let the first fire create an `experiment_runs` row whose status is `queued` or
   `running`.
4. Let the next fire occur before the first run finishes.

**Expected**

The second fire is skipped/advanced because work for the schedule is already
running.

**Actual**

The probe sees no dispatch rows and the scheduler creates another experiment
run, allowing overlapping workers for the same schedule.

## 4. Non-admin schedules can spawn experiment worker processes

**Severity:** high

**Root cause**

Manual experiment launch is admin-only because it spawns an OS process
(`src/api/routes/experiments.ts:331-333`). Schedule creation uses
`authOrAdminKey` (`src/api/routes/schedules.ts:132-134`), and the experiment fire
path calls `launchRun()` directly (`src/scheduler/fire-handler.ts:95-110`,
`src/experiments/launcher.ts:227-228`) without an equivalent admin gate.

**Steps to reproduce**

1. Authenticate as a normal non-admin agent.
2. Create or reference an experiment.
3. Create a schedule with:
   ```json
   { "kind": "experiment", "experiment_ref": "<exp_id>" }
   ```
4. Wait for the schedule to fire.

**Expected**

Either schedule creation/update for `kind='experiment'` requires admin auth, or
fire-time execution refuses to spawn.

**Actual**

The scheduler can spawn `openhive experiment-worker` on the hub host via a
schedule created by a non-admin authenticated caller.

## 5. Missing, paused, archived, and draft experiment schedules fail silently

**Severity:** medium

**Root cause**

`runScheduledExperiment()` returns `null` when the experiment is missing, paused,
or archived (`src/experiments/launcher.ts:218-220`). The fire handler treats
`null` as a normal fired schedule and only broadcasts `run_id: null`
(`src/scheduler/fire-handler.ts:95-110`). It does not auto-pause the schedule,
unlike the `dispatch_spec` branch for a missing spec
(`src/scheduler/fire-handler.ts:126-135`).

The status gate also allows default `draft` experiments to launch even though the
docstring says missing or "not active" experiments are skipped
(`src/experiments/launcher.ts:207-220`).

**Steps to reproduce**

1. Create a schedule with `payload.kind='experiment'` and
   `experiment_ref='exp_missing'`, or point it at a paused/archived experiment.
2. Let it fire.
3. Fetch the schedule.

**Expected**

The schedule is paused with a clear reason, or invalid references are rejected at
create/update time.

**Actual**

The schedule remains active, `last_fires_at` advances, and no run is created.

Draft variant:

1. Create an experiment without a `status`; it defaults to `draft`.
2. Create an experiment schedule pointing to it.
3. Let it fire.

Expected: skip until `active`. Actual: run is created/launched.

## 6. Experiment schedule fire history omits experiment runs

**Severity:** medium

**Root cause**

`GET /api/v1/schedules/:id` builds `fires` from dispatch rows only
(`src/api/routes/schedules.ts:206-211`). Experiment schedule fires are stored as
`experiment_runs` and are never included.

**Steps to reproduce**

1. Create an experiment schedule and let it fire successfully.
2. Fetch `GET /api/v1/schedules/:id`.

**Expected**

The response includes recent experiment run fire records, or exposes a separate
run-fire list/count.

**Actual**

`fires: []` and `fire_total: 0` even though `experiment_runs` contains rows with
`initiator_id='schedule:<id>'`.

## 7. Decrease objectives show the worst score as "best" in run detail

**Severity:** medium

**Root cause**

`ExperimentRunDetail.bestScores()` always uses `Math.max` for train and held-out
scores (`src/web/pages/ExperimentRunDetail.tsx:242-254`). It does not consider
the experiment's `objective_direction`.

The overfit gap also assumes "higher is better" by computing
`train - heldOut` and flagging only positive gaps
(`src/web/pages/ExperimentRunDetail.tsx:256-270`, `312-317`).

**Steps to reproduce**

1. Create an experiment with `objective_direction: "decrease"` (for example,
   loss or latency).
2. Finalize a run with candidate scores such as:
   - candidate A: `score_held_out = 0.80`
   - candidate B: `score_held_out = 0.20`
3. Open `/experiments/:id/runs/:runId`.

**Expected**

The held-out card reports `0.200` as the best score and overfit logic treats
`train < held-out` as the concerning generalization gap for a decrease metric.

**Actual**

The held-out card reports `0.800`, and overfit detection is inverted for
decrease metrics.

## 8. Live event tail stays stale for telemetry-only events

**Severity:** medium

**Root cause**

`ingestEvents()` only broadcasts `experiment.candidate` when an event maps to a
candidate projection (`src/experiments/ingest.ts:64-100`). Telemetry-only events
such as `experiment_start`, `cycle_start`, and `evaluation_*` are stored in
`experiment_events` but do not broadcast an event-tail invalidation.

The UI invalidates `experiment-run-events` on `experiment.candidate` and
`experiment.run_finished`, but not for telemetry-only appends
(`src/web/hooks/useExperimentsRealtime.ts:70-106`).

**Steps to reproduce**

1. Open `/experiments/:id/runs/:runId` for a running experiment.
2. Have the worker ingest several telemetry-only events:
   ```json
   { "events": [{ "seq": 0, "type": "cycle_start" }] }
   ```
3. Watch the "Live event tail".

**Expected**

The event tail updates as telemetry arrives.

**Actual**

The event tail remains stale until a candidate event or run finalization causes a
React Query invalidation.

