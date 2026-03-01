/**
 * Coordination Sync Write-Path Hooks
 *
 * Record sync events when coordination tasks are offered/claimed/completed
 * and when inter-swarm messages are sent. Called from the CoordinationService
 * after local persistence. Fire-and-forget.
 *
 * Like resource hooks, coordination events broadcast to ALL active sync groups.
 */

import { listSyncGroups } from '../db/dal/sync-groups.js';
import { insertLocalEvent } from '../db/dal/sync-events.js';
import { signEvent } from './crypto.js';
import { getSyncService } from './service.js';
import type { Agent } from '../types.js';
import type {
  HiveEventType,
  AgentSnapshot,
  SyncGroup,
  CoordinationTaskOfferedPayload,
  CoordinationTaskClaimedPayload,
  CoordinationTaskCompletedPayload,
  CoordinationMessagePayload,
} from './types.js';
import type { CoordinationTask, SwarmMessage } from '../coordination/types.js';

function getInstanceId(syncGroup: SyncGroup): string {
  const service = getSyncService();
  if (service) return service.getInstanceId();
  return syncGroup.created_by_instance_id || 'unknown';
}

function agentToSnapshot(agent: Agent, instanceId: string): AgentSnapshot {
  return {
    instance_id: instanceId,
    agent_id: agent.id,
    name: agent.name,
    avatar_url: agent.avatar_url,
  };
}

function recordEventOnAllGroups(eventType: HiveEventType, payload: unknown): void {
  const service = getSyncService();
  const groups = listSyncGroups();

  for (const group of groups) {
    if (service) {
      service.recordEvent(group.id, eventType, payload);
    } else {
      const instanceId = getInstanceId(group);
      const payloadStr = JSON.stringify(payload);
      const signature = signEvent(payloadStr, group.instance_signing_key_private);
      insertLocalEvent({
        sync_group_id: group.id,
        event_type: eventType,
        origin_instance_id: instanceId,
        origin_ts: Date.now(),
        payload: payloadStr,
        signature,
        is_local: true,
      });
    }
  }
}

// ── Coordination Hooks ──────────────────────────────────────────

export function onCoordinationTaskOffered(task: CoordinationTask, agent: Agent): void {
  try {
    const groups = listSyncGroups();
    if (groups.length === 0) return;

    const instanceId = getInstanceId(groups[0]);
    const payload: CoordinationTaskOfferedPayload = {
      task_id: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      offered_by: agentToSnapshot(agent, instanceId),
      hive_id: task.hive_id,
      assigned_to_swarm_id: task.assigned_to_swarm_id,
      context: task.context,
      deadline: task.deadline,
    };

    recordEventOnAllGroups('coordination_task_offered', payload);
  } catch (err) {
    console.error('[Sync Hook] onCoordinationTaskOffered failed:', (err as Error).message);
  }
}

export function onCoordinationTaskClaimed(task: CoordinationTask, agent: Agent): void {
  try {
    const groups = listSyncGroups();
    if (groups.length === 0) return;

    const instanceId = getInstanceId(groups[0]);
    const payload: CoordinationTaskClaimedPayload = {
      task_id: task.id,
      origin_instance_id: task.origin_instance_id,
      origin_task_id: task.origin_task_id,
      claimed_by: agentToSnapshot(agent, instanceId),
    };

    recordEventOnAllGroups('coordination_task_claimed', payload);
  } catch (err) {
    console.error('[Sync Hook] onCoordinationTaskClaimed failed:', (err as Error).message);
  }
}

export function onCoordinationTaskCompleted(
  task: CoordinationTask,
  status: 'completed' | 'failed',
  agent: Agent,
): void {
  try {
    const groups = listSyncGroups();
    if (groups.length === 0) return;

    const instanceId = getInstanceId(groups[0]);
    const payload: CoordinationTaskCompletedPayload = {
      task_id: task.id,
      origin_instance_id: task.origin_instance_id,
      origin_task_id: task.origin_task_id,
      completed_by: agentToSnapshot(agent, instanceId),
      status,
      result: task.result,
      error: task.error,
    };

    recordEventOnAllGroups('coordination_task_completed', payload);
  } catch (err) {
    console.error('[Sync Hook] onCoordinationTaskCompleted failed:', (err as Error).message);
  }
}

export function onCoordinationMessage(msg: SwarmMessage): void {
  try {
    const payload: CoordinationMessagePayload = {
      message_id: msg.id,
      from_swarm_id: msg.from_swarm_id,
      to_swarm_id: msg.to_swarm_id,
      hive_id: msg.hive_id,
      content_type: msg.content_type,
      content: msg.content,
      reply_to: msg.reply_to,
      metadata: msg.metadata,
    };

    recordEventOnAllGroups('coordination_message', payload);
  } catch (err) {
    console.error('[Sync Hook] onCoordinationMessage failed:', (err as Error).message);
  }
}
