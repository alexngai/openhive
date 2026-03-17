# Plan: Local Materialization of Federated OpenTasks Resources

## Context

When Instance B receives a `resource_published` event for a `task` resource from Instance A, the current materializer creates a `syncable_resources` row with `origin_instance_id` and `origin_resource_id` set — but the `git_remote_url` still points to Instance A's URL. There is no local clone. The content API endpoints (`/resources/:id/content/opentasks/*`) only work for local filesystem paths (see `resolveLocalPath()` in `resource-content.ts:23-31` — returns `null` for `http`/`git`/`ssh` URLs). This means **federated task resources are metadata-only** — you can see they exist, but you can't query their tasks.

## Goal

When an agent subscribes to a federated `task` resource (or when one is materialized from a remote instance), OpenHive should:
1. Clone the git repo backing that resource to local managed storage
2. Keep it synced (pull on `resource_synced` events, periodic polling)
3. Make the existing content API endpoints work against the local clone
4. Optionally allow write-back (push) for agents with `write`/`admin` permission

## Immediate Scope

The sync flow (sections 4–6 below): clone-on-subscribe, pull-on-sync-event, and the content API `resolveLocalPath()` change. These are the minimal pieces that make federated task resources queryable.

---

## Design

### 1. Storage Layout

The git repo root for an OpenTasks store **is** the `.opentasks/` directory itself (that's what discovery registers as `git_remote_url`, and what the `OpenHiveOpenTasksClient` constructor receives). Clones go directly into the resource directory — no extra nesting:

```
./data/resources/<resource_id>/    ← git repo root = opentasks dir
├── .git/
├── graph.jsonl
├── config.json
└── daemon.sock                    ← never exists for clones (no local daemon)
```

`local_path` points here. The `OpenHiveOpenTasksClient` takes this path directly. The client already handles the no-daemon case gracefully: `connectDaemon()` returns `false`, all queries fall back to JSONL parsing.

Using `resource_id` (the local ID, e.g. `res_abc123`) as the directory name because:
- Unique per instance (no collision)
- Maps directly to existing DAL lookups
- Cleanup on unsubscribe/unpublish is straightforward

### 2. Config

```ts
// in config.ts, inside the config schema
resourceStorage: z.object({
  /** Base directory for cloned/managed resource data */
  dataDir: z.string().default('./data/resources'),
  /** Auto-clone federated resources on subscribe (if false, require explicit sync trigger) */
  autoClone: z.boolean().default(true),
}).default({}),
```

Follows the existing pattern (`swarmHosting.data_dir` → `./data/swarms`, `headscale.dataDir` → `./data/headscale`). Disk quotas and pull intervals are real concerns but can be added later without schema changes — the config object is extensible.

### 3. Schema Changes

Add a `local_path` column to `syncable_resources`:

```sql
ALTER TABLE syncable_resources ADD COLUMN local_path TEXT;
```

- For locally-discovered resources: `local_path` stays `NULL` (they already have `git_remote_url` pointing at the local filesystem)
- For federated resources that get cloned: `local_path` = the resolved absolute path to the clone
- `resolveLocalPath()` in `resource-content.ts` checks `local_path` first, falls back to `git_remote_url`

### 4. Git Clone/Sync Service

New file: `src/resources/git-sync.ts`

```ts
export interface CloneOptions {
  resourceId: string;
  gitRemoteUrl: string;
  branch?: string;  // default: 'main'
  authToken?: string;  // for authenticated access to remote instance
}

export interface GitSyncService {
  /** Clone a remote resource repo to local storage. Returns local path. */
  cloneResource(options: CloneOptions): Promise<string>;

  /** Pull latest changes for a cloned resource */
  pullResource(resourceId: string): Promise<{ updated: boolean; commitHash: string }>;

  /** Push local changes back to remote (for write-permitted agents) */
  pushResource(resourceId: string): Promise<void>;

  /** Remove a local clone (on unsubscribe/unpublish) */
  removeClone(resourceId: string): Promise<void>;

  /** Get the local path for a cloned resource */
  getLocalPath(resourceId: string): string | null;
}
```

Implementation uses `child_process.execFile('git', [...])` — same approach as the existing `src/utils/git-remote.ts` which already shells out to git for `ls-remote`.

### 5. Clone-on-Subscribe Hook

Modify `POST /resources/:id/subscribe` in `resources.ts`:

When an agent subscribes to a federated `task` resource that has a remote `git_remote_url` and no `local_path`:
1. Trigger an async clone via the `GitSyncService`
2. On success, update the resource's `local_path` in the DB
3. The content API endpoints now work because `resolveLocalPath()` finds the `local_path`

This is **async / non-blocking** — the subscribe response returns immediately, and the clone happens in the background. A `resource_cloning` → `resource_cloned` event pair on WebSocket lets the agent know when it's ready.

If the resource is already cloned (`local_path IS NOT NULL`), skip the clone — just create the subscription.

### 6. Sync-on-Event Hook

Modify `materializeResourceSynced()` in `materializer.ts`:

When a `resource_synced` event arrives for a resource that has a `local_path`:
1. Call `gitSyncService.pullResource(resourceId)`
2. Update `last_commit_hash` in the DB
3. Broadcast `resource_updated` on WebSocket

If `local_path` is NULL (nobody subscribed locally, no clone exists), no-op — keeps the existing metadata-only behavior.

### 7. Content API Changes

Modify `resolveLocalPath()` in `resource-content.ts`:

```ts
function resolveLocalPath(resource: SyncableResource): string | null {
  // Check local_path first (set by clone-on-subscribe)
  if (resource.local_path) {
    return resolve(resource.local_path);
  }
  // Fall back to git_remote_url if it's a local filesystem path
  const url = resource.git_remote_url;
  for (const prefix of REMOTE_URL_PREFIXES) {
    if (url.startsWith(prefix)) return null;
  }
  return resolve(url);
}
```

No other content API changes needed — the OpenTasks client already works against any local directory.

### 8. Cleanup

- `materializeResourceUnpublished()`: call `gitSyncService.removeClone(resourceId)` before deleting the DB row
- Startup: verify each `local_path` still exists on disk, clear stale values

Cleanup-on-last-unsubscribe is deferred — keeping clones around avoids re-cloning if someone re-subscribes, and the storage cost is low for JSONL-based graphs.

### 9. Clone Failure Handling

When a clone fails (network error, auth required, disk full):
- Subscribe still succeeds (subscription = access grant, not data availability)
- `local_path` stays `NULL`
- Content API returns the existing "Resource does not point to a local filesystem path" error
- Retry path: an explicit `POST /resources/:id/sync` endpoint to re-trigger the clone

---

## Scenarios

| # | Scenario | Behavior |
|---|----------|----------|
| 1 | **Fresh subscribe to federated task resource** | Clone triggers async, `local_path` set on success, WS event emitted |
| 2 | **Resource already cloned, another agent subscribes** | `local_path` already set → skip clone, create subscription only |
| 3 | **`resource_synced` event arrives** | If `local_path` set → `git pull`. If NULL → no-op |
| 4 | **Last subscriber unsubscribes** | Keep clone around (lazy cleanup). `local_path` persists |
| 5 | **`resource_unpublished` event arrives** | Delete clone, set `local_path = NULL`, delete DB row |
| 6 | **OpenHive restarts** | Clones persist on disk, `local_path` in DB → works immediately |
| 7 | **Clone fails** | Subscribe succeeds, `local_path` stays NULL, manual retry via sync endpoint |

---

## Sequence Diagram

```
Instance A                          Instance B
    |                                   |
    |-- resource_published (task) ----->|
    |                                   | materializeResourcePublished()
    |                                   |   → creates syncable_resources row
    |                                   |     (origin_instance_id = A, git_remote_url = A's URL)
    |                                   |
    |                          Agent Y subscribes to resource
    |                                   |
    |                                   | POST /resources/:id/subscribe
    |                                   |   → triggers async clone
    |                                   |
    |<--- git clone (from A's URL) ----|
    |                                   |
    |                                   | Clone complete:
    |                                   |   → local_path = ./data/resources/res_xyz/
    |                                   |   → WS: resource_cloned event
    |                                   |
    |                          Agent Y queries tasks:
    |                          GET /resources/:id/content/opentasks/tasks
    |                                   |   → resolveLocalPath() finds local_path
    |                                   |   → OpenHiveOpenTasksClient reads local graph.jsonl
    |                                   |
    |-- resource_synced (new commit) -->|
    |                                   | materializeResourceSynced()
    |                                   |   → git pull in local clone
    |                                   |   → update last_commit_hash
    |                                   |   → WS: resource_updated
```

---

## Files to Create/Modify

### New files:
1. `src/resources/git-sync.ts` — GitSyncService implementation

### Modified files:
1. `src/config.ts` — Add `resourceStorage` config section
2. `src/db/schema.ts` — Add migration for `local_path` column
3. `src/types.ts` — Add `local_path` to `SyncableResource` type
4. `src/db/dal/syncable-resources.ts` — Read/write `local_path`, add `updateLocalPath()` function
5. `src/api/routes/resource-content.ts` — Update `resolveLocalPath()` to check `local_path`
6. `src/api/routes/resources.ts` — Hook into subscribe to trigger clone
7. `src/sync/materializer.ts` — Hook into `resource_synced` to trigger pull

---

## Future Work (not in immediate scope)

### Git Endpoint for Serving Repos

Currently Instance B clones from whatever URL is in `git_remote_url` (typically a GitHub/Gitea URL). For fully self-contained instances with no external git host, OpenHive would need to serve git repos itself:

- **Option A: Smart HTTP git transport** — Implement `/info/refs?service=git-upload-pack` and `/git-upload-pack`. Complex but fully self-contained.
- **Option B: Redirect to actual git remote** — Expose the `git_remote_url` + auth token to the cloning instance. Simpler but requires the git host to be accessible from Instance B.

Recommendation: Option B first (most resources have externally-hosted git repos), Option A as a later enhancement.

### Auth for Cloning

How Instance B authenticates when cloning:
- Public repos: no auth needed (works today)
- GitHub/Gitea PAT: embedded in resource metadata or provided via config
- Instance A's own git endpoint (Option A above): use sync group pre-auth keys

### Disk Quotas

```ts
// Future config additions
resourceStorage: z.object({
  // ...existing...
  maxTotalBytes: z.number().default(0),       // 0 = unlimited
  maxPerResourceBytes: z.number().default(0), // 0 = unlimited
  pullInterval: z.number().default(0),        // ms, 0 = sync-event-only
  cleanupOnUnsubscribe: z.boolean().default(false),
}).default({}),
```

### Write-Back

When Agent Y on Instance B modifies a cloned task graph, push options:
- **Direct git push**: simpler but bypasses Instance A's access control
- **Route through Instance A's API**: respects access control but requires API support for task mutations

### Read-Only Daemon for Clones

OpenHive could optionally start a read-only OpenTasks daemon for cloned resources to enable richer queries beyond JSONL parsing. The `OpenHiveOpenTasksClient` already supports both daemon and JSONL modes, so this would be transparent to the content API.

### Clone All Resource Types

The design works for memory banks and skills too — not just tasks. Extending to other types is a config flag, not an architecture change.
