# src/map — MAP Hub: swarm registry, agents, repos, trajectories

The MAP-protocol entry point. Inbound WS connections from agent swarms land here; this directory owns the connection registry, the additional-handler dispatch tables for the protocol extensions OpenHive cares about (trajectory, tasks, specs, dispatches, repos, cascade), and the lifecycle bookkeeping for swarms / agents / repos.

## Swarm lifecycle

Connected swarms follow the status progression `online` → `unreachable` → `offline`. The server pings WS clients every 30s, refreshing `last_seen_at`. On disconnect, status moves to `unreachable`; a periodic sweep (`markStaleSwarms`) demotes stale swarms to `offline` after `staleThresholdMinutes` (default 5 min).

WS broadcast fan-out for swarm-lifecycle events is centralized in `src/realtime/swarm-events.ts` — see `src/realtime/CLAUDE.md`.

## Agent presence vs state

`map_nodes.presence` (`'online' | 'offline'`) tracks **reachability**; `map_nodes.state` retains the last-known MAP agent state (`active`/`busy`/`idle`/etc.) as a historical breadcrumb. The two never overload each other:

- Presence flips offline on `agent.unregistered`, swarm WS close, heartbeat timeout, and the `markStaleSwarms` cascade.
- State updates only on `agent.state.changed` events.

The UI reads presence first; greys out + relabels offline rows so a swarm that disconnected days ago doesn't masquerade as `idle`. SwarmCraft's `agents` table mirrors the same `presence` column; OpenHive's `swarm-bridge` cascades on `swarm_offline` via `bulkUpdatePresenceByServer`.

Migration `V36_NODE_PRESENCE` plus a `repairSchema` entry guarantees the column exists even if the version-tracker advanced past V36 silently. See `src/__tests__/map/e2e-node-presence.test.ts` for the lifecycle.

## Repos and Workspaces

Repos are first-class federated syncable resources; per-agent bindings live in a separate local-only `workspaces` table. The protocol contract (canonical URL identity, `RepoClient`, declare/changed/list/retract methods, visibility tiers) is owned by the `agent-workspace` package — see [`references/agent-workspace/docs/design/repo-kind.md`](../../references/agent-workspace/docs/design/repo-kind.md). OpenHive is the **consumer**: persistence, REST/UI, federation materializer, swarm-spawn integration, trajectory bootstrap, and the policy stack that wraps the protocol.

### Resource model

`syncable_resources` rows with `resource_type='repo'` carry the federation identity (`git_remote_url` = canonicalized URL). Two layers of visibility coexist by design:

- **Column-level** (`visibility`): always `'private'` for repos. Constrained to `'private' | 'shared' | 'public'` (legacy social-layer domain).
- **Federation tier** (`metadata.visibility`): `'private' | 'hub_local' | 'federated'`. This is what producer hooks gate on and what peers see.

`metadata` (`RepoMetadata` shape):

```typescript
{
  name: string;
  default_branch?: string;
  description?: string;
  origin: 'user_defined' | 'agent_declared' | 'trajectory_inferred';
  visibility: 'private' | 'hub_local' | 'federated';
  binding_policy?: 'open' | 'closed';
  branches?: Array<{ name; head_sha; last_seen }>;
  // lifecycle audit fields, set by the matching status transition:
  merged_into_canonical_url?: string;  // status='merged_into' (forwarding pointer)
  archived_at?: string; archived_by?: string;
  redacted_at?: string; redacted_by?: string;
  merged_at?: string; merged_by?: string;
}
```

Top-level `syncable_resources.status` (V51): `'active' | 'redacted_remote' | 'archived' | 'merged_into'`. Allowed values enforced in DAL/materializer (SQLite ALTER ADD COLUMN doesn't support CHECK).

Bindings live in `workspaces (id, repo_id, agent_id → map_nodes, swarm_id → map_swarms, local_path, current_branch, head_sha, dirty, instance_label, visibility, is_active)`. Key `(agent_id, repo_id, local_path)`. **Workspaces deliberately do not federate** — they're local-only state.

### Enforcement layers (four gates on declare)

| Layer | Configured by | Status |
|---|---|---|
| **Hub policy** (`canonical_url_allow_pattern`) | hub admin | hook only — not yet validating |
| **Repo policy** (`metadata.binding_policy: open\|closed`) | repo creator | hook only — not yet validating |
| **Swarm policy** (`map_swarms.workspace_policy: { mode: open\|allow_listed\|pinned }`) | swarm operator at spawn | active for `declare`/`retract`/trajectory-bootstrap; `pinned` mode validates only (auto-bind not yet implemented) |
| **Agent privacy** (`OPENHIVE_WORKSPACE_DECLARE=off`) | agent itself | active — gates both explicit declare and trajectory bootstrap |

**Swarm policy scope**: `workspace_policy` is a *binding-time* gate. It rejects off-policy `repo.declare`, `repo.retract`, and trajectory-bootstrap-driven bindings. It does **not** scope discovery — `onList` / `onBindings` / `GET /api/v1/repos` still surface repos outside the policy if the caller has visibility under the standard rules (per RD7: visibility is reach, not ACL). Layer a separate filter if discovery confinement is needed.

### Federation flow

Federation rides the existing `resource_published` / `_updated` mesh-sync pipeline. Producer hooks gate on `metadata.visibility === 'federated'`:

| Direction | Hook / handler | When |
|---|---|---|
| Publish | `onRepoPublished` | new federated repo OR visibility upgrade to federated |
| Update | `onRepoUpdated` | metadata change on already-federated repo |
| Redact | `onRepoRedacted(old, new)` | visibility downgrade away from federated |
| Archive | `onRepoArchived` | archive of a federated repo |
| Merge | `onRepoMerged(source, targetCanonicalUrl)` | source→target merge of federated repos |

The wire `visibility` field always carries column-level `'shared'` for federated repos so the receiver's `upsertRemoteResource` writes a CHECK-valid row; the federation tier travels in `metadata.visibility` intact. Receiver lifecycle handlers look up by `(resource_type, canonical_url)` rather than origin id, since lifecycle events propagate across hubs that may have learned of the repo from a different origin.

### Wiring foot-guns (discovered during implementation)

**1. `additionalHandlers` only routes JSON-RPC requests, not notifications.**
The MAP SDK splits dispatch by id presence: `id` → `additionalHandlers`, no-id → a separate `_notificationHandler`. OpenHive registers `OpenHiveRepoHandler` via `additionalHandlers`, so agent-side transports must use `connection.callExtension(method, params)` (request) for the four `x-workspace/repo.*` methods, **not** `sendNotification`. The package's `RepoClientTransport.notify(...)` is a fire-and-forget shape — adapt it via `notify: (m, p) => connection.callExtension(m, p).then(() => undefined)`. See `references/macro-agent/src/map/sidecar.ts`.

**2. `workspaces.agent_id` FK gap.**
`workspaces.agent_id` references `map_nodes(id)`. The MAP-protocol `agent.registered` path doesn't currently project into `map_nodes` (only the explicit REST `POST /map/nodes` endpoint does — see `src/map/service.ts:registerNode`). Without intervention, every sidecar's first declare would `FOREIGN KEY constraint failed`. The handler defensively calls `ensureNodeWithId({ id: ctx.agentId, swarm_id, map_agent_id })` before inserting the binding. Trajectory bootstrap does the same. Contained to the workspaces feature; if the broader registration path ever projects into `map_nodes`, the shim becomes a no-op (`INSERT OR IGNORE`).

**3. Status column was added in V51 — explicit-column SQL queries must enumerate it.**
`SELECT *` over a long-running better-sqlite3 connection caches column metadata at first prepare; tests using `sqlite3` CLI directly will see the column, but live `findRepoById` won't until the process restarts. More importantly, helpers like `repos.ts:rowToResource` enumerate fields explicitly and **must list status** — a forgotten field doesn't typecheck (now that `SyncableResource.status` is required) but used to silently null-out in API responses. Caught during browser smoke; covered now by route tests asserting on `res.json().repo.status`.

### Repo / workspace key files

- **DAL**: `src/db/dal/repos.ts`, `src/db/dal/workspaces.ts`. The `ensureNodeWithId` shim lives in `src/db/dal/map.ts`.
- **Handler**: `src/map/workspace-handler.ts` (`OpenHiveRepoHandler`), wired in `src/map/map-server-setup.ts:registerRepoMethods`.
- **Realtime**: `src/realtime/workspace-events.ts` — `broadcastWorkspaceLifecycleEvent(repoId, event)` fans out to `map:repos` (fleet) + `map:repo:${repoId}` (per-repo). Event union: `workspace_added | workspace_changed | workspace_deactivated | repo_visibility_changed | repo_archived`.
- **Federation hooks**: `src/sync/resource-hooks.ts` (`onRepo*`) + `src/sync/materializer.ts` (`materializeResourceRedacted/_archived/_merged`).
- **Trajectory bootstrap**: `src/map/trajectory-handler.ts:bootstrapRepoFromCheckpoint` — capability-gated lazy upsert from `metadata.gitRemoteUrl + projectPath`.
- **Spawn integration**: `src/swarm/manager.ts` — `spawn(input.repo_id, input.workspace_policy)` injects `WORKSPACE_REPO_URL` / `WORKSPACE_BRANCH` / `WORKSPACE_LOCAL_PATH` into provision env.
- **REST**: `src/api/routes/repos.ts` + `src/api/schemas/repos.ts`.
- **UI**: `src/web/pages/Repos.tsx`, `src/web/pages/RepoDetail.tsx`, `src/web/components/repos/RegisterRepoModal.tsx`.
- **Sidecar (agent-side)**: `references/macro-agent/src/map/sidecar.ts` — declares `WorkspaceCapability`, runs `RepoClient.declare` from `WORKSPACE_REPO_URL` / `OPENHIVE_WORKSPACE_REPOS` env.

### Pending follow-ups

- **`metadata.repo_id` linking** on tasks / sessions / memories — typed FK so "show all sessions for this repo" becomes a one-line query. Lazy-on-next-access cutover preferred over eager backfill.
- **Branch tracking granularity** — current bindings hold `current_branch`; no `branches[]` history yet. Lazy-add when first observed, prune at 30 days.
- **`repo_id` cascade rules** for archived/merged repos — keep links + surface badges in UI; no data destruction.
- **cc-swarm sidecar wire-up** — parallels the macro-agent recipe; not yet shipped.
- **map_nodes projection from MAP-protocol registration** — make D12's shim a no-op by projecting on `agent.registered`, or retire `map_nodes` in favor of inline FK targets.
- **`workspace_policy` `mode='pinned'` auto-bind at swarm register** — currently only the validation half ships; the docstring promises hub-side auto-attach of a binding to `pinned_repo` when the swarm registers, but no code creates that binding (open question: which `local_path` and `agent_id` to use, since neither is known at swarm-register time).

**Landed surfaces** (not pending — listed for navigation):
- Audit log: hub-side `console.warn` via `logPolicyRejection` in `src/map/workspace-policy.ts`. Grep `[workspace-policy]` in hub stdout.
- REST: `GET /api/v1/map/swarms/:id/workspace-policy` (any authenticated agent), `PATCH /api/v1/map/swarms/:id/workspace-policy` (owner-only). Defined in `src/api/routes/map.ts`.
- UI: spawn dialog policy form section (mode dropdown + repo selectors) in `src/web/pages/Swarms.tsx`.

## Related subsystems

- **Trajectory data flow**: `src/sessions/CLAUDE.md` — what happens after a checkpoint lands here.
- **Task coordination**: `src/coordination/CLAUDE.md` — the relay path for task events between swarms.
- **Cascade**: `src/cascade/CLAUDE.md` — observes `x-cascade/*` MAP events the handler in this directory writes.
- **SwarmCraft integration**: `src/swarmcraft/CLAUDE.md` — agent projection ownership, MAP client ownership.
