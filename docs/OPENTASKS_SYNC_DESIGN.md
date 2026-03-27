# OpenTasks Sync Integration Design Document

## Overview

This document describes the integration between OpenHive and [OpenTasks](https://github.com/alexngai/open-tasks) — covering what has been built, what remains, and the design for configurable sync strategies that allow OpenTasks graphs to be discovered, read, and synchronized across instances and swarms without mandating a single approach.

**Goal**: Make OpenTasks graphs first-class resources in OpenHive with configurable sync behavior — from zero-copy local reads to full cross-instance content replication — while keeping git as the source of truth.

---

## Key Design Decisions

The following decisions were resolved during design review and inform every section of this document:

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Direct git for sync** — use native git operations (clone, fetch, push) rather than a custom transport layer | Git is already the source of truth for OpenTasks graphs. The `opentasks` npm package provides a merge resolution utility for handling concurrent modifications; we leverage it rather than reinventing conflict handling. |
| D2 | **One resource = one graph** — each `syncable_resource` maps to exactly one OpenTasks graph | Simplifies identity, sync, and access control. A multi-graph repo registers multiple resources (one per `.opentasks/` directory). |
| D3 | **Task graph UI via sigma.js** — expand the frontend to display OpenTasks graphs visually | Follows the SwarmCraft embed pattern (`swarmcraft/ui/embed`). Task graph viewer is a self-contained React component using sigma.js for DAG rendering. |
| D4 | **Pluggable SyncProvider interface** — strategy pattern for content acquisition | Each sync strategy (`local`, `ls-remote`, `mirror`, `bundle`) implements a common interface. New strategies can be added without touching the sync orchestrator. |
| D5 | **Everything routes to OpenTasks** — deprecate `src/coordination/` task system | The coordination module's task delegation, context sharing, and messaging functionality will be migrated to OpenTasks graphs. This removes the ambiguity of having two parallel task systems. |

---

## Background

### What is OpenTasks?

OpenTasks is a task graph system for AI agents. Each agent maintains a `.opentasks/` directory containing:

- `config.json` — graph configuration (location hash, location name, settings)
- `graph.jsonl` — append-only task graph (nodes + edges in JSON Lines format)

The graph is a DAG of typed nodes (tasks, milestones, notes) connected by dependency edges. Nodes have statuses (`open`, `in_progress`, `blocked`, `completed`, `failed`) and the graph tracks blocking relationships — a task is "ready" when all its dependencies are satisfied.

OpenTasks provides a daemon (IPC over Unix socket, JSON-RPC 2.0) for live queries, and falls back to direct JSONL parsing when the daemon is unavailable. The `opentasks` npm package also exposes a **merge resolution utility** for reconciling concurrent graph modifications — this is critical for the `mirror` sync strategy where multiple instances may push to the same graph.

### Problem Statement

OpenTasks graphs can exist in multiple contexts:

1. **Local filesystem** — agent's own `.opentasks/` in a project directory or `~/.opentasks`
2. **Git repository** — `.opentasks/` committed alongside code, with a remote
3. **Remote-only** — graph published by another instance via mesh sync, no local copy
4. **Ephemeral** — MAP task store entries that don't persist to a graph file

Each context has different requirements for how the graph is accessed and kept current. A local agent reading its own graph doesn't need a git clone. An instance receiving task updates from a peer needs either clone access or bundled content. The current system tracks metadata (commit hashes, file counts) but never fetches actual graph content from remote sources.

Additionally, the codebase has **two overlapping task systems** — the coordination module (`src/coordination/`) with its own DB-backed `coordination_tasks` table, and the OpenTasks graph system. This creates ambiguity about which system is authoritative. Decision D5 resolves this: OpenTasks is the single task system going forward.

### Design Principles

1. **Git remains source of truth** — OpenHive coordinates; it doesn't replace the git workflow
2. **No mandatory clone** — local reads should not require cloning what's already on the filesystem
3. **Configurable per-resource** — sync strategy is set at the resource level, not globally
4. **Progressive enhancement** — start with metadata-only (current behavior), opt into richer sync
5. **Leverage existing primitives** — build on the resource system, MAP events, and sync protocol already in place
6. **One task system** — all task functionality routes through OpenTasks; the coordination module is deprecated

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

All methods accept an `OpenTasksResourceTarget` to identify which resource to query. Agents can target by:

| Field | Priority | Identity Source | Stable Across Instances |
|-------|----------|-----------------|------------------------|
| `resource_id` | 1 (highest) | OpenHive DB (`res_xxx`) | No |
| `path` | 2 | Local filesystem path | No |
| `location_hash` | 3 | `.opentasks/config.json` | Yes |

The `location_hash` is the canonical OpenTasks identity — derived from the graph's `config.json` and stable across machines and OpenHive instances. When `path` is used and no matching resource exists, the handler auto-registers the resource for the requesting agent.

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

### 7. Coordination Module (`src/coordination/`) — TO BE DEPRECATED

The coordination module provides DB-backed inter-swarm task delegation, messaging, and context sharing. It is deeply integrated:

| Component | Files |
|-----------|-------|
| Service | `src/coordination/service.ts` (singleton `CoordinationService`) |
| Types | `src/coordination/types.ts` (wire format + domain models) |
| Listener | `src/coordination/listener.ts` (JSON-RPC dispatch) |
| Schema | `src/coordination/schema.ts` (3 tables: `coordination_tasks`, `swarm_messages`, `shared_contexts`) |
| DAL | `src/db/dal/coordination.ts` (CRUD operations) |
| Routes | `src/api/routes/coordination.ts` (10 REST endpoints) |
| Sync hooks | `src/sync/coordination-hooks.ts` (cross-instance sync) |
| MAP handlers | `src/map/ws-map.ts`, `src/map/sync-listener.ts` |
| SDK client | `src/map/sync-client.ts` (emit/handle methods) |
| Shared types | `src/shared/types/map-coordination.ts`, `packages/openhive-types/src/map-coordination.ts` |

**Why deprecate**: The coordination task system (`coordination_tasks` table) and the OpenTasks graph system solve overlapping problems — task assignment, status tracking, and cross-swarm delegation. Having both creates ambiguity about which system is authoritative. OpenTasks is the richer, more capable system (DAG dependencies, git-backed persistence, merge resolution), so all task functionality should route through it.

**What to preserve**: The messaging (`swarm_messages`) and context sharing (`shared_contexts`) functionality from the coordination module does not overlap with OpenTasks and will be retained as standalone modules.

### 8. Test Coverage

| Test File | Coverage |
|-----------|----------|
| `src/__tests__/opentasks/e2e.test.ts` | Full integration: daemon, client, content API, discovery, JSONL fallback (~768 lines) |
| `src/__tests__/opentasks/client.test.ts` | JSONL parsing, graph summaries, ready computation, edge cases (~498 lines) |
| `src/__tests__/discovery.test.ts` | `.opentasks/` detection, metadata extraction, scopes, idempotency (~284 lines) |
| `src/__tests__/map/opentasks-handler.test.ts` | MAP method dispatch, access control, error handling |
| `src/__tests__/routes/opentasks-content.test.ts` | Content endpoint response shapes, query params, JSONL fallback |
| `src/__tests__/coordination/coordination.test.ts` | Coordination service, listeners, notifications |
| `src/__tests__/coordination/e2e.test.ts` | End-to-end coordination flows |
| `src/__tests__/coordination/cross-instance.test.ts` | Cross-instance coordination sync |

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

Add columns to `syncable_resources`:

```sql
ALTER TABLE syncable_resources
  ADD COLUMN sync_strategy TEXT DEFAULT 'metadata'
    CHECK(sync_strategy IN ('metadata', 'local', 'ls-remote', 'mirror', 'bundle'));

ALTER TABLE syncable_resources ADD COLUMN local_path TEXT;
```

- `sync_strategy` determines content acquisition behavior
- `local_path` points to the local filesystem clone/read path
  - For locally-discovered resources: stays `NULL` (they already have `git_remote_url` pointing at the local filesystem)
  - For federated resources that get cloned: absolute path to the clone directory

Clone paths and local metadata stored in the existing `metadata` JSON column where needed.

### Storage Layout

Cloned resources live under a managed data directory:

```
./data/resources/<resource_id>/    ← git repo root = opentasks dir
├── .git/
├── graph.jsonl
├── config.json
└── daemon.sock                    ← never exists for clones (no local daemon)
```

Using `resource_id` as the directory name because:
- Unique per instance (no collision)
- Maps directly to existing DAL lookups
- Cleanup on unsubscribe/unpublish is straightforward

### SyncProvider Interface (Decision D4)

New module: `src/sync/providers/`

```typescript
/**
 * Common interface for all sync strategies.
 * Each strategy implements this interface; the sync orchestrator
 * dispatches to the appropriate provider based on resource.sync_strategy.
 */
export interface SyncProvider {
  readonly strategy: SyncStrategy;

  /**
   * Called when a resource_synced event arrives for a resource using this strategy.
   * Returns true if local content was updated.
   */
  onSyncEvent(resource: SyncableResource, commitHash: string): Promise<boolean>;

  /**
   * Ensure content is available locally for reading.
   * For eager strategies (mirror), this is a no-op.
   * For lazy strategies (ls-remote), this triggers clone/fetch if stale.
   * For metadata-only, this returns null (content not available).
   */
  ensureContent(resource: SyncableResource): Promise<string | null>;

  /**
   * Resolve the local filesystem path to the graph content.
   * Returns null if content is not available locally.
   */
  resolveGraphPath(resource: SyncableResource): Promise<string | null>;

  /**
   * Clean up any local state (clones, caches) for this resource.
   */
  cleanup(resource: SyncableResource): Promise<void>;
}

export type SyncStrategy = 'metadata' | 'local' | 'ls-remote' | 'mirror' | 'bundle';
```

**Provider implementations:**

| File | Strategy | Key Behavior |
|------|----------|-------------|
| `src/sync/providers/metadata.ts` | `metadata` | No-op for content; returns null from `ensureContent()` |
| `src/sync/providers/local.ts` | `local` | Reads directly from `local_path`; compares mtime/HEAD on heartbeat |
| `src/sync/providers/ls-remote.ts` | `ls-remote` | Lazy clone on first `ensureContent()`; staleness via `git ls-remote` |
| `src/sync/providers/mirror.ts` | `mirror` | Eager fetch on `onSyncEvent()`; always-fresh reads |
| `src/sync/providers/bundle.ts` | `bundle` | Receive/apply git bundles via JSON-RPC; no shared remote needed |
| `src/sync/providers/index.ts` | — | Registry: `getProvider(strategy) → SyncProvider` |

The **sync orchestrator** (`src/sync/sync-orchestrator.ts`) replaces direct git calls in the materializer and content API:

```typescript
export class SyncOrchestrator {
  private providers: Map<SyncStrategy, SyncProvider>;

  /** Called by materializer when resource_synced arrives */
  async handleSyncEvent(resource: SyncableResource, commitHash: string): Promise<void> {
    const provider = this.getProvider(resource.sync_strategy);
    const updated = await provider.onSyncEvent(resource, commitHash);
    if (updated) {
      broadcastToChannel(`resource:task:${resource.id}`, { type: 'content_updated' });
    }
  }

  /** Called by content API before reading graph data */
  async ensureContent(resource: SyncableResource): Promise<string | null> {
    const provider = this.getProvider(resource.sync_strategy);
    return provider.ensureContent(resource);
  }

  /** Called on unsubscribe/unpublish */
  async cleanup(resource: SyncableResource): Promise<void> {
    const provider = this.getProvider(resource.sync_strategy);
    return provider.cleanup(resource);
  }
}
```

### Git Operations Layer

Each provider that needs git uses a shared utility: `src/sync/git-content.ts`

```typescript
export interface GitContentManager {
  /** Check if remote has new commits (cheap, no disk I/O) */
  checkFreshness(resource: SyncableResource): Promise<{
    stale: boolean;
    remoteHead: string | null;
    localHead: string | null;
  }>;

  /** Clone or fetch depending on whether local clone exists */
  ensureClone(resource: SyncableResource): Promise<string>; // returns clone path

  /** Fetch latest from remote into existing clone */
  fetchLatest(resource: SyncableResource): Promise<{
    previousHead: string;
    newHead: string;
    changed: boolean;
  }>;

  /** Apply a received git bundle to local clone */
  applyBundle(resource: SyncableResource, bundleBytes: Buffer): Promise<{
    previousHead: string;
    newHead: string;
  }>;

  /** Create a delta bundle for sending to peers */
  createBundle(resource: SyncableResource, sinceCommit: string): Promise<Buffer>;

  /** Read file content from clone or local path (strategy-aware) */
  readFile(resource: SyncableResource, filePath: string): Promise<string | null>;

  /** Get the effective graph.jsonl path for an OpenTasks resource */
  resolveGraphPath(resource: SyncableResource): Promise<string | null>;
}
```

Implementation uses `child_process.execFile('git', [...])` — same approach as the existing `src/utils/git-remote.ts`.

**Conflict resolution**: When `mirror` strategy encounters concurrent modifications (e.g., two instances both push to the same graph), the `opentasks` package's merge resolution utility is used. JSONL append-only format makes conflicts unlikely in practice, but when they occur, the utility handles 3-way merge at the graph semantic level rather than raw text merge.

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
  → syncOrchestrator.handleSyncEvent(resource, commitHash)
      │
      ├─ [MetadataProvider]  → no-op (current behavior)
      ├─ [LocalProvider]     → no-op (filesystem is source of truth)
      ├─ [LsRemoteProvider]  → mark stale (set stale_since in metadata)
      ├─ [MirrorProvider]    → gitContent.fetchLatest(resource) + merge if needed
      └─ [BundleProvider]    → gitContent.createBundle() + attach to sync event
  │
  → onResourceSynced() — mesh sync to peers
  → broadcastToChannel() — WebSocket to frontend
  → relaySyncMessage() — forward to subscribed swarms
```

### Clone-on-Subscribe Hook

When an agent subscribes to a federated `task` resource that has a remote `git_remote_url` and no `local_path`:
1. Trigger an async clone via the sync provider
2. On success, update the resource's `local_path` in the DB
3. The content API endpoints now work because `resolveLocalPath()` finds the `local_path`

This is **async / non-blocking** — the subscribe response returns immediately, and the clone happens in the background. A `resource_cloning` → `resource_cloned` event pair on WebSocket lets the agent know when it's ready.

### MAP Heartbeat Integration

The MAP heartbeat (periodic health check in `src/sync/service.ts`) drives staleness detection for `local` strategy resources:

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

### Swarm Notification: Push vs Poll

**Option A: Relay via existing `relaySyncMessage()`** (recommended for Phase 1)

Already implemented. When `resource_synced` fires, `relaySyncMessage()` forwards to all subscribed swarms. Zero new protocol surface.

**Option B: New `map/opentasks/changed` notification** (Phase 5)

Richer notification with diff summary — avoids round-trip of swarms querying back:

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
      "ready_count": 5
    }
  }
}
```

Requires content access (only possible for `local`, `mirror`, and `bundle` strategies).

### Using `git ls-remote` for Lightweight Polling

The existing `checkRemoteForUpdates()` in `src/utils/git-remote.ts` already implements a three-tier strategy:

1. **GitHub API** — `GET /repos/{owner}/{repo}/commits/{branch}` (~100ms)
2. **GitLab API** — `GET /api/v4/projects/{id}/repository/commits` (~100ms)
3. **`git ls-remote`** — fallback for any git host (~50ms, no disk I/O)

For `ls-remote` strategy resources, this is the staleness check.

### Git Bundle for Mesh Transport

For `bundle` strategy, content flows through the existing sync protocol without requiring shared git credentials:

**Source instance (on commit detected):**
```bash
git bundle create delta.bundle <last_known_peer_hash>..HEAD -- .opentasks/
```

**Transport** (recommended: out-of-band transfer):
```jsonc
// Receiving instance → source instance
{ "method": "sync/resource_bundle", "params": { "resource_id": "res_abc", "since_commit": "def456" } }

// Source instance → receiving instance
{ "result": { "bundle_base64": "...", "from_commit": "def456", "to_commit": "abc123" } }
```

**Receiving instance:**
```bash
git bundle unbundle delta.bundle  # applies to local bare repo
```

---

## Task Graph UI (Decision D3)

### Approach

Follow the SwarmCraft embed pattern: a self-contained React component using **sigma.js** with **graphology** for DAG rendering. The component is embedded in the OpenHive frontend the same way SwarmCraft is — as a page-level embed with its own config derivation.

### Component Architecture

```
src/web/
├── pages/
│   └── TaskGraph.tsx              ← Page wrapper (like SwarmCraft.tsx)
├── components/
│   └── task-graph/
│       ├── TaskGraphViewer.tsx     ← Main component: sigma.js canvas + controls
│       ├── TaskGraphLayout.tsx     ← DAG layout computation (dagre/elk)
│       ├── TaskNodeRenderer.tsx    ← Custom node rendering (status colors, icons)
│       ├── TaskEdgeRenderer.tsx    ← Dependency edge rendering
│       ├── TaskGraphFilters.tsx    ← Filter panel (status, type, search)
│       ├── TaskGraphSidebar.tsx    ← Node detail panel (click to inspect)
│       └── useTaskGraph.ts         ← Hook: fetch graph data, WebSocket updates
```

### Data Flow

```
Content API: GET /api/v1/resources/:id/content/opentasks/tasks
  → Returns all nodes + edges
  → useTaskGraph() transforms to graphology Graph instance
  → sigma.js renders with custom node/edge programs

WebSocket: resource:task:{id} channel
  → On content_updated event → re-fetch and diff
  → Animate node/edge additions/removals
```

### Visual Design

| Node Status | Color | Shape |
|-------------|-------|-------|
| `open` | Gray | Circle |
| `in_progress` | Blue | Circle (pulsing) |
| `blocked` | Red | Circle (dashed border) |
| `completed` | Green | Circle (checkmark) |
| `failed` | Red | Circle (X mark) |

| Node Type | Icon |
|-----------|------|
| `task` | Checkbox |
| `milestone` | Diamond |
| `note` | Document |

Edges show dependency direction. Hover reveals edge label (dependency type). Click a node to open the sidebar with full details, status history, and blocking relationships.

### Route Registration

```typescript
// src/web/router.tsx
{ path: '/tasks/:resourceId', element: <TaskGraph /> }
```

The Resources page links to this view for any resource with `metadata.opentasks: true`.

---

## Coordination Module Deprecation Plan (Decision D5)

### What Gets Deprecated

The **task delegation** functionality in `src/coordination/`:

| Current (Coordination) | Replacement (OpenTasks) |
|------------------------|------------------------|
| `coordination_tasks` table | OpenTasks `graph.jsonl` nodes |
| `x-openhive/task.assign` wire method | `map/opentasks/assign` (new) |
| `x-openhive/task.status` wire method | `map/opentasks/status-update` (new) |
| `CoordinationService.assignTask()` | OpenTasks graph mutation via daemon or JSONL append |
| `CoordinationService.updateTaskStatus()` | OpenTasks node status update |
| REST `POST /coordination/tasks` | `POST /resources/:id/content/opentasks/tasks` (new mutation endpoint) |
| REST `PATCH /coordination/tasks/:id` | `PATCH /resources/:id/content/opentasks/tasks/:nodeId` (new) |

### What Gets Preserved (moved to standalone modules)

| Module | Current Location | New Location |
|--------|-----------------|-------------|
| Swarm messaging | `src/coordination/` (messages) | `src/messaging/` (new module) |
| Shared contexts | `src/coordination/` (contexts) | `src/contexts/` (new module) |
| `swarm_messages` table | `src/coordination/schema.ts` | `src/messaging/schema.ts` |
| `shared_contexts` table | `src/coordination/schema.ts` | `src/contexts/schema.ts` |

### Migration Strategy

The deprecation is **incremental**, not a flag-day replacement:

1. **Phase 1**: Add `@deprecated` JSDoc annotations to all coordination task methods. Add deprecation warnings to REST endpoints.
2. **Phase 2**: Implement OpenTasks mutation endpoints (assign, status update) that write to `graph.jsonl` instead of `coordination_tasks`.
3. **Phase 3**: Add a compatibility shim that translates `x-openhive/task.assign` wire messages into OpenTasks graph mutations. Existing swarms continue to work without changes.
4. **Phase 4**: Extract messaging and contexts into standalone modules. Update all imports.
5. **Phase 5**: Remove `coordination_tasks` table, `CoordinationService` task methods, and coordination task REST endpoints. Remove compatibility shim.

### Cross-Instance Task Delegation via OpenTasks

Currently, coordination tasks sync across instances via `coordination-hooks.ts` → `onCoordinationTaskOffered()` → sync events. The replacement:

```
Agent A assigns task to Swarm B:
  → Append task node to graph.jsonl with assigned_to metadata
  → Git commit + push
  → resource_synced event propagates via mesh sync
  → Instance B's mirror/ls-remote provider fetches updated graph
  → Instance B sees new assigned task via content API or MAP query
  → Swarm B picks it up via map/opentasks/ready
```

This is simpler than the current flow (no separate DB table, no separate wire protocol, no separate sync hooks) and naturally leverages the sync strategy infrastructure.

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
},

resourceStorage: {
  dataDir: './data/resources',           // base directory for cloned resource data
  autoClone: true,                       // auto-clone federated resources on subscribe
},
```

---

## Implementation Plan

### Phase 1: Schema + Local Strategy + SyncProvider Foundation

**Goal**: Unblock local reads, establish the provider pattern, consolidate content API.

| Step | File(s) | Description |
|------|---------|-------------|
| 1.1 | `src/db/schema.ts` | Add migration: `sync_strategy` and `local_path` columns on `syncable_resources` |
| 1.2 | `src/types.ts` | Add `sync_strategy` and `local_path` to `SyncableResource` type |
| 1.3 | `src/db/dal/syncable-resources.ts` | Read/write `sync_strategy` and `local_path`; add `updateLocalPath()`, `updateSyncStrategy()` |
| 1.4 | `src/config.ts` | Add `resourceSync` and `resourceStorage` config sections |
| 1.5 | `src/sync/providers/types.ts` | `SyncProvider` interface + `SyncStrategy` type |
| 1.6 | `src/sync/providers/metadata.ts` | MetadataProvider (no-op content, current behavior) |
| 1.7 | `src/sync/providers/local.ts` | LocalProvider (direct filesystem reads) |
| 1.8 | `src/sync/providers/index.ts` | Provider registry |
| 1.9 | `src/sync/sync-orchestrator.ts` | SyncOrchestrator dispatching to providers |
| 1.10 | `src/discovery/index.ts` | Set `sync_strategy: 'local'` + `local_path` for discovered resources |
| 1.11 | `src/api/routes/resource-content.ts` | Update `resolveLocalPath()` to use `local_path` field first, then fall back to `git_remote_url` |
| 1.12 | Tests | Unit tests for providers, orchestrator, updated content API |

### Phase 2: ls-remote + mirror Strategies (federated content)

**Goal**: Make federated task resources queryable via lazy or eager clone.

| Step | File(s) | Description |
|------|---------|-------------|
| 2.1 | `src/sync/git-content.ts` | GitContentManager: `ensureClone()`, `fetchLatest()`, `checkFreshness()`, `resolveGraphPath()` |
| 2.2 | `src/sync/providers/ls-remote.ts` | LsRemoteProvider: lazy clone on `ensureContent()`, staleness tracking |
| 2.3 | `src/sync/providers/mirror.ts` | MirrorProvider: eager fetch on `onSyncEvent()`, always-fresh reads |
| 2.4 | `src/sync/materializer.ts` | Hook `syncOrchestrator.handleSyncEvent()` into `materializeResourceSynced()` |
| 2.5 | `src/api/routes/resources.ts` | Clone-on-subscribe hook (async, non-blocking) |
| 2.6 | `src/sync/service.ts` | MAP heartbeat integration for local strategy staleness detection |
| 2.7 | Cleanup | `materializeResourceUnpublished()` calls `syncOrchestrator.cleanup()` |
| 2.8 | Tests | Integration tests: clone lifecycle, staleness, subscribe-triggers-clone |

### Phase 3: Coordination Deprecation — Task Migration

**Goal**: Route all task functionality through OpenTasks; deprecate coordination tasks.

| Step | File(s) | Description |
|------|---------|-------------|
| 3.1 | `src/coordination/service.ts` | Add `@deprecated` to `assignTask()`, `updateTaskStatus()`, `getTask()`, `listTasks()` |
| 3.2 | `src/api/routes/coordination.ts` | Add deprecation warning headers to task endpoints |
| 3.3 | `src/api/routes/resource-content.ts` | Add mutation endpoints: `POST .../opentasks/tasks` (create node), `PATCH .../opentasks/tasks/:nodeId` (update status) |
| 3.4 | `src/map/opentasks-handler.ts` | Add `map/opentasks/assign` and `map/opentasks/status-update` methods |
| 3.5 | `src/coordination/compat.ts` | Compatibility shim: translate `x-openhive/task.assign` → OpenTasks mutation |
| 3.6 | Tests | Migration tests: verify old wire format still works via shim |

### Phase 4: Coordination Deprecation — Extract Messaging + Contexts

**Goal**: Preserve messaging and contexts as standalone modules; remove coordination task code.

| Step | File(s) | Description |
|------|---------|-------------|
| 4.1 | `src/messaging/` | Extract `SwarmMessage` types, DAL, service methods, routes from coordination |
| 4.2 | `src/contexts/` | Extract `SharedContext` types, DAL, service methods, routes from coordination |
| 4.3 | `src/coordination/` | Remove task-related code (keep as thin re-export shim during transition) |
| 4.4 | Update imports | All files importing coordination task types → import from OpenTasks or messaging/contexts |
| 4.5 | `src/db/schema.ts` | Migration to drop `coordination_tasks` table |
| 4.6 | Tests | Update all coordination tests to use new module locations |

### Phase 5: Task Graph UI

**Goal**: Visual task graph viewer in the frontend.

| Step | File(s) | Description |
|------|---------|-------------|
| 5.1 | `package.json` | Add `sigma`, `graphology`, `graphology-layout-dagre` dependencies |
| 5.2 | `src/web/components/task-graph/useTaskGraph.ts` | Hook: fetch graph data from content API, WebSocket subscription |
| 5.3 | `src/web/components/task-graph/TaskGraphViewer.tsx` | Main sigma.js canvas + controls |
| 5.4 | `src/web/components/task-graph/TaskGraphLayout.tsx` | DAG layout computation |
| 5.5 | `src/web/components/task-graph/TaskNodeRenderer.tsx` | Custom node rendering (status colors) |
| 5.6 | `src/web/components/task-graph/TaskGraphSidebar.tsx` | Node detail panel |
| 5.7 | `src/web/pages/TaskGraph.tsx` | Page wrapper (follows SwarmCraft pattern) |
| 5.8 | `src/web/router.tsx` | Add `/tasks/:resourceId` route |
| 5.9 | Tests | Component tests for graph rendering, filter interactions |

### Phase 6: Bundle Strategy + Rich Notifications

**Goal**: Mesh-native content transport, richer swarm notifications.

| Step | File(s) | Description |
|------|---------|-------------|
| 6.1 | `src/sync/git-content.ts` | Add `createBundle()` and `applyBundle()` |
| 6.2 | `src/sync/providers/bundle.ts` | BundleProvider implementation |
| 6.3 | Sync protocol | Add `sync/resource_bundle` JSON-RPC method |
| 6.4 | `src/map/opentasks-handler.ts` | Add `map/opentasks/changed` notification with diff summary |
| 6.5 | Tests | Bundle round-trip tests, notification tests |

---

## Federated Sync Sequence Diagram

```
Instance A                          Instance B
    |                                   |
    |-- resource_published (task) ----->|
    |                                   | materializeResourcePublished()
    |                                   |   → creates syncable_resources row
    |                                   |     (origin_instance_id = A, sync_strategy = 'metadata')
    |                                   |
    |                          Agent Y subscribes to resource
    |                                   |
    |                                   | POST /resources/:id/subscribe
    |                                   |   → strategy upgrade: metadata → ls-remote (or mirror)
    |                                   |   → triggers async clone via SyncOrchestrator
    |                                   |
    |<--- git clone (from A's URL) ----|
    |                                   |
    |                                   | Clone complete:
    |                                   |   → local_path = ./data/resources/res_xyz/
    |                                   |   → WS: resource_cloned event
    |                                   |
    |                          Agent Y queries tasks:
    |                          GET /resources/:id/content/opentasks/tasks
    |                                   |   → SyncOrchestrator.ensureContent()
    |                                   |   → LsRemoteProvider returns clone path
    |                                   |   → OpenHiveOpenTasksClient reads local graph.jsonl
    |                                   |
    |-- resource_synced (new commit) -->|
    |                                   | materializeResourceSynced()
    |                                   |   → SyncOrchestrator.handleSyncEvent()
    |                                   |   → [mirror] fetchLatest() + merge
    |                                   |   → [ls-remote] mark stale
    |                                   |   → WS: resource_updated / content_updated
```

---

## Relationship to Existing Systems

### OpenTasks Graph vs. MAP Task Store

| | OpenTasks Graph | MAP Task Store |
|-|-----------------|---------------|
| **Storage** | File-backed (JSONL) | In-memory |
| **Persistence** | Survives restarts | Lost on restart |
| **Purpose** | Agent's own task tracking | Real-time swarm coordination |
| **Query** | Via daemon IPC or JSONL parse | Via MAP JSON-RPC methods |

The MAP task store remains as ephemeral "right now" coordination. The OpenTasks graph is the durable record.

### Resource Sync Protocol

OpenTasks resources use the same `syncable_resources` infrastructure as memory banks and skills:

- Same `resource_published` / `resource_updated` / `resource_synced` events
- Same subscription and access control model
- Same WebSocket broadcast channels (`resource:task:{id}`)
- Same cross-instance materialization path

The OpenTasks-specific additions are:
1. Content API endpoints (`/content/opentasks/*`)
2. MAP handler methods (`map/opentasks/*`)
3. Discovery integration (`.opentasks/` directory detection)
4. The sync strategy / SyncProvider layer
5. Task graph UI (sigma.js viewer)

---

## Resolved Open Questions

1. **Clone storage limits** — Deferred. Start without caps; add `maxTotalBytes` / `maxPerResourceBytes` config when usage data is available. JSONL graphs are small; this is unlikely to be a problem in practice.

2. **Bundle size limits** — 10MB default cap (`resourceSync.bundleMaxSize`). Git objects are already compressed; gzip on top adds minimal benefit. Paginated bundles are out of scope.

3. **Daemon affinity** — No. Cloned resources always use JSONL parsing fallback. The `OpenHiveOpenTasksClient` already handles this gracefully. Starting a daemon per clone adds complexity with little benefit.

4. **Partial sync** — No. Bundle strategy syncs the full `.opentasks/` directory. OpenTasks-aware filtering would require tight coupling to the graph schema.

5. **Conflict resolution** — Use the `opentasks` npm package's merge resolution utility. JSONL append-only format makes conflicts rare; when they occur, graph-level semantic merge is applied. This is handled inside the MirrorProvider.

6. **Strategy upgrade notifications** — Deferred. Not needed for initial release; can be added as an audit log entry later.

7. **Coordination module overlap** — Resolved: deprecate coordination tasks (D5). Messaging and contexts are extracted to standalone modules.

---

## Future Work (beyond current phases)

### Git Endpoint for Serving Repos

For fully self-contained instances with no external git host:
- **Option A: Smart HTTP git transport** — Implement git-upload-pack/git-receive-pack. Complex but self-contained.
- **Option B: Redirect to actual git remote** — Simpler; requires the git host to be accessible from the receiving instance.

Recommendation: Option B first, Option A as enhancement.

### Auth for Cloning

- Public repos: no auth needed
- GitHub/Gitea PAT: embedded in resource metadata or provided via config
- Instance-served repos: use sync group pre-auth keys

### Write-Back

When Agent Y on Instance B modifies a cloned task graph, push options:
- **Direct git push**: simpler but bypasses Instance A's access control
- **Route through Instance A's API**: respects access control but requires mutation API

### Read-Only Daemon for Clones

Optional: start a read-only OpenTasks daemon for cloned resources to enable richer queries. The client already supports both modes, so this would be transparent.

### Clone All Resource Types

The SyncProvider design works for memory banks and skills too — extending to other types is a config flag, not an architecture change.
