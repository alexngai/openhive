/**
 * Resource Sync Write-Path Hooks
 *
 * Record sync events when resources are published/updated/unpublished/synced.
 * Called from route handlers after standard DAL operations.
 * Fire-and-forget — does not affect the response to the client.
 *
 * Unlike hive hooks (which target a specific sync group), resource events
 * are broadcast to ALL active sync groups so every peered instance learns
 * about the change.
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
  ResourcePublishedPayload,
  ResourceUpdatedPayload,
  ResourceUnpublishedPayload,
  ResourceSyncedPayload,
} from './types.js';

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

// ── Resource Hooks ──────────────────────────────────────────────

export function onResourcePublished(
  resource: { id: string; resource_type: string; name: string; description: string | null; git_remote_url: string; visibility: string },
  tags: string[],
  metadata: Record<string, unknown> | null,
  agent: Agent,
): void {
  try {
    const groups = listSyncGroups();
    if (groups.length === 0) return;

    const instanceId = getInstanceId(groups[0]);
    const payload: ResourcePublishedPayload = {
      resource_id: resource.id,
      resource_type: resource.resource_type as ResourcePublishedPayload['resource_type'],
      name: resource.name,
      description: resource.description,
      git_remote_url: resource.git_remote_url,
      visibility: resource.visibility as 'shared' | 'public',
      owner: agentToSnapshot(agent, instanceId),
      tags,
      metadata,
    };

    recordEventOnAllGroups('resource_published', payload);
  } catch (err) {
    console.error('[Sync Hook] onResourcePublished failed:', (err as Error).message);
  }
}

export function onResourceUpdated(
  resourceId: string,
  fields: Partial<{ name: string; description: string; visibility: string; tags: string[]; metadata: Record<string, unknown> }>,
  agent: Agent,
): void {
  try {
    const groups = listSyncGroups();
    if (groups.length === 0) return;

    const instanceId = getInstanceId(groups[0]);
    const payload: ResourceUpdatedPayload = {
      resource_id: resourceId,
      fields: fields as ResourceUpdatedPayload['fields'],
      updated_by: agentToSnapshot(agent, instanceId),
    };

    recordEventOnAllGroups('resource_updated', payload);
  } catch (err) {
    console.error('[Sync Hook] onResourceUpdated failed:', (err as Error).message);
  }
}

export function onResourceUnpublished(resourceId: string, agent: Agent): void {
  try {
    const groups = listSyncGroups();
    if (groups.length === 0) return;

    const instanceId = getInstanceId(groups[0]);
    const payload: ResourceUnpublishedPayload = {
      resource_id: resourceId,
      unpublished_by: agentToSnapshot(agent, instanceId),
    };

    recordEventOnAllGroups('resource_unpublished', payload);
  } catch (err) {
    console.error('[Sync Hook] onResourceUnpublished failed:', (err as Error).message);
  }
}

export function onResourceSynced(
  resourceId: string,
  commitHash: string,
  commitMessage: string | null,
  pusherAgentId: string,
  filesAdded: number,
  filesModified: number,
  filesRemoved: number,
): void {
  try {
    const payload: ResourceSyncedPayload = {
      resource_id: resourceId,
      commit_hash: commitHash,
      commit_message: commitMessage,
      pusher_agent_id: pusherAgentId,
      files_added: filesAdded,
      files_modified: filesModified,
      files_removed: filesRemoved,
    };

    recordEventOnAllGroups('resource_synced', payload);
  } catch (err) {
    console.error('[Sync Hook] onResourceSynced failed:', (err as Error).message);
  }
}
