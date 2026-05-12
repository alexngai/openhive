# src/cascade — hub-side cascade business logic

Everything that *uses* cascade projections lives here. The projections themselves (stream/commit/merge/conflict rows) are written by `src/map/cascade-handler.ts` in response to `x-cascade/*` MAP events from runtimes. This directory holds the consumers:

- **`changelog.ts`** — on-demand changelog generator. Reads cascade projections via `getCommitRangeForTask(resource_id, node_id)` from `src/db/dal/cascade-streams.ts` and renders a structured result + markdown. Served via `GET /api/v1/cascade/tasks/:resourceId/:nodeId/changelog`.
- **`policy.ts`** — pure `resolveClosePolicy({ taskMetadata, swarmCapabilities, hubConfig })` function. No I/O. Implements the three-scope chain (task > swarm > hub) that decides whether a cascade merge should auto-close its linked task.
- **`task-binder.ts`** — named orchestrator. Subscribes to `mapHubEvents.cascade_stream_merged`, evaluates `policy.ts`, and (when resolved to `'on_merge'`) calls the opentasks update path to transition the linked task to `completed`. Off by default.
- **`diff-types.ts`** — types + method-name constants for the `cascade/diff.request` / `cascade/diff.response` / `cascade/diff.chunk` MAP protocol. `DiffResult` is the resolver's return shape (`{ ok, payload | error }`). No runtime logic.
- **`diff-resolver.ts`** — five-tier diff fetcher used by three REST endpoints. Tiers: (1) cache via `cascade_diff_cache`, (2) presence + `cascade.canServeDiff` capability gate, (3) on-demand `cascade/diff.request` via a swappable `MapDiffFetcher` (default stubs `not_implemented`; the production one is installed from `src/map/cascade-diff-protocol.ts` at boot), (4) 60s wait surface as `timeout`, (5) cache write-through. Three entry points: `resolveCommitDiff` (single commit), `resolveStreamDiff` (`stream.base_commit..head`, head derived from `getLatestCommitForStream`), `resolveStackDiff` (calls `stack-resolver` then runs `lowest_base..highest_head`).
- **`stack-resolver.ts`** — linear-stack walker for stack-level diff. Walks `parent_stream_id` edges. **Skip statuses** (`merged`, `abandoned`, `paused`) are filtered out as candidates; `conflicted` stays in the chain. Rejects branching with `NonLinearStackError` → route returns 400 `non_linear_stack`. Returns ordered chain + `(lowest_base, highest_head)`. The entire walk runs inside `db.transaction(...)` so the children fan-out is consistent with the root read (no torn plan from a concurrent `stream.merged` / `cascade.rebased` event).
- **`pr-stack-walker.ts`** — toposort walker for "Open PR stack". DFS from a root via `parent_stream_id`, allows branching (D20). Each entry carries `ancestor_row_ids` so the route can propagate `push_required → blocked_by_parent` only down the affected branch. Per-stream base resolution: `parent.publish_branch || parent.branch_name || swarm.metadata.trunk_branch || 'main'`. Skip statuses (`merged`, `abandoned`, `paused`) are transparent — collapsed out of the plan, descendants base on the next live ancestor up. `conflicted` stays in. Returns parent-before-child plan. The entire walk runs inside `db.transaction(...)` for snapshot consistency.

## Cascade diff cache

`cascade_diff_cache` (migration V56) is content-addressed by `(stream_id, commit_hash, base_hash, file_path)` with all four columns NULL-tolerant via `IFNULL` in the unique index. Eviction happens on terminal events (`stream.merged`, `.abandoned`, `cascade.rebased`) — the cascade handler calls `evictByStream(stream.stream_id)` in those handlers. Cache writes go through `putDiff` which is idempotent via `INSERT OR IGNORE`; reads bump `last_accessed_at` so a future LRU sweep can use it.

## REST surface (Streams 1–3)

| Endpoint | Resolver | Notes |
|---|---|---|
| `GET /cascade/streams/:id/commits/:hash/diff` | `resolveCommitDiff` | Stream 1. Optional `?file=…`, `?base=…`, `?files_only=true` (D17 — skips blob + cache write). |
| `GET /cascade/streams/:id/diff` | `resolveStreamDiff` | Stream 2 stream-level (`base..head`). Same query options. |
| `GET /cascade/streams/:id/stack/diff` | `resolveStackDiff` | Stream 2 stack-level. Returns 400 `non_linear_stack` on branching. Echoes `stack` block alongside `data`. |
| `POST /cascade/streams/:id/pr-stack` | `pr-stack-walker` + `github-api` | Stream 3. Sequential walker; idempotent (D19); per-lineage `blocked_by_parent` propagation (D18, D20); best-effort push hint per entry (D21). |

Wire protocol (Stream 1): hub → sidecar `cascade/diff.request` notification → sidecar replies with `cascade/diff.response` (inline ≤ 512 KB or streaming with `chunk_stream_id`) → N `cascade/diff.chunk` notifications for streamed responses. Reassembly + sha256 verification in `src/map/cascade-diff-protocol.ts`; sidecar-side implementation lives in `references/macro-agent/src/map/cascade-diff-server.ts`.

## Where the boundary sits

Cascade state authority lives on runtimes (each runtime's local `.git-cascade/tracker.db`). Opentasks state authority lives on runtimes (each agent's daemon). The hub is a **join + optional orchestrator**:

```
           ┌───────────────────────────────────────────────────┐
           │                   agent runtime                   │
           │  git-cascade tracker.db  ←─owns─→  opentasks DB   │
           └──────────┬─────────────────────────┬──────────────┘
                      │                         │
            x-cascade/*│                         │opentasks/*
                      ▼                         ▼
           ┌───────────────────────────────────────────────────┐
           │                        hub                        │
           │                                                   │
           │  cascade projections     syncable_resources       │
           │  (read-only lens)  ──task_ref──►  (metadata)      │
           │                                                   │
           │                     policy.ts                     │
           │                        │                          │
           │             task-binder.ts  ◄── subscribes        │
           │                to mapHubEvents                    │
           │                                                   │
           │              changelog.ts serves                  │
           │              GET /cascade/tasks/…                 │
           └───────────────────────────────────────────────────┘
```

The hub NEVER writes cascade state and NEVER writes task state directly. Every task mutation routes through the opentasks daemon (local IPC or remote MAP). Every cascade fact enters via `x-cascade/*` MAP events.

## End-to-end flow: merge → task close

1. Agent commits + merges on its local tracker. `git-cascade` emits `x-cascade/stream.merged` with `metadata.task_ref` if the stream is bound to a task.
2. `src/map/cascade-handler.ts :: handleStreamMerged` records the merge in cascade projections, flips the source stream to `merged`, and emits `mapHubEvents.cascade_stream_merged` with a resolved `task_ref` (prefers event metadata; falls back to source then target stream's persisted `task_resource_id/node_id`).
3. `task-binder.ts` picks up the hub event. For every merge, it:
   - short-circuits if no `task_ref`
   - looks up the task resource (`syncable_resources` row) by `resource_id`
   - looks up the owning swarm's aggregate capabilities from the connection registry
   - calls `resolveClosePolicy(...)` — returns `'manual'` (default, no action) or `'on_merge'`
4. On `'on_merge'`, the binder routes to the opentasks update path: local daemon if the resource has a usable `local_path`, else `remoteUpdateTask` over MAP to the owning swarm.
5. Success triggers `broadcastTaskStatus(...)` in `src/map/task-broadcast.ts`, which attaches a `cascade` block (commit range) to the `task_status_changed` hub event + `map:tasks` and `resource:task:<id>` WS broadcasts.

## Policy chain

Most-specific scope wins:

| Scope | Source | Value shape |
|---|---|---|
| per-task | `syncable_resources.metadata.close_policy` | `'manual' \| 'on_merge'` |
| per-swarm | `ParticipantCapabilities.cascade.autoCloseOnMerge` | `true \| false` |
| per-hub | `config.cascade.defaultClosePolicy` | `'manual' \| 'on_merge'` |

A swarm's explicit `false` overrides a permissive hub default. Invalid values fall through to the next scope.

## Lifecycle

`startTaskBinder({ defaultClosePolicy })` / `stopTaskBinder()` are idempotent and wired into the server in `src/server.ts` alongside the dispatch orchestrator. The binder reads `defaultClosePolicy` once at start; changing it requires a hub restart (deliberate — no hot-reload of policy; operators have to opt into drift).

## Invariants

- `task-binder` handler never throws to `mapHubEvents`. All paths inside `handleCascadeStreamMerged` are try/caught and log-drop rather than raise.
- `changelog.ts` is pure: it reads projections and renders. No side effects, no WS emissions, no DAL writes.
- `policy.ts` is pure and never throws.
- When `defaultClosePolicy: 'manual'` AND no per-task / per-swarm opt-in exists (the fleet default), the binder is a zero-cost subscriber: it does one DB lookup per merge and returns.

## Non-goals

- No retry queue. A failed auto-close (offline daemon, unreachable swarm) drops silently. Operators or agents re-close manually.
- No hub-driven cascade actions from the binder. Only `task.update` calls. Cascade-state mutations (pause, abandon, etc.) stay on the `src/map/cascade-handler.ts` request path.
- No multi-task merges in v1. One `task_ref` per merge event.

## Related files outside this directory

- `src/map/cascade-handler.ts` — `x-cascade/*` MAP request handlers; source of `mapHubEvents.cascade_*` events
- `src/map/task-broadcast.ts` — shared helper used by the binder AND by every other `task.status` emit site for payload consistency + cascade enrichment
- `src/db/dal/cascade-streams.ts` — projection DAL; `getCommitRangeForTask` is the join query
- `src/api/routes/cascade.ts` — REST endpoints for streams, merges, conflicts, changelog
- Design spec: `docs/superpowers/specs/2026-04-21-cascade-task-binding-design.md`
