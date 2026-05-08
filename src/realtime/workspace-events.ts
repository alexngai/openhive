/**
 * Workspace Lifecycle Event Fan-Out
 *
 * Single fan-out helper for workspace/repo lifecycle WebSocket broadcasts.
 * Mirrors the swarm-lifecycle pattern (`./swarm-events.ts`) — callers pass
 * one of the union shapes here, the helper writes to BOTH the fleet
 * `map:repos` channel and the per-repo `map:repo:${repoId}` channel.
 *
 * The structural-symmetry test in
 * `tests/realtime/workspace-lifecycle-fanout.test.ts` asserts that every
 * event type in the union flows to both channels — adding a new event type
 * requires nothing more than extending the union here.
 *
 * Channels:
 *   - `map:repos` — fleet-wide subscribers (top-level Repos page, dashboard).
 *   - `map:repo:${repoId}` — per-repo subscribers (repo detail page,
 *     workspace-bindings list per repo).
 *
 * Events follow the openhive `WSEvent` `{ type, data }` shape (see
 * `types.ts`). The new event-type strings are registered in `WSEventType`.
 */

import { broadcastToChannel } from './index.js';
import type { Workspace } from '../types.js';

// ── Event payload shapes ──────────────────────────────────────────────────────

export interface WorkspaceAddedEvent {
  type: 'workspace_added';
  data: { workspace: Workspace };
}

export interface WorkspaceChangedEvent {
  type: 'workspace_changed';
  data: { workspace: Workspace };
}

export interface WorkspaceDeactivatedEvent {
  type: 'workspace_deactivated';
  data: { workspace_id: string; repo_id: string; agent_id: string };
}

export interface RepoVisibilityChangedEvent {
  type: 'repo_visibility_changed';
  data: { repo_id: string; new_visibility: 'private' | 'hub_local' | 'federated' };
}

export interface RepoArchivedEvent {
  type: 'repo_archived';
  data: { repo_id: string };
}

/**
 * Top-level repo metadata changed (name, description, default_branch,
 * binding_policy, status transitions other than archive). UI subscribers
 * use this to invalidate the repo detail view + the list page when the
 * row mutated but visibility/archive flags didn't (those have their own
 * dedicated event types above).
 */
export interface RepoUpdatedEvent {
  type: 'repo_updated';
  data: { repo_id: string };
}

export type WorkspaceLifecycleEvent =
  | WorkspaceAddedEvent
  | WorkspaceChangedEvent
  | WorkspaceDeactivatedEvent
  | RepoVisibilityChangedEvent
  | RepoArchivedEvent
  | RepoUpdatedEvent;

// ── Fan-out helper ────────────────────────────────────────────────────────────

/**
 * Broadcast a workspace-lifecycle event to BOTH the fleet `map:repos`
 * channel and the per-repo `map:repo:${repoId}` channel.
 *
 * `repoId` is the `syncable_resources.id` of the federated repo resource,
 * not the canonical URL. Per-repo subscribers match against this exact id
 * (e.g. the repo detail page).
 */
export function broadcastWorkspaceLifecycleEvent(
  repoId: string,
  event: WorkspaceLifecycleEvent,
): void {
  broadcastToChannel('map:repos', event);
  broadcastToChannel(`map:repo:${repoId}`, event);
}
