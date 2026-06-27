# Bug report: experiment scheduling regressions

Date: 2026-06-27

Scope: recent autonomation experiment control-plane changes, especially the
`kind: "experiment"` schedule payload and experiment management UI.

## Verification status

- Static root-cause scan completed against backend scheduler/API/DAL code and
  frontend schedule/experiment pages.
- Local Docker verification was blocked in this runner: `docker compose version`
  fails with `docker: command not found`.
- Intended local verification command, when Docker is available:
  `docker compose run --rm openhive npm run test:server -- --reporter=verbose`.
- Browser verification was not possible because the Docker Compose environment
  could not be started.

## Findings

### 1. Schedules UI crashes on experiment schedules

Severity: high

Root cause:

- The backend schema accepts experiment schedules via
  `OpenHiveSchedulePayloadSchema` (`src/api/schemas/schedules.ts:55-71`).
- The scheduler payload type also includes `ExperimentRunPayload`
  (`src/scheduler/payload-types.ts:90-109`).
- The frontend hook still models only `dispatch_spec | dispatch_prompt` and
  classifies every non-prompt payload as `dispatch_spec`
  (`src/web/hooks/useSchedules.ts:60-71`).
- The schedules list and detail then dereference spec/target fields that do not
  exist on experiment payloads:
  - `src/web/pages/Schedules.tsx:43-58`
  - `src/web/pages/Schedules.tsx:205-212`
  - `src/web/pages/ScheduleDetail.tsx:154-156`
  - `src/web/pages/ScheduleDetail.tsx:436-473`

Steps to reproduce:

1. Create an experiment schedule through the API:
   `POST /api/v1/schedules` with payload
   `{ "kind": "experiment", "experiment_ref": "<experiment_id>" }`.
2. Open `/schedules`.
3. The page attempts to read `payload.spec_ref.spec_id` and throws because
   `spec_ref` is undefined.
4. Open `/schedules/<schedule_id>`.
5. The detail page attempts to read `payload.target_swarm_ids.length` and
   throws because experiment payloads have no `target_swarm_ids`.

Expected:

- Experiment schedules render as experiment work items.

Actual:

- The schedules UI is dispatch-only and crashes on a backend-valid schedule.

### 2. `skipIfRunning` does not prevent overlapping experiment runs

Severity: high

Root cause:

- `setupScheduler` wires the scheduler `isFireRunning` probe to
  `hasUnfinishedDispatchForSchedule` (`src/scheduler/setup.ts:79-82`).
- That DAL helper only checks unfinished rows in `dispatches`
  (`src/db/dal/schedules.ts:315-325`).
- Experiment schedule fires do not create dispatch rows. They call
  `runScheduledExperiment`, which creates `experiment_runs` rows with
  `initiator_id = "schedule:<id>"` (`src/experiments/launcher.ts:222-228`).

Steps to reproduce:

1. Create an active experiment with launchable config.
2. Create a schedule whose payload is
   `{ "kind": "experiment", "experiment_ref": "<experiment_id>" }` and whose
   policy has `{ "skipIfRunning": true }`.
3. Let the first schedule fire create a long-running experiment run.
4. Wait for the next cron fire.
5. A second experiment run is created because the running check only sees
   dispatch rows.

Expected:

- `skipIfRunning` should skip a fire while the previous run from the same
  schedule is queued or running.

Actual:

- Experiment schedules can overlap indefinitely.

### 3. Missing experiment references do not auto-pause schedules

Severity: medium

Root cause:

- The dispatch-spec path pauses schedules when the referenced spec is missing
  (`src/scheduler/fire-handler.ts:126-135`).
- The experiment path calls `runScheduledExperiment`, broadcasts
  `schedule.fired`, and returns even when no run was created
  (`src/scheduler/fire-handler.ts:95-110`).
- `runScheduledExperiment` returns `null` when the experiment no longer exists
  (`src/experiments/launcher.ts:218-220`).

Steps to reproduce:

1. Create an experiment schedule.
2. Delete or otherwise remove the referenced experiment row.
3. Let the schedule fire.
4. Observe a `schedule.fired` event with `run_id: null`, but no
   `schedule.paused` event and no pause reason on the schedule.

Expected:

- The schedule should auto-pause with a clear reason, mirroring the missing-spec
  behavior.

Actual:

- The schedule keeps firing forever with no run and no operator-visible pause.

### 4. Paused, archived, and draft experiments can still be launched manually

Severity: high

Root cause:

- Scheduled runs skip only `paused` and `archived` experiments
  (`src/experiments/launcher.ts:218-220`), and currently treat `draft` as
  runnable.
- Manual run creation does not check experiment lifecycle before creating a run
  (`src/api/routes/experiments.ts:210-246`).
- Manual launch does not check experiment lifecycle before spawning the worker
  (`src/api/routes/experiments.ts:331-361`).
- The UI always enables the "Launch run" button regardless of experiment status
  (`src/web/pages/ExperimentDetail.tsx:193-202`).

Steps to reproduce:

1. Create an experiment.
2. Pause or archive it via `POST /api/v1/experiments/:id/pause` or
   `POST /api/v1/experiments/:id/archive`.
3. Call `POST /api/v1/experiments/:id/runs`.
4. The API returns `201` with a queued run.
5. As an admin, call
   `POST /api/v1/experiments/:id/runs/:run_id/launch`.
6. The launcher attempts to spawn a worker for the inactive experiment.

Expected:

- Inactive experiments should reject new manual runs and launches. Draft
  experiments should not be schedulable/launchable until explicitly activated.

Actual:

- Pause/archive status does not block manual run creation or launch, and draft
  experiments are eligible for scheduled runs.

### 5. Experiment schedules can spawn local processes through non-admin schedule paths

Severity: high

Root cause:

- The direct launch endpoint is admin-gated because it spawns/kills OS
  processes (`src/api/routes/experiments.ts:331-333`).
- Schedule creation only requires `authOrAdminKey`
  (`src/api/routes/schedules.ts:132-134`).
- When an experiment schedule fires, the scheduler calls `launchRun` directly
  through `runScheduledExperiment` (`src/scheduler/fire-handler.ts:95-104`,
  `src/experiments/launcher.ts:213-238`).
- In local auth mode, missing Authorization headers are auto-authenticated as
  the built-in local agent (`src/api/middleware/auth.ts:128-132`), and the
  default host binds to `0.0.0.0` (`src/config.ts:75-77`).

Steps to reproduce:

1. Start a hub in local auth mode.
2. As a non-admin authenticated caller, or as any network client that reaches a
   default local-auth hub, create an experiment schedule whose payload is
   `{ "kind": "experiment", "experiment_ref": "<experiment_id>" }`.
3. Wait for the schedule to fire.
4. Observe that the scheduler calls the experiment launcher even though direct
   `POST /experiments/:id/runs/:run_id/launch` would require admin auth.

Expected:

- Any path that can spawn a local worker process should enforce the same admin
  boundary or otherwise require an explicit operator capability.

Actual:

- The scheduled path reaches process spawn through schedule permissions instead
  of the admin launch gate.

### 6. REST schedule mutations are missing ownership checks

Severity: medium

Root cause:

- The MAP schedule handler checks ownership before update/delete
  (`src/map/schedule-handler.ts:241-246`, `src/map/schedule-handler.ts:299-304`).
- REST schedule update/delete/pause/resume routes only require
  `authOrAdminKey` and do not compare the caller with
  `schedule.initiator_id` (`src/api/routes/schedules.ts:218-270`,
  `src/api/routes/schedules.ts:276-345`).

Steps to reproduce:

1. Agent A creates a schedule through REST.
2. Agent B calls `PATCH /api/v1/schedules/:id`, `DELETE /api/v1/schedules/:id`,
   `POST /api/v1/schedules/:id/pause`, or
   `POST /api/v1/schedules/:id/resume`.
3. The mutation succeeds despite Agent B not owning the schedule.

Expected:

- REST schedule mutations should match MAP ownership semantics, or admin callers
  should be the only cross-owner exception.

Actual:

- Any authenticated REST caller can mutate another caller's schedules.

### 7. Experiment run scoring UI ignores decrease objectives

Severity: medium

Root cause:

- The run detail page computes "best" train/held-out scores with `Math.max`
  for every experiment (`src/web/pages/ExperimentRunDetail.tsx:241-253`).
- The overfit gap is always `train - heldOut`
  (`src/web/pages/ExperimentRunDetail.tsx:256-269`,
  `src/web/pages/ExperimentRunDetail.tsx:312-319`).
- For `objective_direction: "decrease"`, lower scores are better, so both the
  best-score selection and gap interpretation are inverted.

Steps to reproduce:

1. Create an experiment whose objective direction is `decrease` (for example,
   latency or error rate).
2. Add candidates with lower train/held-out scores over time.
3. Open `/experiments/:id/runs/:run_id`.
4. The metric cards show the maximum values as "best" and can display an
   overfit warning based on the wrong sign.

Expected:

- Decrease objectives should select minimum scores and interpret generalization
  gaps according to the objective direction.

Actual:

- The UI treats all objectives as increase objectives.

## Suggested fix order

1. Add an `experiment` payload variant to the frontend schedule types and render
   schedule list/detail rows without dispatch-only field assumptions.
2. Teach scheduler `skipIfRunning` to check non-terminal `experiment_runs` for
   `initiator_id = "schedule:<id>"`.
3. Apply consistent lifecycle gating: only active experiments should launch, and
   missing experiment refs should auto-pause their schedules.
4. Align process-spawn authorization between manual launch and scheduled
   experiment fires.
5. Add REST ownership checks for schedule mutations, matching MAP behavior.
6. Pass objective direction into run-detail metric calculations.

