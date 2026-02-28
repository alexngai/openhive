/**
 * Coordination Service
 *
 * High-level service for inter-swarm coordination: task delegation,
 * context sharing, and direct messaging. Persists via DAL, delivers
 * JSON-RPC notifications to target swarms, and broadcasts WebSocket
 * events for local UI consumers.
 */

import { sendToSwarm } from '../map/sync-listener.js';
import { broadcastToChannel } from '../realtime/index.js';
import * as coordinationDal from '../db/dal/coordination.js';
import { createCoordinationNotification } from './types.js';
import {
  onCoordinationTaskOffered,
  onCoordinationTaskClaimed,
  onCoordinationTaskCompleted,
  onCoordinationMessage,
} from '../sync/coordination-hooks.js';
import type { Agent } from '../types.js';
import type {
  CoordinationTask,
  SwarmMessage,
  SharedContext,
  CreateTaskInput,
  UpdateTaskInput,
  CreateMessageInput,
  CreateContextInput,
} from './types.js';

export class CoordinationService {
  // ==========================================================================
  // Tasks
  // ==========================================================================

  assignTask(hiveId: string, input: CreateTaskInput, agent?: Agent): CoordinationTask {
    const task = coordinationDal.createTask(hiveId, input);

    // Deliver JSON-RPC notification to the assigned swarm
    if (task.assigned_to_swarm_id) {
      sendToSwarm(
        task.assigned_to_swarm_id,
        createCoordinationNotification('x-openhive/task.assign', {
          task_id: task.id,
          title: task.title,
          description: task.description || '',
          priority: task.priority,
          assigned_by: task.assigned_by_agent_id,
          assigned_to_swarm: task.assigned_to_swarm_id,
          hive_id: hiveId,
          context: task.context ?? undefined,
          deadline: task.deadline ?? undefined,
        }),
      );
    }

    // Broadcast to local WebSocket channel
    broadcastToChannel(`coordination:${hiveId}`, {
      type: 'task_assigned',
      data: task,
    });

    // Cross-instance sync hook
    if (agent) {
      onCoordinationTaskOffered(task, agent);
    }

    return task;
  }

  updateTaskStatus(taskId: string, update: UpdateTaskInput, agent?: Agent): CoordinationTask | null {
    const task = coordinationDal.updateTask(taskId, update);
    if (!task) return null;

    // Notify the assigning swarm of status change
    if (task.assigned_by_swarm_id) {
      sendToSwarm(
        task.assigned_by_swarm_id,
        createCoordinationNotification('x-openhive/task.status', {
          task_id: task.id,
          status: task.status as 'accepted' | 'in_progress' | 'completed' | 'failed' | 'rejected',
          progress: task.progress,
          result: task.result ?? undefined,
          error: task.error ?? undefined,
        }),
      );
    }

    // Broadcast to local WebSocket channel
    broadcastToChannel(`coordination:${task.hive_id}`, {
      type: 'task_status_updated',
      data: task,
    });

    // Cross-instance sync hooks
    if (agent) {
      if (update.status === 'accepted') {
        onCoordinationTaskClaimed(task, agent);
      } else if (update.status === 'completed' || update.status === 'failed') {
        onCoordinationTaskCompleted(task, update.status, agent);
      }
    }

    return task;
  }

  getTask(taskId: string): CoordinationTask | null {
    return coordinationDal.findTaskById(taskId);
  }

  listTasks(
    hiveId: string,
    opts?: { status?: string; swarm_id?: string; limit?: number; offset?: number },
  ): { data: CoordinationTask[]; total: number } {
    return coordinationDal.listTasks({
      hive_id: hiveId,
      status: opts?.status,
      assigned_to_swarm_id: opts?.swarm_id,
      limit: opts?.limit,
      offset: opts?.offset,
    });
  }

  // ==========================================================================
  // Shared Contexts
  // ==========================================================================

  shareContext(hiveId: string, input: CreateContextInput): SharedContext {
    const ctx = coordinationDal.createContext(hiveId, input);

    // Deliver JSON-RPC notification to target swarms
    const targetSwarmIds = input.target_swarm_ids ?? [];
    for (const swarmId of targetSwarmIds) {
      sendToSwarm(
        swarmId,
        createCoordinationNotification('x-openhive/context.share', {
          context_id: ctx.id,
          source_swarm_id: input.source_swarm_id,
          target_swarm_ids: targetSwarmIds,
          hive_id: hiveId,
          context_type: input.context_type,
          data: input.data,
          ttl_seconds: input.ttl_seconds,
        }),
      );
    }

    // Broadcast to local WebSocket channel
    broadcastToChannel(`coordination:${hiveId}`, {
      type: 'context_shared',
      data: ctx,
    });

    return ctx;
  }

  getContext(contextId: string): SharedContext | null {
    return coordinationDal.findContextById(contextId);
  }

  listContexts(
    hiveId: string,
    opts?: { type?: string; swarm_id?: string; limit?: number; offset?: number },
  ): { data: SharedContext[]; total: number } {
    return coordinationDal.listContexts({
      hive_id: hiveId,
      context_type: opts?.type,
      source_swarm_id: opts?.swarm_id,
      limit: opts?.limit,
      offset: opts?.offset,
    });
  }

  cleanupExpiredContexts(): number {
    return coordinationDal.deleteExpiredContexts();
  }

  // ==========================================================================
  // Messages
  // ==========================================================================

  sendMessage(input: CreateMessageInput): SwarmMessage {
    const msg = coordinationDal.createMessage(input);

    // Deliver JSON-RPC notification to the target swarm
    if (msg.to_swarm_id) {
      sendToSwarm(
        msg.to_swarm_id,
        createCoordinationNotification('x-openhive/message.send', {
          message_id: msg.id,
          from_swarm_id: msg.from_swarm_id,
          to_swarm_id: msg.to_swarm_id,
          hive_id: msg.hive_id ?? undefined,
          content_type: msg.content_type,
          content: msg.content,
          reply_to: msg.reply_to ?? undefined,
          metadata: msg.metadata ?? undefined,
        }),
      );
    }

    // Broadcast to local WebSocket channel
    const channel = msg.hive_id
      ? `coordination:${msg.hive_id}`
      : `swarm:${msg.to_swarm_id}`;
    broadcastToChannel(channel, {
      type: 'swarm_message_received',
      data: msg,
    });

    // Cross-instance sync hook
    onCoordinationMessage(msg);

    return msg;
  }

  getMessages(
    swarmId: string,
    opts?: { hive_id?: string; since?: string; limit?: number; offset?: number },
  ): { data: SwarmMessage[]; total: number } {
    return coordinationDal.listMessages({
      to_swarm_id: swarmId,
      hive_id: opts?.hive_id,
      since: opts?.since,
      limit: opts?.limit,
      offset: opts?.offset,
    });
  }

  markRead(messageId: string): void {
    coordinationDal.markMessageRead(messageId);
  }
}
