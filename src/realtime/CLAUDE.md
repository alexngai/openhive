# src/realtime — WebSocket event broadcasting

Server-side fan-out helpers for the WS channels frontend hooks subscribe to. The frontend's invalidation contract (which channels to subscribe, which event types to invalidate which React Query keys) lives in `src/web/hooks/useRealtimeInvalidation.ts`.

## Realtime invalidation (frontend)

Frontend React Query caches are invalidated via WebSocket events (`src/web/hooks/useRealtimeInvalidation.ts`) rather than polling. Server broadcasts to channels like `map:discovery`, and per-domain hooks (`useSwarmRealtime`, `useResourcesRealtime`, `useSessionsRealtime`, `useReposRealtime`, etc.) subscribe and invalidate the relevant query keys.

Channel subscriptions are ref-counted in `useWSStore` so multiple hooks subscribing to the same channel (e.g., `global`) don't unsubscribe prematurely when one unmounts.

The `useWebSocket` hook in `src/web/hooks/useWebSocket.ts` uses **per-field Zustand selectors** (not full-store destructure) and reads `emit` via `useWSStore.getState()` inside `ws.onmessage` — both choices defend against a Vite-HMR pathology where the swap leaves a live socket bound to a *dead* module's emit closure, dispatching into an old store instance whose listeners no children re-registered. Module-top `import.meta.hot.dispose` closes the live socket on swap so the fresh module rebinds cleanly.

## Swarm lifecycle WS fan-out

All swarm-lifecycle WS broadcasts go through `broadcastSwarmLifecycleEvent(swarmId, event)` in `src/realtime/swarm-events.ts`. The helper fans out to **both**:

- `map:discovery` (fleet-wide subscribers — chat picker, dashboard, useSwarmRealtime)
- `map:swarm:${swarmId}` (per-swarm subscribers — swarm detail page)

…in a single call. The event-type union is the canonical list of swarm-lifecycle types: `swarm_registered`, `swarm_offline`, `swarm_heartbeat`, `swarm.status_changed`, `node_registered`, `connection_degraded`, `connection_recovered`. Adding a new lifecycle type is a one-line change to the union; every emit site automatically gets correct fan-out.

**Do not** call `broadcastToChannel('map:discovery', { type: 'some_swarm_event', ... })` directly for events in the union — the structural-symmetry test in `src/__tests__/realtime/swarm-lifecycle-fanout.test.ts` will fail because the per-swarm sibling broadcast is missing.

Events outside the union intentionally continue calling `broadcastToChannel` directly:
- per-swarm-only like `node_state_changed`
- hosted-swarm `swarm_spawned` / `swarm_stopped` from `swarm/manager.ts` (these carry `hosted_swarm_id`, not MAP `swarm_id`)
- bulk-aggregate stale-sweep notices in `server.ts`

## Workspace lifecycle fan-out

Same pattern for repo / workspace lifecycle: `broadcastWorkspaceLifecycleEvent(repoId, event)` in `src/realtime/workspace-events.ts` fans out to `map:repos` (fleet) + `map:repo:${repoId}` (per-repo). Event union: `workspace_added | workspace_changed | workspace_deactivated | repo_visibility_changed | repo_archived`. See `src/map/CLAUDE.md` "Repos and Workspaces" for the producer side.

## Key files

- `src/realtime/index.ts` — `broadcastToChannel(channel, event)` primitive.
- `src/realtime/swarm-events.ts` — `broadcastSwarmLifecycleEvent` + the canonical event-type union.
- `src/realtime/workspace-events.ts` — `broadcastWorkspaceLifecycleEvent`.
- `src/realtime/acp-bridge.ts` — bridges SwarmCraft's `acp` topic broadcasts to the OpenHive `global` channel (see `src/swarmcraft/CLAUDE.md`).
- `src/__tests__/realtime/swarm-lifecycle-fanout.test.ts` — structural-symmetry test that catches missing per-swarm fan-out.
- `src/web/hooks/useWebSocket.ts` — frontend WS client with HMR-safe binding.
- `src/web/hooks/useRealtimeInvalidation.ts` — per-domain query invalidation hooks.
