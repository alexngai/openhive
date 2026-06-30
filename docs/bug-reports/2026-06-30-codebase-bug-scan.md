# 2026-06-30 Codebase Bug Scan

Scope: newer experiment control-plane changes and MAP resource registration.
Method: systematic scan of recent experiment/scheduler/UI surfaces, then focused
root-cause tracing on reproducible code paths. Docker Compose verification was
blocked in this cloud worker because `docker` is not installed.

## Confirmed bugs fixed

### 1. Duplicate experiment event retries could corrupt candidate projection

**Root cause:** `appendEvent()` was idempotent for the append-only
`experiment_events` row, but `ingestEvents()` projected the incoming retry body
even when `(run_id, seq)` already existed. A changed retry payload could create
or mutate a candidate without a matching event row.

**Steps to reproduce before fix:**
1. Create an experiment and run.
2. POST `{ seq: 0, type: "cycle_start" }` to
   `/api/v1/experiments/:id/runs/:runId/events`.
3. Retry the same `seq` with
   `{ seq: 0, type: "promotion_keep", candidateId: "ghost" }`.
4. GET `/api/v1/experiments/:id/candidates`.
5. Actual before fix: candidate `ghost` appears even though the event log only
   contains the original `cycle_start`.

**Fix:** `appendEventWithResult()` reports whether the row was freshly inserted;
`ingestEvents()` only projects fresh inserts.

### 2. Empty experiment event tails caused pollers to skip `seq=0`

**Root cause:** `maxSeqForRun()` returned `0` when a run had no events, but
workers start event sequence numbers at `0`. A client that stored empty
`max_seq=0` and later polled with `after_seq=0` missed the first event.

**Steps to reproduce before fix:**
1. Create an experiment and run.
2. GET `/api/v1/experiments/:id/runs/:runId/events`; observe empty `data` and
   `max_seq: 0`.
3. POST the first event `{ seq: 0, type: "cycle_start" }`.
4. Poll `/events?after_seq=0`.
5. Actual before fix: empty response; `seq=0` is skipped.

**Fix:** empty event tails now report `max_seq: -1`, and the query parser accepts
`after_seq=-1`.

### 3. OpenTeams MAP resource handlers shadowed OpenHive resource kinds

**Root cause:** `buildAdditionalHandlers()` first registered OpenHive
`map/resources/list|get`, then overwrote those same methods with the OpenTeams
composed handlers. The stale comment in `openteams/map-handlers.ts` assumed
OpenHive had no native resource handlers. Calls for `x-workspace/repo` and other
OpenHive resource kinds could hit OpenTeams and fail as unknown types.

**Steps to reproduce before fix:**
1. Seed or register an OpenHive repo resource.
2. Build the MAP `additionalHandlers` map.
3. Call `handlers["map/resources/list"]({ type: "x-workspace/repo" }, ctx)`.
4. Actual before fix: OpenTeams handler rejects the type instead of listing repos.

**Fix:** the shared `map/resources/list|get` methods now route by `params.type`:
OpenTeams types go to OpenTeams, all other types go to the native OpenHive
resource dispatcher.

## Verification

Added regression coverage:

```bash
docker compose run --rm openhive npm run test:server -- src/__tests__/experiments/dal.test.ts --reporter verbose
docker compose run --rm openhive npm run test:server -- src/__tests__/experiments/routes.test.ts --reporter verbose
docker compose run --rm openhive npm run test:server -- src/__tests__/map/resource-handler.test.ts --reporter verbose
```

Blocked locally:

```text
docker --version && docker compose version
--: line 1: docker: command not found
```

## Follow-up candidates from the scan

- Experiment schedule `skipIfRunning` appears dispatch-only and may not see
  unfinished `experiment_runs`.
- Scheduled experiment fire history is likely invisible on schedule detail
  because schedule history currently reads dispatch rows only.
- Manual run creation/launch still appears allowed for paused or archived
  experiments, while scheduled launches skip inactive experiments.
- PostgreSQL remains documented/config-accepted but startup still routes through
  SQLite-only `initDatabase()`.
