# 2026-07-02 Codebase bug scan

Scope: newer experiment Stage A, schedules, dispatch realtime, ACP chat, and API authorization surfaces. Docker Compose/browser verification was blocked in this runner because `docker` is not installed.

## Fixed in this pass

### 1. Experiment schedules crashed the schedules list

- **Root cause:** The backend schedule schema supports `payload.kind === "experiment"`, but the web `OpenHiveSchedulePayload` union and `getPayloadKind()` only recognized dispatch payloads. `Schedules.tsx` then treated experiment payloads as dispatch specs and read `payload.spec_ref.spec_id`.
- **Steps to reproduce before fix:**
  1. Create a schedule through the API/MAP with payload `{ "kind": "experiment", "experiment_ref": "exp_..." }`.
  2. Open `/schedules`.
  3. The page throws while filtering/rendering because `spec_ref` is undefined.
- **Regression test:** `src/web/__tests__/pages/Schedules.test.tsx`.

### 2. Experiment schedule detail crashed on direct load

- **Root cause:** `ScheduleDetail.tsx` assumed every schedule payload has `target_swarm_ids`; experiment schedules do not.
- **Steps to reproduce before fix:**
  1. Create an experiment schedule.
  2. Open `/schedules/:id` for that schedule.
  3. The page throws reading `schedule.payload.target_swarm_ids.length`.
- **Regression test:** `src/web/__tests__/pages/ScheduleDetail.test.tsx`.

### 3. Schedule and dispatch detail pages missed websocket invalidations

- **Root cause:** `useWebSocket` emits the full envelope `{ type, channel?, data }`, but `useSchedulesRealtime` and `useDispatchRealtime` extracted ids from the top level. List queries refreshed unconditionally, while detail queries such as `["schedule", id]` and `["dispatch", id]` stayed stale.
- **Steps to reproduce before fix:**
  1. Open a schedule detail or dispatch detail page.
  2. Trigger a websocket lifecycle event from another tab/process, e.g. `schedule.updated`, `schedule.fired`, or `dispatch.status_changed`.
  3. The list query invalidates, but the open detail page does not refresh until manual reload.
- **Regression tests:** `src/web/__tests__/hooks/useSchedulesRealtime.test.ts`, `src/web/__tests__/hooks/useDispatchRealtime.test.ts`.

### 4. ACP permission requests inside `acp.session.update` were ignored

- **Root cause:** The ACP bridge forwards permission payloads as `acp.session.update` with `update.sessionUpdate === "permission_request"`. `openhive-acp-service.ts` only listened for standalone `acp.permission.request`, so chat could hang without rendering Allow/Deny controls.
- **Steps to reproduce before fix:**
  1. Start an ACP chat that triggers a tool approval request.
  2. Ensure the bridge emits `acp.session.update` containing `sessionUpdate: "permission_request"`.
  3. The frontend receives the event but never calls the permission callback, so `PermissionDialog` does not open.
- **Regression test:** `src/web/__tests__/adapters/openhive-acp-service.test.ts`.

## Still open / follow-up candidates

### A. Schedule fire history is dispatch-only for experiment schedules

- **Evidence:** `GET /schedules/:id` builds `fires` from `dispatches` by `initiator_id = schedule:<id>`. Experiment fires create `experiment_runs`, so experiment schedules show "No dispatches yet" forever.
- **Steps to reproduce:** Create and fire an experiment schedule, then open `/schedules/:id`; the corresponding run appears under the experiment but not in recent fires.

### B. Experiment scheduler `skipIfRunning` ignores active experiment runs

- **Evidence:** scheduler overlap checks query unfinished dispatches only. Experiment schedules produce `experiment_runs`, not dispatches.
- **Steps to reproduce:** Create an experiment schedule with `policy.skipIfRunning = true`, leave one scheduled run `running`, then trigger another fire; the second run is still launched.

### C. Experiment manual run/launch ignores paused or archived experiment status

- **Evidence:** scheduled launch path skips paused/archived experiments, but `POST /experiments/:id/runs` and `POST /experiments/:id/runs/:runId/launch` do not apply the same lifecycle guard.
- **Steps to reproduce:** Pause an experiment, then create or launch a run through the REST operator route.

### D. Resource content mutations allow read-only/public access

- **Evidence:** content/skill mutation helpers gate on `canAccessResource`, which returns true for read subscribers and public resources. Write/admin helpers exist but are not used by these mutation routes.
- **Steps to reproduce:** Grant an agent read access to a task/skill resource, then call a content mutation route such as OpenTasks task create; the mutation succeeds.

### E. Hosted swarm terminal info leaks cross-user metadata

- **Evidence:** `GET /map/hosted/:id` and `/map/hosted/:id/terminal-info` require authentication but do not check `spawned_by`, unlike stop/restart/delete paths.
- **Steps to reproduce:** Spawn a hosted swarm as agent A, then fetch terminal info as agent B with the hosted swarm id; filesystem cwd/session metadata is returned.

### F. Operator APIs need row-level authorization review

- **Evidence:** schedules, experiments operator routes, cascade stream actions/PR routes, and event subscription CRUD commonly use authenticated-or-admin gates without owner/initiator checks.
- **Steps to reproduce:** Create a schedule/experiment/cascade stream as agent A, then mutate it as a different authenticated agent B.

