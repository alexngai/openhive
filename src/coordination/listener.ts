/**
 * Coordination Listener
 *
 * Handles inbound coordination JSON-RPC 2.0 messages from swarm WebSocket
 * connections. Dispatches to CoordinationService based on method name.
 */

import { getCoordinationService } from './index.js';
import type { MapCoordinationMessage, TaskAssignParams, TaskStatusParams, ContextShareParams, MessageSendParams } from './types.js';

/** Set of valid coordination method names for fast validation */
const COORDINATION_METHOD_SET = new Set([
  'x-openhive/task.assign',
  'x-openhive/task.status',
  'x-openhive/context.share',
  'x-openhive/message.send',
]);

/** Type guard: is the incoming data a coordination JSON-RPC notification? */
export function isCoordinationMessage(data: unknown): data is MapCoordinationMessage {
  if (!data || typeof data !== 'object') return false;
  const msg = data as Record<string, unknown>;
  if (msg.jsonrpc !== '2.0') return false;
  if (typeof msg.method !== 'string' || !COORDINATION_METHOD_SET.has(msg.method)) return false;
  return msg.params != null && typeof msg.params === 'object';
}

/**
 * Process an incoming coordination notification from a swarm.
 * Dispatches to the appropriate CoordinationService method.
 */
export function handleCoordinationMessage(msg: MapCoordinationMessage, sourceSwarmId: string): void {
  const service = getCoordinationService();

  switch (msg.method) {
    case 'x-openhive/task.assign': {
      const p = msg.params as TaskAssignParams;
      service.assignTask(p.hive_id, {
        title: p.title,
        description: p.description,
        priority: p.priority,
        assigned_by_agent_id: p.assigned_by,
        assigned_by_swarm_id: sourceSwarmId,
        assigned_to_swarm_id: p.assigned_to_swarm,
        context: p.context,
        deadline: p.deadline,
      });
      console.log(`[coordination] Received task.assign "${p.title}" from swarm ${sourceSwarmId}`);
      break;
    }

    case 'x-openhive/task.status': {
      const p = msg.params as TaskStatusParams;
      service.updateTaskStatus(p.task_id, {
        status: p.status,
        progress: p.progress,
        result: p.result,
        error: p.error,
      });
      console.log(`[coordination] Received task.status ${p.status} for ${p.task_id} from swarm ${sourceSwarmId}`);
      break;
    }

    case 'x-openhive/context.share': {
      const p = msg.params as ContextShareParams;
      service.shareContext(p.hive_id, {
        source_swarm_id: p.source_swarm_id,
        context_type: p.context_type,
        data: p.data,
        target_swarm_ids: p.target_swarm_ids,
        ttl_seconds: p.ttl_seconds,
      });
      console.log(`[coordination] Received context.share type=${p.context_type} from swarm ${sourceSwarmId}`);
      break;
    }

    case 'x-openhive/message.send': {
      const p = msg.params as MessageSendParams;
      service.sendMessage({
        hive_id: p.hive_id,
        from_swarm_id: p.from_swarm_id,
        to_swarm_id: p.to_swarm_id,
        content_type: p.content_type,
        content: typeof p.content === 'string' ? p.content : JSON.stringify(p.content),
        reply_to: p.reply_to,
        metadata: p.metadata,
      });
      console.log(`[coordination] Received message.send from ${p.from_swarm_id} to ${p.to_swarm_id}`);
      break;
    }
  }
}
