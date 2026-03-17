# OpenTasks Sync Integration Design Document

## Overview

This document describes the integration between OpenHive and [OpenTasks](https://github.com/alexngai/open-tasks) — covering what has been built, what remains, and the design for configurable sync strategies that allow OpenTasks graphs to be discovered, read, and synchronized across instances and swarms without mandating a single approach.

**Goal**: Make OpenTasks graphs first-class resources in OpenHive with configurable sync behavior — from zero-copy local reads to full cross-instance content replication — while keeping git as the source of truth.

---

## Background

### What is OpenTasks?

OpenTasks is a task graph system for AI agents. Each agent maintains a `.opentasks/` directory containing:

- `config.json` — graph configuration (location hash, location name, settings)
- `graph.jsonl` — append-only task graph (nodes + edges in JSON Lines format)

The graph is a DAG of typed nodes (tasks, milestones, notes) connected by dependency edges. Nodes have statuses (`open`, `in_progress`, `blocked`, `completed`, `failed`) and the graph tracks blocking relationships — a task is "ready" when all its dependencies are satisfied.

OpenTasks provides a daemon (IPC over Unix socket, JSON-RPC 2.0) for live queries, and falls back to direct JSONL parsing when the daemon is unavailable.

### Problem Statement

OpenTasks graphs can exist in multiple contexts:

1. **Local filesystem** — agent's own `.opentasks/` in a project directory or `~/.opentasks`
2. **Git repository** — `.opentasks/` committed alongside code, with a remote
3. **Remote-only** — graph published by another instance via mesh sync, no local copy
4. **Ephemeral** — MAP task store entries that don't persist to a graph file

Each context has different requirements for how the graph is accessed and kept current. A local agent reading its own graph doesn't need a git clone. An instance receiving task updates from a peer needs either clone access or bundled content. The current system tracks metadata (commit hashes, file counts) but never fetches actual graph content from remote sources.

### Design Principles

1. **Git remains source of truth** — OpenHive coordinates; it doesn't replace the git workflow
2. **No mandatory clone** — local reads should not require cloning what's already on the filesystem
3. **Configurable per-resource** — sync strategy is set at the resource level, not globally
4. **Progressive enhancement** — start with metadata-only (current behavior), opt into richer sync
5. **Leverage existing primitives** — build on the resource system, MAP events, and sync protocol already in place

---

## Current State: What Has Been Built

### 1. OpenTasks Client (`src/opentasks-client/client.ts`)

IPC client that connects to the OpenTasks daemon over Unix socket (JSON-RPC 2.0):

| Method | Behavior |
|--------|----------|
| `connectDaemon()` | Establish Unix socket connection |
| `isDaemonRunning()` | Health check |
| `getGraphSummary()` | Node/edge counts, status breakdown, ready count |
| `getReady()` | Unblocked open tasks (JSONL fallback) |
| `queryNodes()` | Advanced filtering (daemon-only) |

**Dual-mode operation**: Prefers live daemon for real-time queries, falls back to direct JSONL file parsing when daemon is unavailable. The fallback parses `graph.jsonl`, computes blocking relationships, and returns equivalent results.

### 2. MAP Hub Integration (`src/map/opentasks-handler.ts`, `src/map/opentasks-types.ts`)

Four JSON-RPC 2.0 methods exposed to connected swarms:

| Method | Purpose |
|--------|---------|
| `map/opentasks/summary` | Graph statistics (nodes, edges, task status breakdown) |
| `map/opentasks/ready` | Ready tasks with limit support |
| `map/opentasks/query` | Advanced node filtering with daemon fallback |
| `map/opentasks/status` | Daemon health check + graph file existence |

Request context carries swarm ID + agent ID. Resource access is validated before returning data.

### 3. MAP Task Store (`src/map/task-store.ts`, `src/map/task-handler.ts`, `src/map/task-broadcaster.ts`)

In-memory ephemeral task store for lightweight swarm coordination:

| Method | Purpose |
|--------|---------|
| `map/tasks/create` | Create task in ephemeral store |
| `map/tasks/assign` | Assign to agent (auto-transitions to `in_progress`) |
| `map/tasks/update` | Update status/metadata |
| `map/tasks/list` | List with filters + cursor pagination |

Events broadcast to all connected MAP agents and to frontend via WebSocket channel `map:tasks`. Event types: `task.created`, `task.assigned`, `task.status`, `task.completed`.

**Key distinction**: The MAP task store is ephemeral coordination state between swarms. The OpenTasks graph is the agent's persistent, file-backed task graph. They serve different purposes but can reference each other.

### 4. REST Content API (`src/api/routes/resource-content.ts`)

OpenTasks-specific endpoints for resources with `metadata.opentasks: true`:

```
GET /api/v1/resources/:id/content/opentasks/summary
GET /api/v1/resources/:id/content/opentasks/ready?limit=N
GET /api/v1/resources/:id/content/opentasks/tasks?status=...&archived=...&offset=N
GET /api/v1/resources/:id/content/opentasks/status
```

All endpoints support JSONL fallback when daemon is unavailable.

### 5. Resource Discovery (`src/discovery/index.ts`)

Automatic detection of `.opentasks/` directories at three scopes:

| Scope | Path | Default |
|-------|------|---------|
| Global | `~/.opentasks` | Enabled via `resourceDiscovery.openTasksEnabled` |
| Project | `{projectRoot}/.opentasks` | Enabled |
| Agent | `{agentDir}/.opentasks` | Enabled |

Discovery requires either `config.json` or `graph.jsonl` to be present. Extracts metadata from `config.json` and counts nodes/edges from `graph.jsonl`. Discovered resources are registered as `resource_type: 'task'` with `visibility: 'private'`.

Configurable via:
```javascript
// openhive.config.js
resourceDiscovery: {
  openTasksEnabled: true,           // master switch
  globalEnabled: false,             // scan global paths
  globalOpenTasksPath: '~/.opentasks', // override global path
  projectRoot: process.cwd(),       // project-scope root
}
```

### 6. Resource Sync Integration

OpenTasks resources flow through the same sync infrastructure as memory banks and skills:

**Write path** (local change detected):
```
MAP sync message (x-openhive/memory.sync, x-openhive/skill.sync)
  → handleSyncMessage() in src/map/sync-listener.ts
  → updateResourceSyncState() — updates last_commit_hash
  → createSyncEvent() — audit trail
  → onResourceSynced() — records to all sync groups (if visibility != private)
  → broadcastToChannel() — WebSocket notification
  → relaySyncMessage() — forward to subscribed swarms
```

**Read path** (remote event received):
```
Peer sync event (resource_synced)
  → materializeResourceSynced() in src/sync/materializer.ts
  → Updates last_commit_hash on syncable_resources
  → Creates resource_sync_events entry
  → Broadcasts to WebSocket channel resource:{type}:{id}
```

**Polling** (webhook-free alternative):
```
POST /api/v1/resources/:id/check-updates
  → checkRemoteForUpdates() — GitHub API / GitLab API / git ls-remote
  → Creates sync event if commit hash changed
  → Broadcasts via WebSocket
```

### 7. Test Coverage

| Test File | Coverage |
|-----------|----------|
| `src/__tests__/opentasks/e2e.test.ts` | Full integration: daemon, client, content API, discovery, JSONL fallback (~768 lines) |
| `src/__tests__/opentasks/client.test.ts` | JSONL parsing, graph summaries, ready computation, edge cases (~498 lines) |
| `src/__tests__/discovery.test.ts` | `.opentasks/` detection, metadata extraction, scopes, idempotency (~284 lines) |
| `src/__tests__/map/opentasks-handler.test.ts` | MAP method dispatch, access control, error handling |
| `src/__tests__/routes/opentasks-content.test.ts` | Content endpoint response shapes, query params, JSONL fallback |

---

## What's Missing: The Sync Strategy Gap

The current system has a blind spot: **it tracks that a resource changed (commit hash, file counts) but never fetches the actual content from remote sources.**

When Instance A publishes an OpenTasks resource and Instance B materializes the `resource_published` event, Instance B gets metadata (name, description, git URL, visibility) but no graph content. To read the actual tasks, Instance B would need to:

1. Clone the git remote independently (requires credentials)
2. Have the OpenTasks daemon running locally against a local copy
3. Use the content API against Instance A directly (requires network access)

None of these are handled automatically. The integration stops at "we know this resource exists and its latest commit hash."

---

## Proposed Design: Configurable Sync Strategies

### Sync Strategy Enum

Each `syncable_resource` gets a `sync_strategy` field that determines how content is acquired and kept current:

| Strategy | Content Source | Update Trigger | Clone Required | Use Case |
|----------|---------------|----------------|----------------|----------|
| `metadata` | None (metadata only) | Sync events | No | Default. Know a resource exists, track commits, but don't fetch content. Current behavior. |
| `local` | Filesystem path | inotify / MAP heartbeat | No | Agent's own `.opentasks/` on the same machine. Direct read, no git overhead. |
| `ls-remote` | Git remote (on demand) | Query-time staleness check | Yes (lazy) | Clone on first content query. `git ls-remote` to check freshness, `git fetch` when stale. |
| `mirror` | Git remote (eager) | `resource_synced` event | Yes (maintained) | Clone and keep synced. Fetch immediately on every sync event. |
| `bundle` | Sync protocol payload | Mesh sync push | No (unbundled) | Receive `git bundle` bytes via JSON-RPC. No shared git remote required. |

### Default Strategy Selection

| Context | Default Strategy | Rationale |
|---------|-----------------|-----------|
| Discovered locally (filesystem scan) | `local` | Already on disk, no reason to clone |
| Published by this instance | `local` or `metadata` | Owner has direct access |
| Received via mesh sync (remote resource) | `metadata` | Conservative default, opt-in to content sync |
| Subscribed with write access | `mirror` | Active collaborator needs current content |
| Agent explicitly requests content | Upgrade `metadata` → `ls-remote` | First content query triggers lazy clone |

### Data Model Changes

Add `sync_strategy` to `syncable_resources`:

```sql
ALTER TABLE syncable_resources
  ADD COLUMN sync_strategy TEXT DEFAULT 'metadata'
    CHECK(sync_strategy IN ('metadata', 'local', 'ls-remote', 'mirror', 'bundle'));

-- For local strategy: filesystem path to read from directly
-- Stored in metadata JSON: { "local_path": "/path/to/.opentasks" }

-- For ls-remote/mirror: local clone path
-- Stored in metadata JSON: { "clone_path": "/var/openhive/clones/{resource_id}" }
```

No new tables needed. Clone paths and local paths stored in the existing `metadata` JSON column.

### Git Operations Layer

New module: `src/sync/git-content.ts`

```typescript
interface GitContentManager {
  // Check if remote has new commits (cheap, no disk I/O)
  checkFreshness(resource: SyncableResource): Promise<{
    stale: boolean;
    remoteHead: string | null;
    localHead: string | null;
  }>;

  // Clone or fetch depending on whether local clone exists
  ensureClone(resource: SyncableResource): Promise<string>; // returns clone path

  // Fetch latest from remote into existing clone
  fetchLatest(resource: SyncableResource): Promise<{
    previousHead: string;
    newHead: string;
    changed: boolean;
  }>;

  // Apply a received git bundle to local clone
  applyBundle(resource: SyncableResource, bundleBytes: Buffer): Promise<{
    previousHead: string;
    newHead: string;
  }>;

  // Create a delta bundle for sending to peers
  createBundle(resource: SyncableResource, sinceCommit: string): Promise<Buffer>;

  // Read file content from clone or local path (strategy-aware)
  readFile(resource: SyncableResource, filePath: string): Promise<string | null>;

  // Get the effective graph.jsonl path for an OpenTasks resource
  resolveGraphPath(resource: SyncableResource): Promise<string | null>;
}
```

### Strategy Behavior Matrix

#### `metadata` (current default)

```
On resource_synced event:  Update last_commit_hash in DB. Done.
On content API query:      Return 404 or proxy to origin instance.
On MAP query:              Return error: "content not available locally"
```

#### `local`

```
On resource_synced event:  Ignored (local filesystem is source of truth).
On MAP heartbeat:          Compare fs mtime or git HEAD against last_commit_hash.
                           If changed → createSyncEvent() + broadcast.
On content API query:      Read directly from metadata.local_path.
On MAP query:              Connect daemon to local path, or parse JSONL directly.
```

#### `ls-remote` (lazy clone)

```
On resource_synced event:  Mark cached clone as stale (don't fetch yet).
On content API query:
  1. If no clone exists → git clone --depth=1 → read from clone
  2. If clone exists and stale → git fetch → read from clone
  3. If clone exists and fresh → read from clone
On staleness check:        git ls-remote (50ms, no disk I/O, no objects)
```

#### `mirror` (eager clone)

```
On resource_synced event:  Immediately git fetch into local clone.
On content API query:      Always read from local clone (guaranteed fresh).
On MAP query:              Connect daemon to clone path, or parse JSONL.
Clone lifecycle:           Created on first sync event or subscription.
                           Deleted when resource is unsubscribed/unpublished.
```

#### `bundle` (mesh-native)

```
On resource_synced event:  If event payload contains bundle bytes:
                             git bundle unbundle into local store.
                           If no bundle: request bundle from origin via JSON-RPC.
On content API query:      Read from unbundled local store.
Source instance behavior:  On onResourceSynced(), create delta bundle:
                             git bundle create delta.bundle <peer_last_hash>..HEAD
                           Attach to sync event payload (or send out-of-band).
```

---

## MAP Event Lifecycle Integration

### Current Event Flow

```
Swarm pushes to git remote
  → Webhook or polling detects change
  → handleSyncMessage() receives JSON-RPC notification
  → updateResourceSyncState(resource_id, commit_hash, agent_id)
  → createSyncEvent() — audit trail
  → onResourceSynced() — mesh sync to peers
  → broadcastToChannel() — WebSocket to frontend
  → relaySyncMessage() — forward to subscribed swarms
```

### Proposed: Strategy-Aware Event Flow

```
Swarm pushes to git remote
  → Webhook or polling detects change
  → handleSyncMessage() receives JSON-RPC notification
  → updateResourceSyncState(resource_id, commit_hash, agent_id)
  → createSyncEvent() — audit trail
  │
  ├─ [strategy = mirror]
  │    → gitContent.fetchLatest(resource)
  │    → If changed: update graph cache, notify daemon
  │
  ├─ [strategy = ls-remote]
  │    → Mark clone as stale (set stale_since timestamp in metadata)
  │    → No fetch until next query
  │
  ├─ [strategy = bundle]
  │    → gitContent.createBundle(resource, peer_last_hash)
  │    → Attach bundle reference to sync event
  │
  ├─ [strategy = local]
  │    → No action (filesystem is source of truth)
  │
  └─ [strategy = metadata]
       → No action (current behavior)
  │
  → onResourceSynced() — mesh sync to peers
  → broadcastToChannel() — WebSocket to frontend
  → relaySyncMessage() — forward to subscribed swarms
```

### MAP Heartbeat Integration

The MAP heartbeat (periodic health check in `src/sync/service.ts`) can drive staleness detection for `local` strategy resources:

```
Heartbeat fires (configurable interval, default 30s)
  → For each local-strategy OpenTasks resource:
    → Compare last_commit_hash against current git HEAD (or fs mtime)
    → If changed:
      → updateResourceSyncState()
      → createSyncEvent()
      → onResourceSynced() (if visibility != private)
      → Broadcast to subscribers
```

This replaces the need for filesystem watchers (inotify) with a simpler polling approach that piggybacks on existing infrastructure.

### Swarm Notification: Push vs Poll

Two options for notifying MAP-connected swarms about graph changes:

**Option A: Relay via existing `relaySyncMessage()`** (recommended)

Already implemented. When `resource_synced` fires, `relaySyncMessage()` forwards to all subscribed swarms via their WebSocket connections. Swarms receive a JSON-RPC notification and can re-query via `map/opentasks/summary` or `map/opentasks/ready`.

No new protocol needed. Swarms already handle these relay messages.

**Option B: New `map/opentasks/changed` notification**

Add a dedicated notification type that includes a diff summary:

```jsonc
{
  "jsonrpc": "2.0",
  "method": "map/opentasks/changed",
  "params": {
    "resource_id": "res_abc",
    "commit_hash": "abc123",
    "previous_hash": "def456",
    "changes": {
      "tasks_added": 2,
      "tasks_completed": 1,
      "tasks_blocked": 0,
      "ready_count": 5       // current ready count after change
    }
  }
}
```

This avoids the round-trip of the swarm having to query back after receiving a generic relay. However, computing the diff requires reading the graph content — which is only possible for `local`, `mirror`, and `bundle` strategies.

**Recommendation**: Start with Option A (zero new protocol surface). Add Option B later if swarms need richer change notifications.

### Using `git ls-remote` for Lightweight Polling

The existing `checkRemoteForUpdates()` in `src/utils/git-remote.ts` already implements a three-tier strategy:

1. **GitHub API** — `GET /repos/{owner}/{repo}/commits/{branch}` (~100ms)
2. **GitLab API** — `GET /api/v4/projects/{id}/repository/commits` (~100ms)
3. **`git ls-remote`** — fallback for any git host (~50ms, no disk I/O)

For `ls-remote` strategy resources, this is the staleness check. Wire it to:

- **Content API queries**: Check before reading from clone. If stale, fetch first.
- **Batch polling endpoint**: `POST /api/v1/resources/check-updates` already supports this.
- **MAP heartbeat**: For `local` strategy resources, compare `git rev-parse HEAD` against stored hash.

### Git Bundle for Mesh Transport

For `bundle` strategy, content flows through the existing sync protocol without requiring shared git credentials:

**Source instance (on commit detected):**
```bash
git bundle create delta.bundle <last_known_peer_hash>..HEAD -- .opentasks/
```

**Transport options:**

1. **Inline in sync event** — Base64-encode bundle bytes in the `resource_synced` payload. Simple but bloats `hive_events` table (append-only, never cleaned).

2. **Out-of-band transfer** (recommended) — Sync event references a bundle hash. Receiving instance requests bundle via new JSON-RPC method:
   ```jsonc
   // Receiving instance → source instance
   { "method": "sync/resource_bundle", "params": { "resource_id": "res_abc", "since_commit": "def456" } }

   // Source instance → receiving instance
   { "result": { "bundle_base64": "...", "from_commit": "def456", "to_commit": "abc123" } }
   ```

3. **HTTP endpoint** — `GET /api/v1/resources/:id/bundle?since=<commit>` returns raw bundle bytes. Simpler for instances with HTTP connectivity but doesn't work over pure WebSocket mesh.

**Receiving instance:**
```bash
git bundle unbundle delta.bundle  # applies to local bare repo
```

---

## Configuration

### Per-Resource Configuration

Sync strategy is set on each resource, either at creation/discovery time or updated later:

```
POST /api/v1/resources
{
  "name": "my-project-tasks",
  "resource_type": "task",
  "git_remote_url": "https://github.com/user/project.git",
  "sync_strategy": "mirror",
  "metadata": { "opentasks": true }
}

PATCH /api/v1/resources/:id
{
  "sync_strategy": "ls-remote"
}
```

### Instance-Level Defaults

```javascript
// openhive.config.js
resourceSync: {
  defaultStrategy: 'metadata',          // for newly subscribed remote resources
  localDiscoveryStrategy: 'local',      // for filesystem-discovered resources
  cloneBasePath: '/var/openhive/clones', // where ls-remote/mirror clones live
  bundleMaxSize: 10 * 1024 * 1024,      // 10MB max bundle size
  lsRemoteTtl: 60,                      // seconds before ls-remote re-check
  mirrorFetchTimeout: 30000,            // ms timeout for mirror git fetch
}
```

---

## Implementation Plan

### Phase 1: Schema + Local Strategy (minimal, unblocks local reads)

1. Add `sync_strategy` column to `syncable_resources` (default: `metadata`)
2. Update discovery to set `sync_strategy: 'local'` + `metadata.local_path` for discovered resources
3. Update content API to use `local_path` directly when strategy is `local`
4. Update MAP handler to resolve graph path via strategy

### Phase 2: ls-remote Strategy (lazy clone)

1. Implement `GitContentManager.ensureClone()` and `fetchLatest()`
2. Add staleness check to content API (check before read)
3. Add `clone_path` tracking in metadata
4. Clone lifecycle management (cleanup on unsubscribe)

### Phase 3: Mirror Strategy (eager clone)

1. Hook `fetchLatest()` into `handleSyncMessage()` for mirror-strategy resources
2. Wire to `resource_synced` event in materializer
3. Add clone initialization on subscription

### Phase 4: Bundle Strategy (mesh-native content sync)

1. Implement `createBundle()` and `applyBundle()`
2. Add `sync/resource_bundle` JSON-RPC method
3. Hook into materializer for automatic bundle requests
4. Out-of-band bundle transfer protocol

### Phase 5: MAP Notifications (Option B)

1. Implement `map/opentasks/changed` notification with diff summary
2. Compute diff from graph content (requires local/mirror/bundle strategy)
3. Selective notification based on subscriber interest

---

## Relationship to Existing Systems

### OpenTasks Graph vs. Coordination Tasks

These are distinct systems that can reference each other:

| | OpenTasks Graph | Coordination Tasks |
|-|-----------------|-------------------|
| **Storage** | `.opentasks/graph.jsonl` (file-backed) | `coordination_tasks` table (DB-backed) |
| **Scope** | Single agent's work breakdown | Inter-swarm delegation |
| **Lifecycle** | Persistent, versioned in git | Ephemeral, deleted on completion |
| **Identity** | Node IDs within graph | `ct_*` IDs in database |
| **Cross-instance** | Via resource sync (metadata or content) | Via coordination sync hooks |

A coordination task can reference an OpenTasks node (e.g., "this coordination task delegates OpenTasks node X to swarm Y"), but they are not the same entity.

### OpenTasks Graph vs. MAP Task Store

| | OpenTasks Graph | MAP Task Store |
|-|-----------------|---------------|
| **Storage** | File-backed (JSONL) | In-memory |
| **Persistence** | Survives restarts | Lost on restart |
| **Purpose** | Agent's own task tracking | Real-time swarm coordination |
| **Query** | Via daemon IPC or JSONL parse | Via MAP JSON-RPC methods |

The MAP task store is intentionally ephemeral — it's for "right now" coordination. The OpenTasks graph is the durable record.

### Resource Sync Protocol

OpenTasks resources use the same `syncable_resources` infrastructure as memory banks and skills:

- Same `resource_published` / `resource_updated` / `resource_synced` events
- Same subscription and access control model
- Same WebSocket broadcast channels (`resource:task:{id}`)
- Same cross-instance materialization path

The only OpenTasks-specific additions are:
1. Content API endpoints (`/content/opentasks/*`)
2. MAP handler methods (`map/opentasks/*`)
3. Discovery integration (`.opentasks/` directory detection)
4. The sync strategy layer proposed in this document

---

## Open Questions

1. **Clone storage limits** — Should there be a per-instance cap on total clone storage? Auto-eviction policy for stale clones?

2. **Bundle size limits** — Large OpenTasks graphs could produce large bundles. Should bundles be paginated or compressed? gzip is natural since git objects are already compressed.

3. **Daemon affinity** — When a `mirror` or `ls-remote` clone exists, should OpenHive start an OpenTasks daemon instance against it? Or always fall back to JSONL parsing for cloned content?

4. **Partial sync** — Should `bundle` strategy support syncing only specific subtrees of the graph (e.g., only tasks matching a filter)? This would require OpenTasks-aware diffing rather than raw git bundles.

5. **Conflict resolution** — If two instances both have `mirror` clones and both receive pushes, how are concurrent modifications handled? Git's merge semantics apply at the file level, but JSONL append-only format means conflicts are unlikely in practice.

6. **Strategy upgrade notifications** — When a `metadata`-only subscriber upgrades to `mirror`, should the system notify the resource owner? This could be relevant for access control auditing.
