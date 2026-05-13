# git-cascade Integration Plan

Status: Draft
Scope: OpenHive hub + macro-agent + claude-code-swarm
Related: `docs/OPENTASKS_MAP_CONNECTOR.md`, `docs/MACRO_AGENT_ATLAS_EXTENSION.md`

## Goal

Integrate [git-cascade](../references/git-cascade/) as a cross-swarm change-aggregation primitive. Bind OpenTasks (work DAG) and git-cascade (change DAG) via `task_id ↔ stream_id` so closing a task yields a commit range + changelog artifact for free, and so conflicts across swarms are visible in one place.

OpenHive becomes cascade-aware (schema, config surface, cross-swarm aggregation) without becoming cascade-authoritative. Each runtime (macro-agent, cc-swarm) owns its local cascade state and continues to work standalone.

## Current state

- **macro-agent** — cascade deeply integrated. `src/workspace/dataplane-adapter.ts` wraps `MultiAgentRepoTracker`; `src/lifecycle/cascade.ts:139` `terminateWithChangeConsolidation()` merges child→parent streams on termination. Missing: emits no stream events to the hub.
- **cc-swarm** — no cascade integration. Runs Claude Code in user's cwd. PostToolUse hook infra exists (`hooks/hooks.json`); bridges task events at `src/map-events.mjs`.
- **OpenHive** — zero cascade awareness. Has SwarmKit config proxy pattern (`src/swarmkit/`), MAP handlers (`src/map/trajectory-handler.ts`, `src/map/task-handler.ts`), coordination relay (`src/coordination/listener.ts`), hub event bus (`mapHubEvents` in `src/map/service.ts`).
- **git-cascade** — library (`MultiAgentRepoTracker`). SQLite-backed. Fully cwd-agnostic (all git invocations pass explicit `cwd`; no `process.chdir()`). Does not currently expose external event hooks for conflicts/merges.

## Design anchors

### Layering (hold this line strictly)

| Hub (OpenHive) owns | Runtime (macro-agent, cc-swarm) owns |
|---|---|
| Cascade schema projections | `.git-cascade/tracker.db` (authoritative) |
| Config surface (via SwarmKit proxy) | Actual git operations |
| Cross-swarm aggregation | Worktree filesystem |
| REST/WS API for observability | Local conflict resolution |
| Policy knobs | Execution of those policies |

**Non-negotiable**: runtime must keep working when the hub is unreachable. Config is read-with-local-fallback from disk (SwarmKit proxy pattern), not a hub handshake. Event emission is fire-and-forget; never blocks on the hub.

### Event schema + emit hook live inside git-cascade

Three concerns in three places:

1. **git-cascade** exports canonical method names + payload types as a submodule (`git-cascade/events`) and accepts an optional `emit?: (method, params) => void` in the tracker constructor. When provided, cascade fires events from inside its own code paths — including the exact spot where a conflict record is written. When null/undefined, cascade behaves as today. **No MAP dependency in cascade's package.json.**
2. **Runtimes** (macro-agent, cc-swarm) inject an `emit` callback that forwards to their existing MAP connection. They don't wrap cascade to intercept events.
3. **OpenHive** imports method-name constants from `git-cascade/events` so hub handlers and runtime emission share one source of truth. No schema drift.

This resolves conflict observability (fires at creation time, not polled), shrinks macro-agent's wrapping layer, and makes cc-swarm integration nearly trivial (pass an emit callback).

**Tradeoff accepted**: git-cascade gains a concept of "event methods with MAP-shaped names," a mild leak of transport semantics into a pure library. Documented as "event hooks, MAP-compatible naming."

### Protocol naming

MAP vendor-extension convention: `x-cascade/stream.opened`, `x-cascade/stream.committed`, etc. The `x-<vendor>/` prefix signals "third-party extension, not core MAP" — appropriate because git-cascade is an external library. OpenHive's existing `trajectory/*` and `mail/*` predate this convention; they can be revisited separately if a cleanup pass is warranted.

**Prefix is configurable.** The tracker accepts `eventPrefix` (default `x-cascade`) so branded deployments or namespace-isolated environments can override. Only the prefix varies; suffixes (`stream.opened`, `stream.committed`, …) are fixed. Consumers narrowing by event type should use `matchCascadeSuffix(method)` rather than matching the full string so hub and runtime stay decoupled from prefix choice.

### Binding: `task_id ↔ stream_id`

Optional `task_ref: { resource_id, node_id }` on every event payload. The hub stitches tasks and streams via this reference. OpenTasks remains authoritative for tasks; cascade projections remain authoritative for code changes; the join is a hub-level query.

## Phases

### Phase 1 — Hub projection + macro-agent emission

**Goal**: minimum viable wire. Macro-agent emits stream events; hub stores projections and exposes them.

**Depends on**: a patched git-cascade with the `events` submodule + `emit` constructor option (see Phase 0 below).

#### Phase 0 — git-cascade patch (prerequisite)

- New submodule `src/events/index.ts` exporting `CASCADE_METHODS` (default-prefixed), `CASCADE_METHOD_SUFFIXES` (canonical suffixes), `DEFAULT_CASCADE_PREFIX`, `buildCascadeMethods(prefix)`, `matchCascadeSuffix(method)`, and payload types (`StreamOpenedParams`, `StreamCommittedParams`, `StreamMergedParams`, `StreamConflictedParams`, `StreamAbandonedParams`).
- `MultiAgentRepoTracker` accepts `emit?: (method: string, params: unknown) => void` and `eventPrefix?: string` (default `x-cascade`) in options.
- Cascade fires `emit(method, params)` from inside each operation: `createStream`, `commitChanges` (after change record written), `mergeStream`, `forkStream`, the conflict-recording path in `streams.ts`/`cascade.ts`, `abandonStream`, `completeTask`, `syncWithParent`, `rebaseOntoStream`.
- All emissions wrapped in try/catch — cascade must not fail because an emit throws.
- Publish as `git-cascade` patch version (0.0.2).

Critical files to read before starting: `references/git-cascade/src/tracker.ts`, `references/git-cascade/src/streams.ts`, `references/git-cascade/src/cascade.ts`, `references/git-cascade/src/changes.ts`.

#### Phase 1 tasks — OpenHive hub

**Create**:

- `src/map/cascade-types.ts` (~90 LOC) — imports method constants from `git-cascade/events`, re-exports for hub consumers.
- `src/map/cascade-handler.ts` (~250 LOC) — mirrors `trajectory-handler.ts`. Per-method dispatch: validate, resolve-or-auto-create `cascade_streams` row, write projection, emit `mapHubEvents.emit('cascade:stream_opened' | …)`, broadcast to WS channels (`cascade:stream:${id}`, `global`, `resource:task:${task_ref.resource_id}` when task_ref present). Auto-register `syncable_resource` of type `cascade_stream` on first event (mirrors trajectory auto-register). `CascadeRequestError` class.
- `src/db/dal/cascade-streams.ts` (~300 LOC) — idempotent DAL: `upsertStream`, `recordCommit`, `recordMerge`, `recordConflict`, `updateStreamStatus`, `getStream`, `listStreams`, `listChangesForStream`, `getCommitRangeForTask`, `listConflictsForStream`, `listOpenConflicts`, `getStreamStats`.
- `src/api/routes/cascade.ts` (~200 LOC) — REST:
  - `GET /api/v1/cascade/streams?source_swarm_id=&status=&task_resource_id=&limit=&offset=`
  - `GET /api/v1/cascade/streams/:id`
  - `GET /api/v1/cascade/streams/:id/changes`
  - `GET /api/v1/cascade/streams/:id/conflicts`
  - `GET /api/v1/cascade/tasks/:resourceId/:nodeId/commits` (changelog shape, teed up for Phase 3)
  - `GET /api/v1/cascade/conflicts?status=pending&source_swarm_id=` (triage)

**Edit**:

- `src/db/schema.ts` — bump `SCHEMA_VERSION` 30 → 31. Add `cascade_streams`, `cascade_changes`, `cascade_merges`, `cascade_conflicts` tables + indexes. Unique keys: `(source_swarm_id, stream_id)` on streams, `(stream_row_id, commit_hash)` on changes, `(stream_row_id, conflict_id)` on conflicts.
- `src/map/map-server-setup.ts` (~15 LOC) — register `x-cascade/*` methods in `buildAdditionalHandlers()`, mirror trajectory block.
- `src/api/index.ts` (~3 LOC) — register cascade route module.
- `src/coordination/listener.ts` (~30 LOC) — add `isMapCascadeEvent` / `handleMapCascadeEvent` as fallback for payload-envelope variants.
- `src/map/ws-map.ts` (~10 LOC) — branch alongside `isMapTaskEvent`.
- `CLAUDE.md` — document new `cascade.canReport` capability.

#### Phase 1 tasks — macro-agent

**Edit**:

- `src/workspace/dataplane-adapter.ts` (~40 LOC) — accept optional `mapEmitter?: CascadeMapEmitter` in `DataplaneConfig`. When present, pass as `emit` to `MultiAgentRepoTracker` constructor. Adapter does no manual wrapping — cascade emits from inside.
- Boot wiring (grep `boot-v2.ts` or similar) — inject `mapEmitter` when `dataplane.enabled && map.connected`. Gate on config.
- `src/lifecycle/cascade.ts` (~10 LOC) — pass `task_ref` through to cascade operations via `CreateStreamOptions.metadata` and `CommitChangesOptions.metadata`.

#### Tests

- `src/__tests__/map/cascade-handler.test.ts` — payload validation, auto-resource creation, idempotency on duplicate events, task_ref enrichment.
- `src/__tests__/db/dal/cascade-streams.test.ts` — DAL CRUD, `getCommitRangeForTask` join.
- `src/__tests__/api/cascade-routes.test.ts` — e2e via supertest.
- `references/macro-agent/src/workspace/__tests__/dataplane-adapter-emit.test.ts` — mock emitter, assert events for each operation with correct shape.
- **Standalone regression**: construct adapter with no emitter, run full lifecycle, assert zero errors and zero network calls.

#### Key decisions

- **Idempotency keys**: `(source_swarm_id, stream_id)` for streams; `(stream_row_id, commit_hash)` for changes. `INSERT OR IGNORE` everywhere — survives out-of-order and duplicated deliveries.
- **Auto-create on first event**: a stream row is created on the first event seen for a `stream_id`, whether that's `opened`, `committed`, or other. Handles missed `opened` events.
- **Hub never runs git**: projections are read-only lenses. Never compute merges, resolve conflicts, or issue git commands from hub code.

#### Risks

- **Change-Id format**: confirm `commitChanges` returns `{ commit, changeId }` and that cascade writes the trailer in a grep-compatible form.
- **Resource-type constraint**: confirm `syncable_resources.resource_type` is free-form TEXT (likely) or add `'cascade_stream'` to any CHECK.
- **Multi-repo per swarm**: `cascade_streams.repo_path` captures the origin repo; cascade stream IDs are globally unique (nanoid), so uniqueness holds.

#### Non-goal

No UI. No cc-swarm changes. No federation. No changelog artifact generation yet.

---

### Phase 2 — SwarmKit config surface

**Goal**: `git-cascade` becomes a proxied SwarmKit package so runtimes read policy from disk and the Settings UI edits it centrally.

**Depends on**: Phase 1 (proves wire format, shapes config defaults).

#### Tasks — swarmkit package

Add `git-cascade` package descriptor to the swarmkit registry (wherever `openteams`, `sessionlog`, `minimem` are defined):

```
name: 'git-cascade'
category: 'orchestration'
description: 'Multi-agent git coordination: streams, changes, cascade rebase'
inlineOptions:
  - enabled (confirm, default false)
  - isolationMode (select: off | per-session | per-task, default off)
  - mergeStrategy (select: queue | trunk | optimistic, default queue)
  - defaultBase (input, default 'main')
  - gcRetentionDays (input, default 30)
  - cascadeStrategy (select: stop_on_conflict | skip_conflicting | defer_conflicts, default defer_conflicts)
  - commitGranularity (select: on-tool-use | on-stop | on-task-complete | manual, default on-task-complete)
```

Both `project` and `global` scope supported.

#### Tasks — OpenHive

No source changes. `registry-adapter.ts` picks up the new package automatically; `SwarmKitPackageCard.tsx` / `SwarmKitSettings.tsx` render it from registry metadata.

#### Tasks — macro-agent

`src/workspace/config.ts` (~50 LOC) — reader that merges `.swarm/git-cascade/config.json` (project) with `~/.swarmkit/packages/git-cascade/config.json` (global); project wins. Default fallback = `DEFAULT_DATAPLANE_CONFIG`. **Must not require hub reachability.**

#### Tasks — cc-swarm

None in this phase. Config surface is available but unused until Phase 4.

#### Tests

- swarmkit registry unit tests: descriptor resolves, inlineOptions evaluate.
- OpenHive e2e (`src/__tests__/swarmkit/e2e.test.ts`) — `git-cascade` appears in package discovery; config round-trips through REST API.
- macro-agent: unit tests for config loader — defaults with empty filesystem, project overrides global, no network calls.

#### Key decisions

- **Category**: reuse `orchestration` rather than introducing `dataplane`.
- **Default `isolationMode: off`**: flipping isolation unprompted would be hostile to existing cc-swarm users. Opt-in only.
- **Config lives in swarmkit, not OpenHive**: consistent with every other proxied package.

#### Risks

- swarmkit must register a package that describes software which may not be installed. Follow the `openteams` / `sessionlog` pattern — registry existence independent of npm install state.

#### Non-goal

No cc-swarm wiring. No doctor checks beyond "package installed."

---

### Phase 3 — Task↔stream binding + changelog artifact

**Goal**: close a task → see commit range + changelog on its detail page.

**Depends on**: Phase 1 DAL and projections.

#### Tasks — hub

**Edit**:

- `src/db/dal/cascade-streams.ts` — flesh out `getCommitRangeForTask(taskResourceId, taskNodeId)` returning `{ stream_id, first_commit, last_commit, change_ids, commits[], files_union, merge_commit?, merge_target? }`.
- `src/api/routes/resource-content.ts` — add virtual path `GET /api/v1/resources/:id/cascade?node_id=...` returning the commit-range join when `resource_type === 'task'`.
- `src/map/task-handler.ts` — on `task.update` with `status: closed|completed`, query `getCommitRangeForTask` and attach a `cascade` block to the broadcast `task.status` event. Emit `mapHubEvents.emit('task_changelog_ready', {...})`.

**Create**:

- `src/cascade/changelog.ts` (~120 LOC) — `generateChangelog(taskResourceId, taskNodeId)` returning structured object + markdown. Served on-demand via route (no persistence in this phase).

#### Tasks — frontend

**Create**:

- `src/web/pages/tasks/CascadeBlock.tsx` (~150 LOC) — component rendered on task detail page: commits table (hash, author, summary, files), merge status, open conflicts, "copy changelog" button.

Integrate into the existing task detail page.

#### Tests

- DAL tests for `getCommitRangeForTask` with fixtures: multi-commit stream, merged stream, abandoned stream, empty stream.
- Route test for `GET /api/v1/resources/:id/cascade`.
- Frontend unit tests for `CascadeBlock` — with/without data, with conflicts, with abandoned streams.

#### Key decisions

- **Binding lives in cascade projections only** — `cascade_streams.task_resource_id` and `cascade_changes.task_resource_id`. OpenTasks graph is not modified. Clean authority split.
- **Multiple streams per task**: supported (e.g., a task spawns two worker streams). DAL returns all; UI renders as sibling commit ranges.
- **No changelog persistence yet** — on-demand generation only. Reconsider for Phase 5 or when operators want archival release notes.

#### Risks

- **task_ref propagation reliability**: runtimes must pass `task_ref` on every commit event. Macro-agent has task IDs at commit time. cc-swarm (Phase 4) needs the active task ID at hook time — comes from sidecar state tracking `bridge-task-created`/`bridge-task-assigned`.
- **Late task_ref**: if `stream.opened` lands without it but `stream.committed` includes it, back-fill `cascade_streams.task_resource_id` on first-seen.

#### Non-goal

No persisted changelog artifacts. No cross-task release notes.

---

### Phase 4 — cc-swarm opt-in integration

**Goal**: cc-swarm agents can optionally commit to cascade-managed streams, with the user's cwd and editing flow undisturbed.

**Depends on**: Phase 2 config surface, Phase 0 cascade `emit` hook.

#### Key design choice up front

git-cascade is cwd-agnostic — all git operations take explicit `cwd`. cc-swarm picks between:

- **replay-to-worktree** (recommended default): user keeps editing in cwd; PostToolUse hook copies/syncs changed files into the detached worktree path before committing there. Preserves the current cc-swarm UX. Adds a file-sync step per commit.
- **cwd-is-worktree**: matches macro-agent model. Simpler internals, but user's `pwd` changes when cascade is enabled.

Phase 4 ships `replay-to-worktree` as default; `cwd-is-worktree` offered as an `isolationMode: per-task-cwd` variant for power users.

#### Tasks — cc-swarm

**Edit**:

- `package.json` — add `git-cascade` dependency (optional-peer pattern).
- `src/config.mjs` (~30 LOC) — parse `cascade` config block from swarmkit-proxied settings; env overrides.

**Create**:

- `src/cascade-client.mjs` (~250 LOC) — ESM wrapper around git-cascade:
  - `initCascade(config, repoPath)` → returns `MultiAgentRepoTracker` instance (with `emit` wired to sidecar) or null.
  - `ensureSessionStream(tracker, sessionId, agentId)` — per-session isolation mode.
  - `ensureTaskStream(tracker, taskId, agentId, parentStreamId?)` — per-task isolation mode.
  - `commitBatch(tracker, streamId, agentId, worktreePath, files, message)` — replay files into worktree, commit there. Implements the replay-to-worktree pattern.
  - Lazy-loads `git-cascade` via dynamic import so cc-swarm runs fine if cascade isn't installed.
- `scripts/cascade-hook.mjs` (~80 LOC) — thin CLI wrapper (mirrors `map-hook.mjs`) invoked from `hooks.json`. Reads hook stdin, calls `cascade-client` functions.

**Edit**:

- `hooks/hooks.json` (~40 LOC):
  - `SessionStart` → `ensureSessionStream` (when `isolationMode: per-session`).
  - `PostToolUse(Write|Edit)` → queue file into pending batch.
  - `Stop` (or `SessionEnd`) → flush batch via `commitBatch` when `commitGranularity !== manual`.
  - Task-completion hook (from opentasks bridge) → flush batch + emit `stream.committed` with `task_ref`.
  - `SessionEnd` → merge or abandon based on policy.
  - All hooks gated on `cascade?.enabled && isolationMode !== 'off'` via the existing node-eval config-read pattern.
- `src/bootstrap.mjs` — initialize tracker and open session stream when cascade enabled.

**Template flag**:

- `skills/swarm/SKILL.md` — document `cascade: { enabled: true, isolationMode: 'per-task', commitGranularity: 'on-task-complete' }` as a team YAML extension.

#### Tests

- `cascade-client.test.mjs` — lazy-loading, stream open/close, replay-to-worktree commit payload shape.
- cc-swarm e2e: full session with fixture git repo, assert commits land on `stream/<id>` branch in the worktree, user cwd unchanged, MAP events emitted.

#### Key decisions

- **Default off**: preserves existing cc-swarm UX.
- **Active task tracking**: sidecar maintains `currentTaskId` from `bridge-task-created` / `bridge-task-assigned` events.
- **Commit granularity = on-task-complete**: cleanest audit trail, cheapest emits. `on-stop` and `on-tool-use` available for users who want finer granularity.
- **Merge strategy**: cc-swarm has no merge-queue infrastructure; default `mergeStrategy: 'trunk'`. Queue support deferred.

#### Risks

- **Replay semantics**: copying working-copy files into a worktree preserves the literal bytes but loses atomicity with partial writes. Need a tiny state machine ensuring "no active Write/Edit in flight" before replay.
- **User deletions**: if the user deletes files in cwd, the replay must `git rm` in the worktree. Trivial but easy to forget.
- **Mid-session crashes**: with `commitGranularity: on-task-complete`, all work since the last task-close can be lost if the process dies. Documented. `on-stop` narrows the window.

#### Non-goal

No merge-queue in cc-swarm. No conflict-resolution UX. No retrofit of existing sessions into streams.

---

### Phase 5 — Cross-swarm aggregation (stretch)

**Goal**: operator-level views spanning multiple swarms.

**Depends on**: Phase 1, 3.

#### Tasks (sketched)

- **Federated review blocks** — when a task has `task.linked` edges across swarms (opentasks already supports this), hub joins `cascade_changes` from both swarms via `task_resource_id`. New route `GET /api/v1/cascade/reviews/:taskResourceId/federated`.
- **Conflict triage dashboard** — `/cascade/conflicts` page showing all open `cascade_conflicts` across swarms with filters (swarm, stream, age). "Request resolution" button emits MAP notification to owning swarm.
- **Unified rollback scope** — design-only. Requires transactional semantics spanning opentasks graph ops (delete task edges) + cascade rollback (revert commit range). Probable new table `rollback_scopes`.

#### Risks

- **Authority for cross-swarm merges**: hub is not authoritative for cascade state. Cross-swarm *read* is fine; cross-swarm *merge orchestration* needs a designated integrator swarm volunteering to execute. Likely out of scope for v1.

#### Cross-swarm `task_resource_id` correlation (G14, validated)

Two swarms emitting events with `metadata.task_ref = { resource_id, node_id }` correlate to the same hub projection **only when both swarms resolve to the same `resource_id` value**.

The correlation works by design when:
- Both swarms register their OpenTasks graph via the same `git_remote_url` — the hub's `idx_syncable_resources_git_url` UNIQUE constraint (`src/db/schema.ts:1336`) forces one row per `(owner_agent_id, resource_type, git_remote_url)`.
- Both swarms set the same `taskResourceId` in their boot config (operator-set, single source of truth).
- Federated sync via `(origin_instance_id, origin_resource_id)` (`idx_resources_origin`) bridges instances replicating the same resource.

The correlation breaks when:
- Swarms register independently with different `git_remote_url`s for the same logical graph.
- Operators set divergent `taskResourceId` values per swarm.

**Operational guidance**: any deployment where multiple swarms collaborate on a shared OpenTasks graph must configure all those swarms with the same `cascade.taskResourceId` (resolved from the resource's hub-local UUID after the first registration). The hub stores `task_resource_id` as a string with no FK constraint — it trusts callers to align.

**Multi-graph deployments** (one macro-agent process touching multiple OpenTasks graphs): use `cascade.resolveTaskRef(spawnOptions)` instead of the single-string default. The resolver returns a `TaskRef` per spawn, letting callers compute the binding from the agent's cwd, team, or other context. Explicit `SpawnAgentOptions.taskRef` still wins over both resolver and default. See `references/macro-agent/src/agent/__tests__/task-ref-resolution.test.ts` for the precedence contract.

**Future work**: a `/cascade/tasks/lookup?git_remote_url=...&node_id=...` endpoint could let runtimes resolve the canonical `resource_id` at boot without operators having to wire it manually. Defer until cross-swarm collaboration becomes a concrete pattern.

#### Non-goal

No distributed conflict resolution. No cross-swarm merge orchestration.

---

## Cross-cutting concerns

### Dependency graph

```
Phase 0 (git-cascade patch) ─┬─> Phase 1 (hub + macro-agent)
                              └─> Phase 4 (cc-swarm)
Phase 1 ─┬─> Phase 2 (config)
         ├─> Phase 3 (binding + changelog)
         └─> Phase 5 (federation)
Phase 2 ─> Phase 4 (cc-swarm reads config)
Phase 3 ─> Phase 5 (federation builds on binding)
```

### Patterns to mirror

- `src/map/trajectory-handler.ts` → `src/map/cascade-handler.ts` (MAP method dispatch, auto-resource creation, mutex-protected task enrichment).
- `src/map/task-handler.ts` → event broadcast + `mapHubEvents.emit` pattern.
- SwarmKit package registry → `git-cascade` descriptor.
- `src/api/routes/resource-content.ts` → virtual-path task projection joins.
- `src/coordination/listener.ts` → payload-envelope fallback when runtimes use `send()` instead of JSON-RPC methods.

### Observability

All `cascade:*` hub events flow through `mapHubEvents` so the SwarmCraft bridge and learning engine consume them uniformly with trajectory and task events.

### Protocol versioning

Bump a capability flag (e.g., `x-openhive/cascade:v1`) in the hub's well-known extension so runtimes can feature-detect before emitting.

### Standalone-mode regression guarantee

Every phase adds a test asserting the runtime works with zero OpenHive reachability. macro-agent today runs cascade standalone; cc-swarm with cascade enabled must continue to work if the hub is down (events queue or drop; config reads from disk).

## Deferred work / backlog

Items intentionally not addressed in current scope. Each entry: **what**, **why deferred**, **when to revisit**, and **where the existing pieces sit** so the work can resume without rediscovery.

### Status snapshot (as of latest pass)

**Shipped end-to-end:**

- Phase 0: git-cascade emit hook (versions 0.0.4 → 0.0.7 with stream + cascade + queue + push events)
- Phase 1: hub projections + macro-agent emission via cascade-bridge; standalone-mode preserved
- Phase 1 closure (G1, G2, G3, G4, G5, G6, G7, G11, G12-pagination, G13, G14-investigation, G15)
- Phase 3: changelog generator (`src/cascade/changelog.ts`) + REST surface (`/cascade/tasks/:r/:n/changelog`) + `TaskDetail` page (`/tasks/:resourceId/:nodeId`) + `CascadeBlock` component + sidebar deep-link + WS realtime invalidation (`useCascadeRealtime`)
- Phase 3a — Cascade ↔ task binder (2026-04-21): `src/cascade/task-binder.ts` orchestrator + `src/cascade/policy.ts` three-scope resolver + `src/map/task-broadcast.ts` consolidated broadcast helper. `cascade_stream_merged` now carries `task_ref`; terminal `task.status` broadcasts carry a `cascade` block when cascade data exists. Default close policy is `manual` (no auto-close); opt-in via per-task `close_policy`, per-swarm `cascade.autoCloseOnMerge` capability, or hub `config.cascade.defaultClosePolicy`. Design spec: `docs/superpowers/specs/2026-04-21-cascade-task-binding-design.md`. 28 unit + 4 integration tests; 588-test regression suite clean.

**Verified in Phase 3 E2E pass (live dev server + chrome-devtools):**

- All 5 CascadeBlock UI states: loading / error / empty / populated / not-in-graph fallback
- Copy markdown button (verified clipboard write of 814-char markdown)
- Files-touched expand button (10 → 13 on click)
- Sidebar deep-link from TaskGraphSidebar
- All 13 cascade REST endpoints returning expected shapes against seeded data
- WS realtime invalidation: fake event → React Query refetch → UI updates without reload
- Live emission E2E (9 scenarios in `src/__tests__/cascade/live-emission-e2e.test.ts`) covering the macro-agent → bridge → handler → DAL chain in-process

**Test counts:** OpenHive 54 cascade tests (handler 22 + routes 17 + changelog 6 + live-emission 9) + git-cascade 755 unit/e2e + macro-agent 11 cascade-related (bridge 8 + standalone 3). All green.

The remaining backlog below is everything that's *not* shipped or verified yet.

### Operational

#### O1. Publish git-cascade 0.0.5, 0.0.6, 0.0.7 to npm

- **What**: Three unpublished versions exist locally (`references/git-cascade/`). Only 0.0.4 is on npm. Phase 1 closure code consumes 0.0.5 (rebased commit emit), 0.0.6 (conflict resolution), and 0.0.7 (queue + pushed events). The 0.0.7 publish should also include the **CJS exports fix** discovered during Phase 3 E2E: `default` condition added to `package.json` exports map so CJS-context resolvers (tsx, jest, etc.) can find the entry.
- **Why deferred**: external publish requires the maintainer's npm credentials; locally `file:./references/git-cascade` works.
- **When to revisit**: before any external user clones OpenHive or macro-agent and runs `npm install`. Also blocks Phase 4 (cc-swarm integration) since cc-swarm would need the published version.
- **Where it sits**: `package.json` in OpenHive root + `references/macro-agent/package.json` both pin `^0.0.7`. Both `node_modules/git-cascade` are linked via `file:./references/git-cascade`. After publishing, run `npm install git-cascade@^0.0.7` in both to switch from `file:` to registry resolution. Without the publish, fresh clones hit `ERR_PACKAGE_PATH_NOT_EXPORTED` from any CJS-mode tooling — verified during Phase 3 E2E.

#### O3. Publish macro-agent dist with Phase 1 cascade additions

- **What**: macro-agent's npm package needs republishing to include `dist/workspace/git-cascade-adapter.js`, `dist/map/cascade-bridge.js`, and the `notifyStreamPushed` adapter method. Pre-Phase-1 dist still ships `dataplane-adapter.js` (old name) and lacks the bridge.
- **Why deferred**: same as O1 — needs maintainer credentials.
- **When to revisit**: alongside O1; the two should ship together since macro-agent depends on git-cascade 0.0.7+.
- **Where it sits**: `references/macro-agent/dist/` has the latest after `npm run build`. OpenHive consumes it via symlink during dev (`node_modules/macro-agent → ../references/macro-agent`).

#### O2. Verify schema migrations on production-like data

- **What**: Migrations V31 (cascade projections), V33 (cascade_operations), V34 (cascade_pushes + cascade_queue_entries) haven't been run against a real OpenHive database.
- **Why deferred**: requires staging DB access and a migration test harness — not a code change.
- **When to revisit**: before any deploy that includes cascade tables to a hub holding production data.
- **Where it sits**: migrations defined in `src/db/schema.ts` (lines 1373+, 1424+, 1463+). Registered in `src/db/index.ts` MIGRATION_REGISTRY 31/33/34. CREATE_TABLES blocks duplicate the same DDL for fresh installs.

### Test infrastructure

#### T1. Cross-process E2E fixture (partially closed)

- **What**: An end-to-end test exercising macro-agent → MAP → hub for cascade events.
- **Status**: **In-process variant landed** as `src/__tests__/cascade/live-emission-e2e.test.ts` (9 scenarios, gated on `RUN_E2E_TESTS=true`). Uses real macro-agent `GitCascadeAdapter` + real `CascadeBridge` + real OpenHive `handleCascadeRequest`, bridged by a mock `LifecycleBridgeConnection` whose `callExtension` delegates straight to the handler. This catches **wire-format drift** (missing fields, renamed methods) since the same handler the live MAP server invokes runs in the test.
- **What still needs cross-process coverage**: the actual MAP WebSocket transport — separate macro-agent process opens a real WS to OpenHive, exchanges JSON-RPC notifications. Catches **protocol/transport drift** the in-process test misses (header handling, auth, reconnect, ordering under concurrency). Not captured by anything today.
- **When to revisit**: before v1.0 release. Also good before any change to the MAP authentication/registration flow.
- **Where it sits**: extend `src/__tests__/map/e2e-cc-swarm.test.ts` pattern. The cc-swarm variant already proves the WS scaffolding; a macro-agent variant would need to wire `MAPSidecar` + a real `GitCascadeAdapter` + assert hub projections via REST.

#### T3. WebSocket round-trip delivery for cascade events — **LANDED**

- **What shipped**: `src/__tests__/cascade/ws-roundtrip-e2e.test.ts` boots a real Fastify server with the real realtime handler, opens an actual `ws` client, and asserts cascade events delivered via `handleCascadeRequest` reach the subscriber under 500ms. 3 scenarios: stream.committed via `resource:task:*`, stream.merged via `global`, and channel isolation (unsubscribed clients receive nothing).
- **Additional live-end validation**: `src/__tests__/cascade/fixtures/cascade-smoke.mjs` + `src/__tests__/cascade/fixtures/cascade-smoke-live-commit.mjs` exercise the same chain against a running dev server; the browser UI updates from 3→4 commits without reload in under a second.

#### T2. macro-agent self-driving-yaml.test.ts — **LANDED**

- **What shipped**: the missing `macro_agent.workspace` block was added to `references/macro-agent/.multiagent/teams/self-driving/team.yaml` (planner `attach_to_team_root`, grinder `new_stream` + `fork_from_team_root` + `direct_push`, judge `none`). All 6 tests in `src/workspace/__tests__/self-driving-yaml.test.ts` pass; full macro-agent suite went from 1030→1035 passing, 5→0 failing.

### Event coverage

#### E1. Pause/resume/rollback events — **LANDED**

- **What shipped**: Three new `x-cascade/*` event types in git-cascade: `stream.paused` (with reason), `stream.resumed`, `stream.rolled_back` (with strategy discriminant + resulting HEAD). `CASCADE_METHOD_SUFFIXES`, `CASCADE_METHODS`, `buildCascadeMethods`, `CascadeSuffixMap`, `CascadeMethodMap` all extended. Tracker methods `pauseStream`, `resumeStream`, `rollbackToOperation`, `rollbackN`, `rollbackToForkPoint` now fire emits after the DB write. Hub-side: three new handler functions in `src/map/cascade-handler.ts` — `handleStreamPaused` (flips status to 'paused'), `handleStreamResumed` (reverts to 'active'), `handleStreamRolledBack` (observability broadcast only, no DB mutation). All three broadcast to stream/swarm/task channels.
- **Tests**: +4 in git-cascade (events.test.ts — pause, resume, rollbackN, rollbackToOperation), +4 in OpenHive handler (cascade-handler.test.ts — pause updates status, resume reverts, rolled_back ack, rolled_back validation).
- **Not covered**: stacked-review block lifecycle events (`review.opened`, `review.approved`, etc.) — still deferred; no driving use case beyond this pass.

#### E2. Recovery strategy method tagging — **PARTIALLY LANDED**

- **What shipped**: `spawn-resolver.ts` now injects `MACRO_RECOVERY_STRATEGY=spawn-resolver` and `MACRO_CONFLICT_ID=<id>` into the resolver agent's process env via `config.env`. When the `resolve_conflict` MCP tool is implemented, it will read these env vars and pass `{ method: 'spawn-resolver' }` to `workspaceManager.resolveConflict`.
- **What still needs implementing**: the `resolve_conflict` MCP tool itself. It requires a new `resolve_conflict` control command in the control-client/control-server RPC layer (the MCP subprocess is a separate process; it can't call workspaceManager directly). This is significant infrastructure — a new command in `src/control/types.ts`, handler in `src/control/control-server.ts`, typed method on `src/control/control-client.ts`, and the MCP tool registration in `src/mcp/mcp-server-v2.ts`.
- **When to revisit**: when a resolver agent run surfaces the method-tag gap in real dashboard output. The env threading is ready; just needs the RPC + MCP wiring.

#### E3. Rate limiting on cascade event ingestion — **LANDED**

- **What shipped**: per-swarm token bucket in `src/map/cascade-rate-limit.ts` (default capacity 400, refill 200/s). Enforced at the cascade dispatcher site in `src/map/map-server-setup.ts` before the handler touches the DB; exceeded budget throws JSON-RPC `code: -32005` so sidecars can back off. Config mutable at runtime via `setCascadeRateLimitConfig`. Tests: `src/__tests__/map/cascade-rate-limit.test.ts` (6 tests — capacity, per-swarm isolation, refill, cap, unknown-swarm passthrough, reset).

### Architectural follow-ups

#### A1. Per-merge metadata threading — **LANDED**

- **What shipped**: `MergeStreamOptions.metadata?: EventMetadata` added in git-cascade (`src/models/stream.ts`); `tracker.mergeStream` forwards it on both the `stream.merged` emit (success path) and the `stream.conflicted` emit (merge-conflict path). Macro-agent's `WorkspaceManager.mergeStream` + `DefaultWorkspaceManager.mergeStream` signatures gained the same field; `MergeToParentStrategy` threads `ctx.taskRef` through as `{ task_ref }`; `terminateWithChangeConsolidation` accepts an optional `taskRef` arg and `AgentManagerV2.terminate` reads `record.metadata?.task_ref` from the parent agent and passes it through. The hub's DAL + handler already persisted `metadata`, so no hub-side schema change was needed.
- **Tests**: +2 in git-cascade (`tests/events.test.ts` — metadata on success + conflict emits), +1 in macro-agent strategies (`strategies.test.ts`), +1 in macro-agent consolidation (`cascade-consolidation.test.ts`), +1 in OpenHive live-emission E2E (`live-emission-e2e.test.ts` — full macro-agent → bridge → hub → `cascade_merges.metadata` round trip).
- **Counts**: git-cascade 715→717, macro-agent 1035→1038, OpenHive live-emission 9→10. All green.

#### A2. V3 dispatcher invocation of LandingStrategy.land() — **LANDED**

- **What shipped**: `WorkspaceManager.land(ctx)` dispatcher in `references/macro-agent/src/workspace/workspace-manager.ts`; resolves strategy by internal or YAML name (`resolveLandingStrategyName`), fills `ctx.workspaceManager`, short-circuits on `'none'`, throws on unknown names, respects `canLand`. Terminate flow in `src/agent/agent-manager-v2.ts` now calls `workspaceManager.land({ strategyName: roleConfig.landing, ... })` when `TopologyPolicy.getRoleConfig` supplies a landing strategy; legacy `mergeQueue.submit` preserved as fallback for programmatic callers without YAML topology. Tests: `src/workspace/__tests__/land-dispatch.test.ts` (13 tests).
- **Full coverage** (as of A1 landing): `LandingContext.taskRef` now threads all the way into `stream.merged.metadata`.

#### A3. cleanup.ts `attemptMerge` routed through tracker — **LANDED**

- **What shipped**: `terminateWithChangeConsolidation` in `references/macro-agent/src/lifecycle/cascade.ts` now accepts an optional `workspaceManager` arg and prefers `ws.mergeStream({ sourceStreamId, targetStreamId, ... })` when both child + parent workspaces carry stream ids. Successful consolidation fires `x-cascade/stream.merged` via git-cascade's emit hook → CascadeBridge → hub. Falls back to raw `attemptMerge` when either workspace lacks a stream id, no manager is passed, or the tracker throws. Tests: `src/lifecycle/__tests__/cascade-consolidation.test.ts` (6 tests covering both paths + conflict propagation + legacy-no-provider case).
- **Full coverage** (as of A1 landing): when the parent agent has `task_ref` in its record metadata, the consolidation merge now emits `stream.merged.metadata.task_ref` — see the A1 entry below for the cross-layer plumbing.

#### A4. `/cascade/tasks/lookup` endpoint — **LANDED**

- **What shipped**: `GET /api/v1/cascade/tasks/lookup?git_remote_url=...&node_id=...` in `src/api/routes/cascade.ts`, backed by `findResourcesByRepoUrl(url, 'task')`. Returns `{ resource_id, node_id, resource_name, git_remote_url, owner_agent_id, match_count }` or 404. Normalizes URL variants (trailing `.git`, trailing slash, case, SSH↔HTTPS). Tests: 6 new cases in `src/__tests__/routes/cascade-routes.test.ts` covering the happy path, URL normalization (4 variants), 404, 400, 401.

#### A5. Artifact persistence (changelog archival)

- **What**: Phase 3 generates task-completion changelogs on-demand. No archival storage.
- **Status**: changelog generator + REST surface shipped (`src/cascade/changelog.ts`, `GET /cascade/tasks/:r/:n/changelog?format=json|markdown|both`). Persistence layer is what's deferred.
- **Why deferred**: on-demand is cheaper and the data sources (`cascade_changes`, `cascade_merges`) are durable. Persistence is only useful if operators want immutable release notes that survive cascade table compaction.
- **When to revisit**: when a "release notes" feature is requested or when operators ask for tamper-evident records.
- **Where it sits**: would add `cascade_artifacts` table; persist via the existing `src/cascade/changelog.ts` generator behind a new `POST /cascade/tasks/:r/:n/changelog/snapshot` route.

#### A6. Monorepo / multi-repo support

- **What**: `cascade_streams.repo_path` exists but cross-repo streams within one swarm aren't tested. A swarm operating on a monorepo with submodules might emit events from multiple repos.
- **Why deferred**: no concrete use case today; macro-agent's worktree model is single-repo.
- **When to revisit**: when a swarm registration declares multiple repo paths, or when monorepo-with-submodule operators report misaligned events.
- **Where it sits**: `cascade_streams.repo_path` column + stream events carrying repo identity. Audit `src/map/cascade-handler.ts` for assumptions that a swarm = one repo.

### UI / frontend coverage

#### U1. Mobile / responsive layout for TaskDetail + CascadeBlock

- **What**: Phase 3 UI was tested at desktop (1440px+) only. Mobile breakpoints (320–768px) and tablet (768–1024px) haven't been verified. The CascadeBlock summary tiles use `grid-cols-2 sm:grid-cols-4` so they should reflow, but the commits list, merges list, and conflicts card haven't been visually validated.
- **Why deferred**: no mobile users yet for the operator dashboard; desktop-first is the v1 target.
- **When to revisit**: when operators report mobile usability issues or when the UI ships to a touch-first audience.
- **Where it sits**: `src/web/components/CascadeBlock.tsx` + `src/web/pages/TaskDetail.tsx`. Quick check: add Chrome DevTools device emulation to the existing E2E flow.

#### U2. Light theme rendering — **LANDED**

- **What shipped**: hardcoded `#dc2626` / `#fca5a5` in `src/web/components/CascadeBlock.tsx` replaced with `var(--color-danger)` / `var(--color-danger-border)`. New tokens defined in both `:root, .dark` (red-400 / red-900 — softer on dark) and `.light` (red-600 / red-300 — stronger on light) in `src/web/styles/globals.css`. A `--color-danger-bg` token is also defined for future status-card backgrounds.

#### U3. Keyboard navigation + accessibility — **LANDED**

- **What shipped**: `.btn-ghost` now has `focus-visible:ring-2 focus-visible:ring-honey-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]` so every ghost button (Copy markdown, sidebar Maximize2, sidebar Close) gets a visible focus ring with contrast-aware offset. The "Show N more" expand button in `CascadeBlock` grew a matching ring + `aria-expanded` + descriptive `aria-label`. Icon-only buttons (Maximize2 link, X close, Copy markdown) gained `aria-label`s so screen readers announce them. Verified via web build passing.

### Originally-planned items still open

#### P1. cc-swarm cascade integration (Phase 4)

- **What**: Phase 4 in this plan — cc-swarm runtime opt-in to cascade with `replay-to-worktree` or `cwd-is-worktree` modes.
- **Why deferred**: cc-swarm doesn't have cascade today; the integration is a green-field add. Deferred until macro-agent integration is operationally validated and there's a clear cc-swarm user pulling for it.
- **When to revisit**: when cc-swarm users want OpenHive observability for their sessions, OR when Phase 5 federation needs to cover cc-swarm-style flows.
- **Where it sits**: full sketch in this plan, "Phase 4 — cc-swarm opt-in integration" section.

#### P2. SwarmKit config surface (Phase 2)

- **What**: A `git-cascade` package descriptor in SwarmKit so operators configure cascade via the existing settings UI.
- **Why deferred**: macro-agent uses cascade with hardcoded defaults today. No operator has asked for the config surface yet.
- **When to revisit**: when Phase 4 lands (cc-swarm needs config) OR when macro-agent operators want to tune `mergeStrategy`, `defaultBase`, `gcRetentionDays` per project.
- **Where it sits**: full sketch in this plan, "Phase 2 — SwarmKit config surface" section.
