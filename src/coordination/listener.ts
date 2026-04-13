/**
 * Coordination Listener
 *
 * Handles inbound coordination messages from swarm WebSocket connections.
 *
 * Task events use generic MAP scope messages (task.created, task.assigned,
 * task.status) — the format used by cc-swarm and macro-agent task bridges.
 *
 * The hub acts as a relay: it emits hub events (for internal consumers like
 * SwarmCraft and the learning engine) and broadcasts to WebSocket subscribers.
 * It does NOT persist task state — agents own their task graphs via their
 * local OpenTasks daemons, and sync between them via pushSyncEvent.
 *
 * Context sharing and messaging are handled by agent-inbox (not here).
 */

import { mapHubEvents } from '../map/service.js';

// =============================================================================
// MAP Scope Task Messages (from cc-swarm / macro-agent)
// =============================================================================

/** MAP scope message payload types for task events */
const MAP_TASK_EVENT_TYPES = new Set(['task.created', 'task.assigned', 'task.status']);

/**
 * Type guard: is the incoming data a MAP scope message containing a task event?
 * These arrive as MAP `send()` messages with payload.type set to a task event.
 */
export function isMapTaskEvent(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const msg = data as Record<string, unknown>;
  if (!msg.payload || typeof msg.payload !== 'object') return false;
  const payload = msg.payload as Record<string, unknown>;
  return typeof payload.type === 'string' && MAP_TASK_EVENT_TYPES.has(payload.type);
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
    case 'task.created': {
      const task = payload.task as Record<string, unknown> | undefined;
      if (!task?.title) return;

      mapHubEvents.emit('task_assigned', {
        task_id: task.id,
        title: task.title,
        description: task.description,
        assigned_by: sourceSwarmId,
        assigned_to_swarm: task.assignee ?? sourceSwarmId,
        source_swarm_id: sourceSwarmId,
      });
      break;
    }

    case 'task.assigned': {
      const taskId = payload.taskId as string | undefined;
      const assignee = payload.assignee as string | undefined;
      if (!taskId) return;

      mapHubEvents.emit('task_assigned', {
        task_id: taskId,
        assigned_to_swarm: assignee,
        source_swarm_id: sourceSwarmId,
      });
      break;
    }

    case 'task.status': {
      const taskId = payload.taskId as string | undefined;
      const current = payload.current as string | undefined;
      const previous = payload.previous as string | undefined;
      if (!taskId || !current) return;

      mapHubEvents.emit('task_status_changed', {
        task_id: taskId,
        status: current,
        previous,
      });
      break;
    }
  }
}
