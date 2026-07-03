# src/scheduler — swarm-dispatch scheduler integration

OpenHive-specific glue for the `swarm-dispatch` scheduler module (cron-style recurring fires). Mirrors the shape of `src/dispatch/` — library ships kernel, host owns operator surface.

## File roles

- **`payload-types.ts`** — `OpenHiveSchedulePayload`, a `kind`-discriminated union: `dispatch_spec` (legacy, `kind` optional) · `dispatch_prompt` · `experiment` (`experiment_ref` + optional `run_controls`, **no** `spec`/`target_swarm_ids`). Plus `getPayloadKind` and the `isValidPayload` structural guard (discriminates `kind` *before* the `target_swarm_ids` check so the experiment kind validates). Library's `Schedule.payload` is `unknown`; we narrow here.
- **`fire-handler.ts`** — `createOpenHiveFireHandler(deps)`. The seam between scheduler and dispatches. On fire (after the `autonomousDispatchPaused` kill-switch check): the `experiment` kind branches first → `deps.runScheduledExperiment` (resolve an **active** experiment → create a `queued` run → launch the worker; see `src/experiments/launcher.ts`) → broadcast and return. Otherwise: validate payload → resolve spec (auto-pause on missing) → fan out to N `queued` dispatch rows (one per `target_swarm_id`) → broadcast `schedule.fired` on the `map:schedules` WS channel. Runner failures are swallowed (never throw) so the scheduler advances on cadence.
- **`setup.ts`** — `setupScheduler(opts)`. Composes the library `createScheduler` with the DAL-backed store, fire handler, and an `isFireRunning` probe. The probe checks dispatch rows for dispatch schedules and `experiment_runs` for `kind: "experiment"` schedules so `policy.skipIfRunning` prevents overlapping recurring experiments. Returns a `Scheduler` that `server.ts` starts/stops alongside the dispatch orchestrator.

## End-to-end flow

```
Scheduler tick (library, configurable cadence)
  └─→ store.listDue() ────────────→ DAL: SELECT FROM schedules WHERE due
        └─→ fire event ───────────→ fire-handler.ts
              └─→ fetchSpec ──────→ spec exists?
                    no → pauseSchedule(reason='spec not found') → done
                  ↓ yes
              └─→ for each target_swarm_id:
                    createDispatch({initiator_id: 'schedule:<id>', ...}) → dispatches table
              └─→ broadcastToChannel('map:schedules', schedule.fired)
        └─→ store.markFired() / store.advance() — library decides which
        ↓
Dispatch orchestrator (separate subsystem, polls every 15s by default)
  └─→ claims queued row → routes → terminal status
```

## Key design notes

- **Loose coupling.** The scheduler doesn't know dispatches exist; the fire handler is the only place that translates fires → dispatches. A different host could wire `fire` to a completely different execution path.
- **At-least-once correctness.** The fire handler does NOT throw on per-target failures — it logs and continues. If we threw, the scheduler would re-fire on the next tick, re-dispatching the successful targets too. Partial fan-out is preferred over retry-amplified work.
- **Kill switch.** `autonomousDispatchPaused` (in-memory in `server.ts`) is checked at the top of the handler. When paused, fires are no-ops, but the scheduler still advances `next_fires_at` — so pause→resume doesn't trigger a burst.
- **No fire correlation column yet.** v1 links dispatches to their schedule via `initiator_id = "schedule:<id>"`. A later PR may add a `fire_id` group key when the UI surfaces fire-grouped history.

## Configuration

`config.scheduler`:
- `tickIntervalMs` (60_000) — how often the tick loop runs
- `maxConcurrentFires` (10) — global cap on in-flight fire handlers
- `maxSchedulesPerAgent` (100) — per-agent cap, enforced by REST/MAP handlers, not the scheduler

## Tests

- `src/__tests__/scheduler/dal.test.ts` — DAL roundtrips against a real SQLite DB
- `src/__tests__/scheduler/fire-handler.test.ts` — fire handler unit tests (kill switch, deleted spec, fan-out)
- `src/__tests__/scheduler/end-to-end.test.ts` — PR 2 checkpoint: insert schedule via DAL, watch scheduler emit fire, observe `queued` dispatch row appear
