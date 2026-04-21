/**
 * Coordination Listener
 *
 * Handles inbound coordination messages from swarm WebSocket connections.
 *
 * Task events use generic MAP scope messages (task.created, task.assigned,
 * task.status) — the format used by cc-swarm and macro-agent task bridges.
 *
 * Context events (context.created, context.updated) are surfaced by the
 * opentasks MAP event bridge for every context graph node an agent authors
 * or edits — the bridge is kind-agnostic. OpenHive treats context nodes
 * carrying `metadata.kind === 'spec'` as Spec entities with their own UI
 * surface; all other contexts are ignored for now (no downstream consumer).
 * Spec-kind contexts are re-broadcast on the `map:tasks` WS channel using
 * the `spec.created`/`spec.updated` shape REST and `map/specs/author` already
 * produce, so frontend realtime invalidation works uniformly.
 *
 * The hub acts as a relay: it emits hub events (for internal consumers like
 * SwarmCraft and the learning engine) and broadcasts to WebSocket subscribers.
 * It does NOT persist task state — agents own their task graphs via their
 * local OpenTasks daemons, and sync between them via pushSyncEvent.
 *
 * Context sharing and messaging are handled by agent-inbox (not here).
 */

import { mapHubEvents } from "../map/service.js";
import { broadcastToChannel } from "../realtime/index.js";
import { shouldBroadcastSpecEvent } from "../map/spec-broadcast-dedup.js";
import { broadcastTaskStatus } from "../map/task-broadcast.js";
import { getDefaultTaskGraph } from "../map/connection-registry.js";

// =============================================================================
// MAP Scope Task Messages (from cc-swarm / macro-agent)
// =============================================================================

/** MAP scope message payload types for task events */
const MAP_TASK_EVENT_TYPES = new Set([
  "task.created",
  "task.assigned",
  "task.status",
]);

/**
 * Type guard: is the incoming data a MAP scope message containing a task event?
 * These arrive as MAP `send()` messages with payload.type set to a task event.
 */
export function isMapTaskEvent(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const msg = data as Record<string, unknown>;
  if (!msg.payload || typeof msg.payload !== "object") return false;
  const payload = msg.payload as Record<string, unknown>;
  return (
    typeof payload.type === "string" && MAP_TASK_EVENT_TYPES.has(payload.type)
  );
}

/**
 * Handle an inbound MAP scope task event from a swarm.
 * Emits hub events for internal consumers and lets ws-map.ts handle broadcasts.
 */
export function handleMapTaskEvent(
  payload: Record<string, unknown>,
  sourceSwarmId: string,
): void {
  switch (payload.type) {
    case "task.created": {
      const task = payload.task as Record<string, unknown> | undefined;
      if (!task?.title) return;

      mapHubEvents.emit("task_assigned", {
        task_id: task.id,
        title: task.title,
        description: task.description,
        assigned_by: sourceSwarmId,
        assigned_to_swarm: task.assignee ?? sourceSwarmId,
        source_swarm_id: sourceSwarmId,
      });
      break;
    }

    case "task.assigned": {
      const taskId = payload.taskId as string | undefined;
      const assignee = payload.assignee as string | undefined;
      if (!taskId) return;

      mapHubEvents.emit("task_assigned", {
        task_id: taskId,
        assigned_to_swarm: assignee,
        source_swarm_id: sourceSwarmId,
      });
      break;
    }

    case "task.status": {
      const taskId = payload.taskId as string | undefined;
      const current = payload.current as string | undefined;
      const previous = payload.previous as string | undefined;
      if (!taskId || !current) return;

      // Inbound path: agent scope-message reports task state. The bridge
      // event itself is unscoped, but we can recover the owning resource_id
      // from the connection's registered defaultTaskGraph so the cascade
      // enrichment matches hub-initiated broadcasts (prevents a mixed pair
      // of enriched + unenriched events when a hub-side close causes the
      // remote swarm to echo its own status transition).
      const resourceId = getDefaultTaskGraph(sourceSwarmId)?.resource_id;
      broadcastTaskStatus({ taskId, status: current, previous, resourceId });
      break;
    }
  }
}

// =============================================================================
// MAP Scope Context Messages (from opentasks map-event-bridge)
// =============================================================================

/** MAP scope message payload types for context events */
const MAP_CONTEXT_EVENT_TYPES = new Set(["context.created", "context.updated"]);

/**
 * Type guard: is the incoming data a MAP scope message containing a context
 * event? Parallel to `isMapTaskEvent` — context events arrive over the same
 * `map/send` transport, the hub just needs to recognize a different
 * payload.type set.
 */
export function isMapContextEvent(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const msg = data as Record<string, unknown>;
  if (!msg.payload || typeof msg.payload !== "object") return false;
  const payload = msg.payload as Record<string, unknown>;
  return (
    typeof payload.type === "string" &&
    MAP_CONTEXT_EVENT_TYPES.has(payload.type)
  );
}

/**
 * Handle an inbound MAP scope context event from a swarm.
 *
 * The bridge-derived payload carries `{ type, context: { id, metadata, ... } }`
 * but not `resource_id` — the agent's daemon doesn't know its own OpenHive
 * resource id. We resolve it from the connection's registered
 * `defaultTaskGraph` (populated at `map/agents/register` from the sidecar's
 * `task_graph` metadata). If no default is known, the event is dropped —
 * nothing else correlates the context back to an OpenHive resource.
 *
 * **Kind routing lives here, not in the bridge.** Contexts carrying
 * `metadata.kind === 'spec'` are re-broadcast on `map:tasks` using the
 * `spec.created`/`spec.updated` envelope REST and `map/specs/author` already
 * produce, so `useSpecsRealtime` invalidation fires uniformly. Plain
 * contexts (no spec marker) are currently dropped — no downstream consumer
 * exists today; a future Contexts UI would route them here.
 */
export function handleMapContextEvent(
  payload: Record<string, unknown>,
  sourceSwarmId: string,
  sourceAgentId: string,
): void {
  const contextRaw = payload.context as Record<string, unknown> | undefined;
  const contextId =
    typeof contextRaw?.id === "string" ? contextRaw.id : undefined;
  if (!contextId) return;

  const taskGraph = getDefaultTaskGraph(sourceSwarmId);
  const resourceId = taskGraph?.resource_id;
  if (!resourceId) return;

  const metadata = contextRaw?.metadata as Record<string, unknown> | undefined;
  const isSpec = metadata?.kind === "spec";
  if (!isSpec) return;

  const type =
    payload.type === "context.created" ? "spec.created" : "spec.updated";

  // Suppress the watcher-driven broadcast if an explicit broadcaster (REST
  // handler / map/specs/author) already fired for this same spec event
  // within the dedup window. Protects local-shared-daemon setups where
  // both paths see the same write.
  if (!shouldBroadcastSpecEvent(type, resourceId, contextId)) return;

  try {
    broadcastToChannel("map:tasks", {
      type,
      data: {
        spec: contextRaw,
        resource_id: resourceId,
        initiator: { type: "agent", id: sourceAgentId },
      },
    });
  } catch {
    /* best effort */
  }
}
