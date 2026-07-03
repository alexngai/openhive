# 2026-07-03 Codebase Bug Scan

Scope: newer changes around spec discussion threads, north-star thread UX,
mail/context delivery, scheduler/dispatch wiring, and the experiment control
plane. Docker was unavailable in this runner (`docker: command not found`), so
runtime/browser verification was blocked; findings below come from static trace
and targeted regression tests added in this branch.

## Fixed in this branch

### 1. Dispatch orchestrator dropped private spec context

- **Root cause:** `src/server.ts` wired the dispatch orchestrator to
  `fetchSpecForDispatch(resourceId, specId, "system")`. That helper enforces
  resource ACLs, but `"system"` is not an agent/subscriber, so private task
  graphs returned `403` and prompt enrichment silently degraded to the raw
  prompt override.
- **Fix:** Added `fetchSpecForDispatchInternal()` for hub-owned background work.
  It skips user ACL checks while preserving resource existence, type, and spec
  validation. User-facing routes still call the ACL-enforcing helper.
- **Regression coverage:** `src/__tests__/routes/specs.test.ts` now asserts a
  normal unauthorized route request gets `403` while the internal resolver can
  fetch the same private spec.
- **Reproduce before fix:**
  1. Create a private OpenTasks resource and spec.
  2. Dispatch the spec to a swarm.
  3. Inspect the claimed dispatch prompt: spec title/body/tasks are absent
     because enrichment returned `null`.

### 2. Spec discussion thread GET leaked private thread metadata

- **Root cause:** `GET /api/v1/specs/:resourceId/:specId/thread` checked only the
  deterministic mail conversation id and did not validate resource/spec access.
  `POST` on the same route already used `fetchSpecForDispatch()`.
- **Fix:** GET now performs the same resource/spec ACL check before returning
  thread metadata or `404`.
- **Regression coverage:** `src/__tests__/routes/specs.test.ts` creates a private
  thread as the owner and asserts a different authenticated agent gets `403`.
- **Reproduce before fix:**
  1. Agent A creates a private spec discussion.
  2. Agent B, without access to the resource, calls
     `GET /api/v1/specs/<resourceId>/<specId>/thread`.
  3. Response is `200` with participants/turn count instead of `403`.

### 3. Scheduled experiments launched from `draft`

- **Root cause:** `runScheduledExperiment()` skipped only `paused` and
  `archived`, while new experiments default to `draft`.
- **Fix:** scheduled experiment fires now launch only when
  `experiment.status === "active"`.
- **Regression coverage:** `src/__tests__/experiments/launcher.test.ts` now
  asserts draft schedules return `null` and create no run; the launch test marks
  its experiment active explicitly.
- **Reproduce before fix:**
  1. Create an experiment without setting `status` (`draft` by default).
  2. Create a schedule with payload `{ kind: "experiment", experiment_ref }`.
  3. On the next fire, a run is created and a worker is launched.

### 4. `skipIfRunning` did not apply to experiment schedules

- **Root cause:** scheduler `isFireRunning` checked only dispatch rows via
  `hasUnfinishedDispatchForSchedule()`. Experiment schedules create
  `experiment_runs`, not dispatches.
- **Fix:** `setupScheduler()` now checks payload kind and uses
  `hasUnfinishedExperimentRunForSchedule()` for experiment schedules, looking for
  schedule-owned `queued` or `running` runs.
- **Regression coverage:** `src/__tests__/scheduler/end-to-end.test.ts` seeds a
  running schedule-owned experiment run and asserts `runScheduledExperiment()` is
  not called when `policy.skipIfRunning` is enabled.
- **Reproduce before fix:**
  1. Create an active experiment schedule with `skipIfRunning: true`.
  2. Keep a prior schedule-owned run in `running`.
  3. Let the schedule fire again.
  4. A second run is created despite the policy.

## Additional confirmed/suspicious findings not fixed here

### A. ACP permission attention can stay keyed by `stream:<id>`

- **Evidence:** `useGlobalAttention()` falls back to `stream:<acpStreamId>` if
  `sessions-overview` is not cached when `acp.permission.request` arrives. Thread
  rows and session detail only check `session:<id>`/`hosted-chat:<id>`, and no
  later remap occurs when sessions load.
- **Reproduce:** Open a page that does not load sessions, trigger an ACP
  permission request, then open Threads. The sidebar badge increments, but the
  target thread/detail may not show the approval chip.

### B. Mail thread detail uses a scrollable shell on `/threads/mail/:id`

- **Evidence:** `MailThreadView` expects a full-height flex parent, but
  `Sessions.tsx` mounts it inside `<main className="flex-1 overflow-y-auto">`.
  Hosted chat uses an `overflow-hidden` flex shell.
- **Reproduce:** Open a long mail thread at `/threads/mail/<id>` and compare with
  hosted chat. The mail composer can scroll with the content instead of staying
  pinned.

### C. Spec discussion invite picker can use stale participant data

- **Evidence:** `SpecDiscussionPanel` passes `existingParticipantIds` from
  `useSpecThread()`, but participant joins invalidate `mail-conversation`, not
  `spec-thread`.
- **Reproduce:** Invite an agent to a spec discussion, reopen the invite picker
  without reloading, and observe the already-invited agent may still appear.

### D. Threads first-run panel lacks inline spawn/connect callbacks

- **Evidence:** Dashboard passes `onSpawn`/`onConnect` into `FirstRunPanel`; the
  Threads empty detail renders `<FirstRunPanel />`, causing cards to route to
  `/swarms` instead of opening the inline flows.
- **Reproduce:** On a fresh hub, open `/threads`, click "Spawn a hosted agent" or
  "Connect an existing agent", and compare with Dashboard behavior.

## Verification commands

Docker/Compose was blocked in this runner:

```bash
docker --version
# docker: command not found
```

Recommended targeted verification in a Docker-capable environment:

```bash
docker build -t openhive:test --target builder .
docker run --rm -w /app openhive:test npx vitest run \
  src/__tests__/routes/specs.test.ts \
  src/__tests__/experiments/launcher.test.ts \
  src/__tests__/scheduler/end-to-end.test.ts
```

If a Compose test service is added later, run the same Vitest targets through
that service.
