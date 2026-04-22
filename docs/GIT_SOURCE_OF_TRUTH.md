# Git Source of Truth + MAP Signaling

## Problem (Pre-Implementation)

Before this architecture, OpenTasks graphs were local-only: each agent maintained its own `.opentasks/graph.jsonl` file on disk. When multiple instances or hives needed to coordinate on shared task graphs:

- **No automatic convergence**: Instance A could push changes to a git remote, but Instance B would not know or converge until manually fetching (or cron pulled).
- **No cross-hub signaling**: Peer hubs received `resource_synced` events but never fetched actual graph content. They tracked metadata (commit hash, count of nodes) but couldn't read tasks.
- **Manual workflow**: Agents had to coordinate pushes via messaging, not via the sync infrastructure.

## Architecture (Three Layers)

### Layer 1: Daemon Git Operations

**opentasks daemon** (`references/opentasks/`) handles all git work on `.opentasks/graph.jsonl`:

| Operation | Method | Trigger | Behavior |
|-----------|--------|---------|----------|
| **Commit** | `sync.commit()` | On every graph mutation | Auto-writes commit message with summary |
| **Push** | `sync.push()` | After commit (debounced) | Pushes committed changes to remote |
| **Pull** | `sync.pull()` | On startup, on signal, on cron | Fetches + merges from remote using opentasks merge resolution |
| **Merge** | (internal) | On pull conflict | Semantic 3-way merge at graph level, not raw text |
| **Config reload** | `sync.reload()` | IPC call from hub | Hot-swaps syncer without daemon restart |
| **Status check** | `sync.status()` | IPC query | Returns enabled, remote, last_pull, last_push, error (if any) |

**Configuration** (stored in `.opentasks/config.json`):

```json
{
  "sync": {
    "git": {
      "enabled": true,
      "remote": "origin",
      "autoCommit": true,
      "autoPush": true,
      "pullOnStartup": true,
      "pushDebounceMs": 2000
    }
  }
}
```

When disabled, all git operations are skipped. When enabled, defaults favor **live sync**: commits and pushes happen automatically on change, pulls happen on startup and on signal.

### Layer 2: Hub Resource Metadata + Hot-Reload

**OpenHive hub** stores a `metadata.git_sync` flag on task resources and provides a toggle surface:

```typescript
// Resource metadata shape
{
  git_sync: {
    enabled: boolean;
    remote?: string;
    autoCommit?: boolean;
    autoPush?: boolean;
    pullOnStartup?: boolean;
    pushDebounceMs?: number;
    pullOnSignal?: boolean; // OpenHive-specific: pull on peer MAP events
  }
}
```

**REST endpoint** (`PATCH /resources/:id/git-sync`):

```bash
PATCH /api/v1/resources/res_abc/git-sync
Content-Type: application/json

{
  "git_sync": {
    "enabled": true,
    "remote": "origin"
  }
}
```

**Response**:

```json
{
  "git_sync": { "enabled": true, "remote": "origin" },
  "daemon_applied": {
    "enabled": true,
    "remote": "origin"
  }
}
```

The `daemon_applied` field indicates whether the toggle landed on a **live daemon** (applied immediately) or was **saved to config** (will apply on daemon restart). The hub:

1. Writes the flag to `resource.metadata.git_sync` in the database
2. Calls `applyGitSyncConfig()` (`src/swarmkit/git-sync-config.ts`) to merge the flag into `.opentasks/config.json` on disk
3. Calls `reloadSyncerForResource()` (`src/map/git-pull-trigger.ts`) to hot-reload the daemon via `sync.reload` IPC
4. Returns the result: either the daemon's new status (if reachable) or `null` (if daemon unreachable, config was still written)

**UI toggle** (`src/web/components/git-sync/GitSyncToggle.tsx`):

- Mounted in task graph toolbar
- Shows "Sync: on" / "Sync: off" / "Sync: …" based on current state
- Opens popover with checkbox + remote name display
- On toggle, calls PATCH, shows result notice: either "Applied to running daemon" (green checkmark) or "Saved — daemon will pick up on next restart" (yellow alert)

### Layer 3: MAP Context Events → Pull Trigger

**Cross-hub convergence** via MAP signaling:

```
Hub A: REST POST /specs (or any graph mutation)
  ↓ daemon auto-commit + auto-push to shared remote
Hub B: receives `context.*` MAP event (from peer sidecar bridge)
  ↓ handleMapContextEvent() in src/coordination/listener.ts
  ↓ triggerPullForResource(resourceId)
  ↓ debounced sync.pull IPC (2s window, coalesces rapid triggers)
Hub B's daemon: pulls from remote → watcher fires → bridge re-emits locally
  ↓ broadcastToChannel('map:tasks', { type: 'spec.created', ... })
Hub B's frontend: sees spec in realtime
```

**Debouncing**: If a peer hub pushes ten context events in five seconds, Hub B issues only **one** `sync.pull` call during that window. Subsequent pulls wait until the debounce timer expires and the previous pull completes.

**Configuration** (per-resource):

```typescript
// In resource metadata
pullOnSignal?: boolean; // default true when git_sync.enabled=true
```

Set to `false` to opt out (e.g., if you only want periodic scheduled pulls via `pushDebounceMs` or manual pulls).

## Compatibility Matrix

| Resource has git_sync.enabled | Daemon started with sync | Behavior |
|---|---|---|
| `false` or unset (default) | N/A | All existing behavior — no git ops, no sync |
| `true` (post-PATCH toggle) | previously `disabled`, hot-reloaded via `sync.reload` | Syncer rebuilds in place; commits/pushes start immediately |
| `true` | enabled at startup (config pre-written) | autoCommit/autoPush timer runs; pullOnStartup pulls before first serve |
| `true` (post-PATCH disable) | previously enabled, hot-reloaded | Syncer torn down; `sync.now` returns `{ ran: false }`; no further git ops |

**Strict opt-in**: System is backward-compatible. When not configured, git sync is completely disabled — no commits, no pushes, no pulls. Users must explicitly toggle `enabled: true` to activate.

## How to Enable

### Via REST API

```bash
# 1. Check current config (optional)
GET /api/v1/resources/res_abc/git-sync

# 2. Enable
PATCH /api/v1/resources/res_abc/git-sync
{
  "git_sync": {
    "enabled": true,
    "remote": "origin",
    "autoCommit": true,
    "autoPush": true,
    "pullOnStartup": true
  }
}

# 3. Check status
GET /api/v1/resources/res_abc/git-sync
```

### Via UI

1. Navigate to TaskGraph page
2. Click **"Sync: off"** button in toolbar
3. Check **"Enable git sync for this resource"**
4. Observe result: "Applied to running daemon" or "Saved; daemon will pick up on next restart"

### Programmatically (during resource creation)

```bash
POST /api/v1/resources
{
  "resource_type": "task",
  "name": "my-project-tasks",
  "git_remote_url": "https://github.com/user/project.git",
  "metadata": {
    "git_sync": {
      "enabled": true,
      "remote": "origin"
    }
  }
}
```

## Deployment Scenarios

### Local-only (Single Instance)

```
Instance A (local machine)
├── .opentasks/graph.jsonl (daemon on disk)
└── git_sync.enabled = false (default)
→ All graph operations are local; no network required
→ No pull/push overhead
```

### Local + Remote Origin (One Instance, Shared Remote)

```
Instance A (local machine)
├── .opentasks/graph.jsonl (daemon on disk)
├── git remote "origin" (GitHub, GitLab, Gitea, etc.)
└── git_sync.enabled = true
→ Daemon auto-commits + auto-pushes on change
→ Pulls on startup (to catch peer updates)
→ No cross-hub coordination
```

### Multiple Hubs (Federated)

```
Hub A (instance 1, hive: engineering)
├── .opentasks/graph.jsonl (daemon)
├── git remote "origin" (shared by A + B)
└── git_sync.enabled = true, pullOnSignal = true (default)
    
Hub B (instance 2, hive: product)
├── .opentasks/graph.jsonl (daemon)
├── git remote "origin" (same as A)
└── git_sync.enabled = true, pullOnSignal = true (default)

Agent on Hub A pushes spec
  → A's daemon: auto-commit + auto-push
  → MAP bridge emits context.created
  → Hub B receives context.created event
  → Hub B's triggerPullForResource fires
  → B's daemon: sync.pull (debounced, ~2s)
  → B's frontend: sees spec in map:tasks channel
```

### Multiple Hives (Same Hub Instance)

```
Hub X (single instance)
├── Hive: engineering
│   └── Task resource: git_sync.enabled = true, remote = "origin"
├── Hive: product
│   └── Task resource: git_sync.enabled = true, remote = "origin"

Both hives write to the same git remote. The daemon's merge resolution
handles concurrent edits. Cross-hive collaboration happens via MAP events
(context.created/updated) and realtime WS broadcasts.
```

### No Shared Remote (Mesh Sync Only)

```
Hub A, Hub B (no git remote, private instances)
→ Disable git_sync.enabled
→ Use the existing resource sync protocol (mesh sync for metadata)
→ Graph content is not synced, only metadata
→ Agents query each other via MAP opentasks methods (future work)
```

## File Paths

| File | Purpose |
|------|---------|
| `src/swarmkit/git-sync-config.ts` | `applyGitSyncConfig()`, `readAppliedGitSyncConfig()` — merge metadata into daemon config.json on disk |
| `src/map/git-pull-trigger.ts` | `triggerPullForResource()`, `reloadSyncerForResource()` — debounced pull + hot-reload IPC |
| `src/coordination/listener.ts` | `handleMapContextEvent()` — receives context.* events, calls triggerPullForResource |
| `src/api/routes/resources.ts` | `PATCH /resources/:id/git-sync` endpoint — REST surface for toggling |
| `src/web/components/git-sync/GitSyncToggle.tsx` | UI toggle component with popover |
| `src/__tests__/routes/resources-git-sync.test.ts` | PATCH endpoint tests |
| `src/__tests__/routes/git-sync-hot-reload.test.ts` | Hot-reload IPC tests |
| `src/__tests__/map/git-pull-on-context-event.test.ts` | Cross-hub pull trigger tests |

## Limitations + Known Gaps

1. **Error surfacing**: Pull failures (network, auth, merge conflict) are logged to hub stderr but not surfaced in the UI. Future work: add error notice to git-sync toggle when pull fails.

2. **Bootstrap CLI**: No command-line tool to initialize git sync on an existing resource or daemon. Workaround: use REST API or UI toggle.

3. **Merge conflict handling**: The opentasks package's merge resolution utility handles conflicts at the graph semantic level, but in rare pathological cases (simultaneous edits to the same node + edge) a manual resolution may be needed. Not expected in normal operation (JSONL append-only format + merge utility handle 99% of cases).

4. **Cross-hub MAP federation**: Converging state via MAP events requires the peer hub's sidecar to send context.* events. If the sidecar loses connection, events are not queued — pull will not be triggered until the next manual pull or periodic cron.

5. **Auth for cloning** (future work): No support yet for PAT-authenticated private git remotes. Public repos and instances with SSH key setup work today.

6. **Partial sync** (future work): Currently syncs the entire `.opentasks/` directory. No support for syncing a subset of the graph or selective branches.

## Testing

```bash
# Run git-sync-specific tests
npm run test:run -- --grep "git-sync|git-pull|sync.reload"

# Smoke test: enable sync on a resource
curl -X PATCH http://localhost:7836/api/v1/resources/res_abc/git-sync \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{ "git_sync": { "enabled": true } }'

# Check daemon status
opentasks daemon status --socket /var/run/opentasks.sock
opentasks daemon config --socket /var/run/opentasks.sock

# Trigger a manual pull (for testing)
opentasks daemon pull --socket /var/run/opentasks.sock
```

## See Also

- `CLAUDE.md` — architecture overview section "Git-sync + MAP signaling"
- `OPENTASKS_SYNC_DESIGN.md` — earlier design doc (covers future sync strategies: `ls-remote`, `mirror`, `bundle`)
- `OPENTASKS_MAP_CONNECTOR.md` — MAP protocol methods for querying remote graphs
- `references/opentasks/` — opentasks daemon and IPC client source
