/**
 * Coordination Listener
 *
 * Handles inbound coordination messages from swarm WebSocket connections.
 *
 * Task events use generic MAP scope messages (task.created, task.assigned,
 * task.status) — the format used by cc-swarm and macro-agent task bridges.
 * Task events route to the OpenTasks compat shim.
 *
 * Context sharing and messaging are handled by agent-inbox (not here).
 */

import { shimTaskAssign, shimTaskStatus } from './compat.js';
import { mapHubEvents } from '../map/service.js';
import type { TaskStatusParams } from './types.js';

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
 * Routes to the OpenTasks compat shim and emits hub events.
 */
export function handleMapTaskEvent(
  payload: Record<string, unknown>,
  sourceSwarmId: string,
): void {
  switch (payload.type) {
    case 'task.created': {
      const task = payload.task as Record<string, unknown> | undefined;
      if (!task?.title) return;

      const shimNodeId = shimTaskAssign(
        {
          task_id: (task.id as string) ?? '',
          title: task.title as string,
          description: (task.description as string) ?? '',
          priority: 'medium',
          assigned_by: sourceSwarmId,
          assigned_to_swarm: (task.assignee as string) ?? sourceSwarmId,
          hive_id: '',
        },
        sourceSwarmId,
      );
      if (shimNodeId) {
        console.log(`[coordination] task.created "${task.title}" → OpenTasks node ${shimNodeId}`);
      }

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

      const shimHandled = shimTaskStatus(
        {
          task_id: taskId,
          status: current as TaskStatusParams['status'],
          progress: payload.progress as number | undefined,
          result: payload.result as Record<string, unknown> | undefined,
          error: payload.error as string | undefined,
        },
        taskId,
      );
      if (shimHandled) {
        console.log(`[coordination] task.status ${previous} → ${current} for ${taskId}`);
      }

      mapHubEvents.emit('task_status_changed', {
        task_id: taskId,
        status: current,
        previous,
      });
      break;
    }
  }
}
