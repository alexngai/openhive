# 2026-07-01 Codebase Bug Scan

Scope: recent autonomation experiment control-plane, launcher, scheduler, and UI changes.

Verification note: this runner does not have Docker installed (`docker: command not found`), so Docker Compose execution and browser verification were blocked here. The regression tests added in this branch should be run with:

```bash
docker compose run --rm openhive npm run test:server -- --run src/__tests__/experiments/dal.test.ts --reporter=verbose
docker compose run --rm openhive npm run test:server -- --run src/__tests__/experiments/routes.test.ts --reporter=verbose
docker compose run --rm openhive npm run test:server -- --run src/__tests__/experiments/launcher.test.ts --reporter=verbose
```

## Fixed in this branch

### 1. Duplicate experiment event retries could corrupt candidate projection

- Root cause: `appendEvent()` was idempotent on `(run_id, seq)`, but `ingestEvents()` projected the incoming retry body even when the append returned an existing event row.
- Impact: a retried request with the same `seq` but a different candidate/type could create candidates and advance `incumbent_candidate_id` without a matching append-only event.
- Reproduce:
  1. Create an experiment and run.
  2. POST events with `{ seq: 2, type: "promotion_keep", candidateId: "c1" }`.
  3. Retry with `{ seq: 2, type: "promotion_keep", candidateId: "c2" }`.
  4. Before the fix, `c2` could appear in candidates even though the event tail still contained only the first seq=2 row.
- Fix: `appendEventWithResult()` returns `{ event, inserted }`; ingest skips projection when `inserted=false`. Empty event tails now report `max_seq=-1` because worker seq starts at 0.
- Coverage: `src/__tests__/experiments/dal.test.ts`, `src/__tests__/experiments/routes.test.ts`.

### 2. Finalization could lose parent lineage edges when child rows arrived first

- Root cause: `finalizeRun()` resolved `parent_candidate_ref` in the same pass that upserted candidates, so a child listed before its parent resolved to `null`.
- Impact: candidate lineage graphs could permanently miss edges depending on worker snapshot ordering.
- Reproduce:
  1. Finalize a run with candidates ordered as `child(parent_candidate_ref="base")`, then `base`.
  2. Before the fix, `child.parent_candidate_id` was `null`.
- Fix: finalization now upserts all candidate rows first, then resolves parent links in a second pass.
- Coverage: `src/__tests__/experiments/routes.test.ts`.

### 3. Paused/archived experiments could still be manually run

- Root cause: scheduled runs skipped stopped experiments, but `POST /experiments/:id/runs` and `POST /experiments/:id/runs/:runId/launch` only checked that the experiment existed.
- Impact: the persisted experiment lifecycle did not act as a durable kill switch for UI/API launches.
- Reproduce:
  1. Create an experiment.
  2. Pause or archive it.
  3. POST `/api/v1/experiments/:id/runs`, then launch the run.
  4. Before the fix, the manual path accepted the run.
- Fix: run creation and launch return 409 for `paused` and `archived` experiments before creating/claiming work.
- Coverage: `src/__tests__/experiments/routes.test.ts`, `src/__tests__/experiments/launcher.test.ts`.

### 4. Spawn-error failed runs kept write credentials and could be reopened

- Root cause: launch spawn-error paths marked runs `failed` without clearing `worker_token_hash`, and worker PATCH rejected requested terminal statuses but not updates to runs already in a terminal state.
- Impact: a failed terminal run could be patched back to `running` if a valid token or admin override was used.
- Reproduce:
  1. Launch a run with an injected child process.
  2. Fire the child's `error` handler.
  3. PATCH the run with `{ status: "running" }`.
  4. Before the fix, the failed run could be reopened.
- Fix: launcher failure paths clear the worker token, launch-route failures revoke stale tokens, and worker PATCH now returns 409 for already-terminal runs.
- Coverage: `src/__tests__/experiments/launcher.test.ts`.

## Follow-up findings not fixed here

### A. Experiment schedules ignore `skipIfRunning`

- Evidence: scheduler `isFireRunning` checks unfinished dispatch rows, while experiment schedules create `experiment_runs` and intentionally create no dispatches.
- Reproduce:
  1. Create an experiment schedule with `policy.skipIfRunning=true`.
  2. Let it create a long-running run with `initiator_id="schedule:<scheduleId>"`.
  3. Make the schedule due again.
  4. Expected: second fire skipped. Current likely result: another run starts.

### B. Experiment schedule history is dispatch-only

- Evidence: schedule detail/history reads recent dispatches by `initiator_id="schedule:<id>"`; experiment fires are persisted as `experiment_runs`.
- Reproduce:
  1. Fire an experiment schedule.
  2. Open `GET /api/v1/schedules/:id` or the schedule detail UI.
  3. Expected: recent experiment run appears in fire history. Current likely result: history is empty.

### C. Run detail metrics ignore `objective_direction="decrease"`

- Evidence: `ExperimentRunDetail.bestScores()` always uses `Math.max` and computes gap as `train - heldOut`.
- Reproduce:
  1. Create a decrease-objective experiment.
  2. Finalize candidates with lower-is-better scores, for example `0.10/0.20` and `0.50/0.60`.
  3. Expected: best cards select the lower scores and overfit logic follows the objective direction. Current likely result: UI reports the higher scores as best.

### D. Live event tail can show stale or non-live data

- Evidence: the run event hook requests `limit=500` without `after_seq`, while the DAL returns ascending from the beginning; non-candidate telemetry events do not broadcast invalidations.
- Reproduce:
  1. Insert more than 500 events for one run.
  2. Open the run detail page.
  3. Expected: latest tail is visible and telemetry-only events refresh live. Current likely result: the UI shows the oldest 500 events and may not refresh until candidate/run-finished events.
