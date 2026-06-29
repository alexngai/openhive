# 2026-06-29 Codebase Bug Scan

Branch: `cursor/codebase-bug-investigation-1099`

Scope: recent autonomation experiment control-plane changes, with focus on the
experiment scheduler/web surfaces and event ingest projection.

## Verification status

Docker Compose is the repo's prescribed local runtime, but this runner does not
have Docker installed:

```bash
docker compose run --rm openhive npm run test:web -- --reporter=verbose src/web/__tests__/pages/Schedules.test.tsx
# docker: command not found

docker compose run --rm openhive npm run test:server -- --reporter=verbose src/__tests__/experiments/routes.test.ts src/__tests__/experiments/dal.test.ts
# docker: command not found
```

The fixes below include targeted regression tests that should be run with the
commands above in a Docker-enabled environment.

## Fixed in this branch

### 1. Experiment schedules crash the schedules UI

- **Status:** Fixed
- **Files:** `src/web/hooks/useSchedules.ts`, `src/web/pages/Schedules.tsx`,
  `src/web/pages/ScheduleDetail.tsx`,
  `src/web/__tests__/pages/Schedules.test.tsx`
- **Root cause:** Backend and scheduler payload schemas support
  `{ kind: "experiment", experiment_ref }`, but the web schedule payload union
  only modeled dispatch payloads. List/detail rendering treated every
  non-`dispatch_prompt` payload as `dispatch_spec` and dereferenced
  `spec_ref` / `target_swarm_ids`.

#### Steps to reproduce

1. Create or seed a schedule with:
   ```json
   {
     "cron": "0 * * * *",
     "payload": {
       "kind": "experiment",
       "experiment_ref": "exp_123"
     }
   }
   ```
2. Open `/schedules`.
3. Before the fix, the list attempted `payload.spec_ref.spec_id` and crashed.
4. Directly open `/schedules/<schedule_id>`.
5. Before the fix, the detail page attempted `payload.target_swarm_ids.length`
   and crashed.

### 2. Duplicate experiment event retries can corrupt candidate projection

- **Status:** Fixed
- **Files:** `src/db/dal/experiments.ts`, `src/experiments/ingest.ts`,
  `src/__tests__/experiments/routes.test.ts`,
  `src/__tests__/experiments/dal.test.ts`, `src/experiments/CLAUDE.md`
- **Root cause:** `appendEvent` was idempotent for the append-only
  `experiment_events` table, but `ingestEvents` projected every retried request
  body even when `(run_id, seq)` already existed. A conflicting retry could leave
  the stored event as `promotion_keep` while changing the candidate row to
  `discard`.

#### Steps to reproduce

1. Create an experiment and run.
2. POST worker events:
   ```json
   {
     "events": [
       { "seq": 1, "type": "candidate_admitted", "candidateId": "c1" },
       { "seq": 2, "type": "promotion_keep", "candidateId": "c1" }
     ]
   }
   ```
3. Confirm `/experiments/<id>/candidates` shows `c1` as `status: "keep"` and
   `promoted: true`.
4. Retry the same sequence number with a conflicting body:
   ```json
   {
     "events": [
       {
         "seq": 2,
         "type": "promotion_discard",
         "candidateId": "c1",
         "reason": "late duplicate"
       }
     ]
   }
   ```
5. Before the fix, the event tail still contained the original
   `promotion_keep`, but the candidate projection changed to discard. After the
   fix, duplicate seqs report `applied: 0` and skip projection.

## Remaining findings for follow-up

### 3. `skipIfRunning` ignores in-flight experiment runs

- **Files:** `src/db/dal/schedules.ts`, `src/scheduler/setup.ts`,
  `src/experiments/launcher.ts`
- **Root cause:** `hasUnfinishedDispatchForSchedule` only checks `dispatches`.
  Scheduled experiments create rows in `experiment_runs` with
  `initiator_id = "schedule:<id>"`, so overlap suppression misses them.

#### Steps to reproduce

1. Create an experiment schedule with `policy.skipIfRunning: true`.
2. Let one scheduled run remain `queued` or `running`.
3. Fire the schedule again before the first run reaches a terminal state.
4. Observe a second `experiment_runs` row with the same schedule initiator.

### 4. Schedule detail history omits experiment fires

- **Files:** `src/api/routes/schedules.ts`,
  `src/scheduler/fire-handler.ts`, `src/experiments/launcher.ts`
- **Root cause:** Schedule detail history reads only `dispatches` linked by
  `initiator_id = "schedule:<id>"`. Experiment fires create
  `experiment_runs`, not dispatches.

#### Steps to reproduce

1. Create an experiment schedule and trigger a fire.
2. Confirm an `experiment_runs` row exists with `initiator_type: "schedule"`.
3. GET `/api/v1/schedules/<id>`.
4. Observe `fires: []` / `fire_total: 0`.

### 5. Non-admin users can schedule OS-process experiment launches

- **Files:** `src/api/routes/schedules.ts`, `src/scheduler/fire-handler.ts`,
  `src/experiments/launcher.ts`, `src/api/routes/experiments.ts`
- **Root cause:** Manual experiment launch/cancel routes are admin-only because
  they spawn/kill local processes. Schedule creation uses normal auth, and the
  scheduler later calls `runScheduledExperiment` without rechecking admin
  authority.

#### Steps to reproduce

1. Authenticate as a non-admin agent.
2. POST `/api/v1/schedules` with
   `{ "payload": { "kind": "experiment", "experiment_ref": "<exp_id>" } }`.
3. Let the schedule fire.
4. Observe a runner process launch without an admin-authenticated launch call.

### 6. Telemetry-only experiment events do not live-update the UI tail

- **Files:** `src/experiments/ingest.ts`,
  `src/web/hooks/useExperimentsRealtime.ts`
- **Root cause:** Ingest broadcasts lifecycle events only when candidate
  projection changes. Pure telemetry events such as `cycle_start` are stored, but
  no event invalidates `experiment-run-events` until a candidate event or run
  finish.

#### Steps to reproduce

1. Open `/experiments/<id>/runs/<run_id>`.
2. POST a worker event like `{ "seq": 3, "type": "cycle_start" }`.
3. Confirm the API event tail includes the row.
4. Observe the UI tail remains stale until a candidate event, finish event, or
   manual refresh.

### 7. Decrease-objective run metrics treat higher scores as better

- **Files:** `src/web/pages/ExperimentRunDetail.tsx`,
  `src/web/components/experiments/ObjectiveCurve.tsx`
- **Root cause:** Run metric summaries use `Math.max` and overfit gap
  `train - heldOut`, ignoring `objective_direction: "decrease"`.

#### Steps to reproduce

1. Create an experiment with `objective_direction: "decrease"`.
2. Finalize a run with candidates whose best score is the minimum value.
3. Open the run detail page.
4. Observe the summary cards report the maximum value as "best", and the overfit
   callout can be inverted.
