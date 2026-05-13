# src/coordination — task event relay between agent swarms

OpenHive acts as a **relay hub** for task events between agent swarms. It does NOT own or persist task state — each agent maintains its own task graph via a local OpenTasks daemon.

## Hub Role

The hub intercepts task events from connected agents (via MAP scope messages) and:
1. **Emits hub events** (`mapHubEvents`) for internal consumers (SwarmCraft, learning engine)
2. **Broadcasts to WebSocket** subscribers on the `map:tasks` channel
3. **Routes remote queries** between agents (hub → sidecar → daemon → response)

The hub does not write task state to disk. Task persistence is owned by each agent's OpenTasks daemon.

## Task Event Flow

```
Agent uses TaskCreate → cc-swarm PostToolUse hook
  → sidecar sends bridge-task-created via MAP scope message
  → MAPServer fires message.sent → ws-map.ts intercepts
  → Resolves agent ID from connection registry
  → handleMapTaskEvent() emits hub event + broadcastToChannel
  → MAPServer delivers scope message to other agents
  → Receiving agent's hook calls pushSyncEvent → local daemon
```

## Key Files

- `src/coordination/listener.ts` — `handleMapTaskEvent()`: routes task.created/status/assigned events, emits hub events
- `src/coordination/types.ts` — Type definitions for task event parameters
- `src/map/task-handler.ts` — MAP protocol `map/tasks/*` method handlers (create, list, update, assign), routes to local daemon or remote swarm
- `src/map/task-daemon-client.ts` — OpenTasks daemon IPC client (connect, query, create, update, assign via Unix socket)
- `src/map/task-daemon-lifecycle.ts` — Daemon health checks and auto-start
- `src/map/opentasks-remote.ts` — Remote task queries via connected swarms (request/response over MAP notifications)
- `src/map/ws-map.ts` — MAP WebSocket handler, `message.sent` interceptor for task bridge events, agent ID resolution
- `src/api/routes/resource-content.ts` — REST endpoints under `/resources/:id/content/opentasks/*` (summary, ready, tasks, graph, status, create, update)

## OpenTasks Integration

Task resources are `SyncableResource` entries with `resource_type: 'task'` and `metadata.opentasks: true`. The hub queries task data through two paths:

- **Local daemon** — when the resource has a `local_path`, the hub connects to the daemon via Unix socket IPC
- **Remote swarm** — when no local path exists, the hub sends `opentasks/query.request` notifications to the connected sidecar, which queries its local daemon and responds

REST endpoints try the local daemon first, falling back to remote queries, then returning 503 if neither is available.

## Agent-Side Task Sync

Agents sync tasks between each other via `pushSyncEvent` (in cc-swarm's `opentasks-client.mjs`), which writes directly to the agent's local daemon:

- `task.sync` → `graph.create` or `graph.update`
- `task.claimed` → `graph.update` (status=in_progress, assignee set)
- `task.unblocked` → `graph.update` (status=open)
- `task.linked` → `tools.link` (creates blocking edge)

This runs during the agent's `UserPromptSubmit` hook when incoming task events are read from the inbox.

## Related subsystems

- **Cascade ↔ Task Binding** (`src/cascade/CLAUDE.md`) — the binder observes cascade-merge events and (when policy permits) drives task transitions through the same daemon/remote update path used here.
- **Dispatch Orchestrator** (`src/dispatch/CLAUDE.md`) — dispatch consumes task ready-state via opentasks queries; this directory's daemon-client primitives feed both.
