# src/swarmkit — read/write proxy for SwarmKit package configs

OpenHive acts as a read/write proxy for SwarmKit package configs (opentasks, minimem, sessionlog, etc.) — the Settings UI edits files owned by those packages. The hub never caches config; every UI action hits disk.

## Machine-specific overrides (`settings.local.json`)

Sessionlog stores config in two files:

- `.swarm/sessionlog/settings.json` — committed, shared across teammates
- `.swarm/sessionlog/settings.local.json` — gitignored, per-machine overrides (local wins at runtime)

OpenHive's SwarmKit UI supports this split without any routing metadata. The flow:

1. **Read** — `getPackageConfig` reads both files and returns a `config` (merged) plus `localConfig` (raw local file) on the API response. The UI sees the effective value.
2. **Badge** — each inline option in `SwarmKitPackageCard` checks `pkg.localConfig` for its key. If present, renders a `[local]` badge next to the field label. Pure detection — no hardcoded list of "local-only" keys.
3. **Write** — on save, the UI splits the diff into `updates` (→ main file) and `localUpdates` (→ local file) based on file-of-origin. `updatePackageConfig` obeys the split. Fresh keys (not in either file) default to main.

**Design property — no state in openhive:** the routing rule is "write it back where you found it." The UI owns the detection; the server is pure file I/O. No `local: true` flag on swarmkit's registry, no openhive-side field list, no sessionlog export needed.

## Git-Sync + MAP signaling

OpenTasks graphs sync via git to a shared remote (source of truth), and MAP context events trigger immediate pulls to converge instances without waiting for cron intervals. Three layers:

1. **opentasks daemon** (`references/opentasks/`) handles git operations (commit, push, pull, merge) on `.opentasks/graph.jsonl` with configurable timers and startup behaviors, exposed via `sync.now` / `sync.pull` / `sync.reload` / `sync.status` IPC methods.
2. **OpenHive hub** stores a `metadata.git_sync` flag on task resources and a REST endpoint (`PATCH /resources/:id/git-sync`) to toggle it, writing to `.opentasks/config.json` and hot-reloading the daemon via `sync.reload` IPC (`src/swarmkit/git-sync-config.ts` / `src/map/git-pull-trigger.ts`).
3. **On receipt of a MAP `context.*` event** from a peer hub, `handleMapContextEvent()` in `src/coordination/listener.ts` calls `triggerPullForResource()` to fire a debounced `sync.pull` (2s window, coalesces rapid updates).

The UI toggle (`src/web/components/git-sync/GitSyncToggle.tsx`) shows live state and indicates whether the change was applied to the daemon ("Applied to running daemon") or pending ("Saved; daemon will pick up on next restart").

**Compatibility matrix**: all existing behavior preserved when `enabled: false` (default); when toggled `true`, defaults to autoCommit/autoPush on change, pullOnStartup on daemon boot, and pullOnSignal on peer hub events. Remote is configurable but defaults to `origin`. See `docs/GIT_SOURCE_OF_TRUTH.md` for the full design.

## Key Files

- `src/swarmkit/config-io.ts` — file I/O. `PackageFileSpec.localFile` declares the sibling local file. `readConfig` / `readLocalConfig` / `writeConfig` are format-agnostic (JSON/YAML) and atomic.
- `src/swarmkit/manager.ts` — `getPackageConfig` merges `settings.local.json` over `settings.json` for sessionlog and surfaces `localConfig`. `updatePackageConfig(name, root, scope, updates, localUpdates?)` routes writes to the correct file.
- `src/swarmkit/types.ts` — `PackageConfigDescriptor.localFile?`, `PackageConfigResponse.localConfig?`.
- `src/swarmkit/git-sync-config.ts` — git-sync flag persistence on task resources + daemon reload.
- `src/api/routes/swarmkit-config.ts` — `PATCH /admin/swarmkit/packages/:name` accepts optional `localUpdates` on the request body.
- `src/web/pages/settings/SwarmKitPackageCard.tsx` — `isLocalKey(key)` detects from `pkg.localConfig`; `PackageConfigField` renders the `[local]` badge; `handleSave` splits the diff.
- `src/map/git-pull-trigger.ts` — debounced pull triggered on peer-hub `context.*` events.
- `src/web/components/git-sync/GitSyncToggle.tsx` — UI toggle with running-vs-pending state indicator.
