/**
 * Coordination Sync Write-Path Hooks
 *
 * Record sync events when inter-swarm messages are sent.
 * Called from the MessagingService after local persistence. Fire-and-forget.
 *
 * Task hooks have been removed — tasks now route through OpenTasks graphs,
 * and sync happens via the resource sync protocol (resource_synced events).
 */

import { listSyncGroups } from '../db/dal/sync-groups.js';
import { insertLocalEvent } from '../db/dal/sync-events.js';
import { signEvent } from './crypto.js';
import { getSyncService } from './service.js';
import type {
  HiveEventType,
  SyncGroup,
  CoordinationMessagePayload,
} from './types.js';
import type { SwarmMessage } from '../coordination/types.js';

function getInstanceId(syncGroup: SyncGroup): string {
  const service = getSyncService();
  if (service) return service.getInstanceId();
  return syncGroup.created_by_instance_id || 'unknown';
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
