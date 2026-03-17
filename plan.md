# Plan: Local Materialization of Federated OpenTasks Resources

## Context

When Instance B receives a `resource_published` event for a `task` resource from Instance A, the current materializer creates a `syncable_resources` row with `origin_instance_id` and `origin_resource_id` set — but the `git_remote_url` still points to Instance A's URL. There is no local clone. The content API endpoints (`/resources/:id/content/opentasks/*`) only work for local filesystem paths (see `resolveLocalPath()` in `resource-content.ts:23-31` — returns `null` for `http`/`git`/`ssh` URLs). This means **federated task resources are metadata-only** — you can see they exist, but you can't query their tasks.

## Goal

When an agent subscribes to a federated `task` resource (or when one is materialized from a remote instance), OpenHive should:
1. Clone the git repo backing that resource to local managed storage
2. Keep it synced (pull on `resource_synced` events, periodic polling)
3. Make the existing content API endpoints work against the local clone
4. Optionally allow write-back (push) for agents with `write`/`admin` permission

## Design

### 1. Storage Layout

Add a `resourceStorage` section to config (alongside existing `storage`):

```ts
// in config.ts, inside the config schema
resourceStorage: z.object({
  /** Base directory for cloned/managed resource data */
  dataDir: z.string().default('./data/resources'),
}).default({}),
```

Local clones live at:
```
<dataDir>/<resource_id>/
  └── .opentasks/         (or the resource content directly)
      ├── .git/
      ├── graph.jsonl
      └── config.json
```

Using `resource_id` (the local ID, e.g. `res_abc123`) as the directory name, not the origin instance/resource, because:
- It's unique per instance (no collision)
- It maps directly to the existing DAL lookups
- Cleanup on unsubscribe/unpublish is straightforward

### 2. Schema Changes

Add a `local_path` column to `syncable_resources`:

```sql
ALTER TABLE syncable_resources ADD COLUMN local_path TEXT;
```

- For locally-discovered resources: `local_path` stays `NULL` (they already have `git_remote_url` pointing at the local filesystem)
- For federated resources that get cloned: `local_path` = the resolved absolute path to the clone
- `resolveLocalPath()` in `resource-content.ts` checks `local_path` first, falls back to `git_remote_url`

### 3. Git Clone/Sync Service

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

### 4. Clone-on-Subscribe Hook

Modify `POST /resources/:id/subscribe` in `resources.ts`:

When an agent subscribes to a federated `task` resource that has a remote `git_remote_url` and no `local_path`:
1. Trigger an async clone via the `GitSyncService`
2. On success, update the resource's `local_path` in the DB
3. The content API endpoints now work because `resolveLocalPath()` finds the `local_path`

This should be **async / non-blocking** — the subscribe response returns immediately, and the clone happens in the background. A `resource_cloning` → `resource_cloned` event pair on WebSocket lets the agent know when it's ready.

### 5. Sync-on-Event Hook

Modify `materializeResourceSynced()` in `materializer.ts`:

When a `resource_synced` event arrives for a resource that has a `local_path`:
1. Call `gitSyncService.pullResource(resourceId)`
2. Update `last_commit_hash` in the DB
3. Broadcast `resource_updated` on WebSocket

This replaces the current behavior which only updates the commit hash metadata — now it actually pulls the content.

### 6. Content API Changes

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

### 7. Git Endpoint on OpenHive (for serving repos to other instances)

New route group: `POST /api/v1/resources/:id/git/*`

This is the counterpart — so that when Instance B clones from Instance A, there's an endpoint to clone from. Two options:

**Option A: Smart HTTP git transport** — Implement git's smart HTTP protocol (`/info/refs?service=git-upload-pack`, `/git-upload-pack`). This is complex but fully self-contained.

**Option B: Redirect to actual git remote** — If the resource's `git_remote_url` is a GitHub/Gitea URL, just tell the cloning instance to clone from there directly. OpenHive provides the URL + auth token. Simpler but requires the git host to be accessible from Instance B.

**Recommendation: Option B first**, with Option A as a future enhancement. Most resources will have their git repos hosted somewhere accessible. For fully self-contained instances (no external git host), we'd need Option A later.

For Option B, the clone URL is just the `git_remote_url` from the resource, exposed via the existing resource metadata API (already returned to subscribed agents with access).

### 8. Cleanup

- `materializeResourceUnpublished()`: call `gitSyncService.removeClone(resourceId)` before deleting the DB row
- `DELETE /resources/:id/subscribe` (unsubscribe): if no other subscribers remain, call `removeClone()`
- Startup: scan `<dataDir>` for orphaned clones (resource deleted but directory remains) and clean up

## Files to Create/Modify

### New files:
1. `src/resources/git-sync.ts` — GitSyncService implementation
2. `src/resources/types.ts` — Types for the service (or add to existing `types.ts`)

### Modified files:
1. `src/config.ts` — Add `resourceStorage.dataDir` config
2. `src/db/schema.ts` — Add migration for `local_path` column
3. `src/types.ts` — Add `local_path` to `SyncableResource` type
4. `src/db/dal/syncable-resources.ts` — Read/write `local_path`, add `updateLocalPath()` function
5. `src/api/routes/resource-content.ts` — Update `resolveLocalPath()` to check `local_path`
6. `src/api/routes/resources.ts` — Hook into subscribe to trigger clone
7. `src/sync/materializer.ts` — Hook into `resource_synced` to trigger pull
8. `src/discovery/index.ts` — No changes needed (local discovery doesn't use `local_path`)

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

## Open Questions

1. **Auth for cloning**: How does Instance B authenticate when cloning from Instance A's git URL? If it's a GitHub URL, maybe a PAT in the resource metadata. If it's Instance A's own git endpoint (Option A), use the sync group's pre-auth keys. For now, we can support unauthenticated (public repos) and URL-embedded credentials.

2. **Clone all resource types or just tasks?**: Memory banks and skills would also benefit from local clones. The design above works for any resource type — should we clone all subscribed federated resources, or only `task` type initially?

3. **Write-back**: When Agent Y on Instance B modifies a cloned task graph, should the push go directly to the git remote, or should it go through Instance A's API? Direct git push is simpler but bypasses Instance A's access control.

4. **Disk quotas**: Should there be a per-resource or global storage limit for clones? The config could include `resourceStorage.maxTotalSize` and `resourceStorage.maxPerResource`.
