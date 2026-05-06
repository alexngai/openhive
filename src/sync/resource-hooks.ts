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
import { mapHubEvents } from '../map/service.js';
import { findAgentById } from '../db/dal/agents.js';
import type { Agent, SyncableResource } from '../types.js';
import type {
  HiveEventType,
  AgentSnapshot,
  SyncGroup,
  ResourcePublishedPayload,
  ResourceUpdatedPayload,
  ResourceUnpublishedPayload,
  ResourceSyncedPayload,
  ResourceRedactedPayload,
  ResourceArchivedPayload,
  ResourceMergedPayload,
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

    // Emit for SwarmCraft bridge
    mapHubEvents.emit('resource_published', {
      resource_id: resource.id,
      resource_type: resource.resource_type,
      name: resource.name,
      owner_agent_id: agent.id,
    });
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

    // Emit for SwarmCraft bridge
    mapHubEvents.emit('resource_updated', {
      resource_id: resourceId,
      fields,
      owner_agent_id: agent.id,
    });
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

/**
 * Fire `resource_published` for a federated repo so peer hubs materialize
 * it. Repos created at `'private' | 'hub_local'` visibility are intentionally
 * silent — federation is opt-in per the package's visibility model.
 *
 * Owner agent is looked up by id (the DAL doesn't carry auth context).
 * Best-effort: missing owner / no sync groups → silent skip.
 */
export function onRepoPublished(repo: SyncableResource): void {
  try {
    const meta = (repo.metadata ?? {}) as { visibility?: string };
    if (meta.visibility !== 'federated') return;

    const owner = findAgentById(repo.owner_agent_id);
    if (!owner) return;

    const groups = listSyncGroups();
    if (groups.length === 0) return;

    const instanceId = getInstanceId(groups[0]);
    const payload: ResourcePublishedPayload = {
      resource_id: repo.id,
      resource_type: 'repo',
      name: repo.name,
      description: repo.description,
      git_remote_url: repo.git_remote_url,
      // Column-level visibility — repos federate via metadata.visibility,
      // not the column-level value. The column stays 'shared' on the wire
      // so the receiving hub's `upsertRemoteResource` writes a CHECK-valid
      // row; the federation tier travels in metadata intact.
      visibility: 'shared',
      owner: agentToSnapshot(owner, instanceId),
      tags: [],
      metadata: (repo.metadata as Record<string, unknown>) ?? null,
    };

    recordEventOnAllGroups('resource_published', payload);

    mapHubEvents.emit('resource_published', {
      resource_id: repo.id,
      resource_type: 'repo',
      name: repo.name,
      owner_agent_id: owner.id,
    });
  } catch (err) {
    console.error('[Sync Hook] onRepoPublished failed:', (err as Error).message);
  }
}

/**
 * Fire `resource_updated` for a federated repo whose metadata changed
 * (default_branch refresh, branch list updates, etc.). Visibility
 * downgrade (federated → hub_local/private) intentionally does NOT fire
 * here — that's a `resource.redacted` event in slice 5b.
 */
export function onRepoUpdated(repo: SyncableResource): void {
  try {
    const meta = (repo.metadata ?? {}) as { visibility?: string };
    if (meta.visibility !== 'federated') return;

    const owner = findAgentById(repo.owner_agent_id);
    if (!owner) return;

    const groups = listSyncGroups();
    if (groups.length === 0) return;

    const instanceId = getInstanceId(groups[0]);
    const payload: ResourceUpdatedPayload = {
      resource_id: repo.id,
      fields: {
        name: repo.name,
        description: repo.description ?? undefined,
        metadata: (repo.metadata as Record<string, unknown>) ?? undefined,
      },
      updated_by: agentToSnapshot(owner, instanceId),
    };

    recordEventOnAllGroups('resource_updated', payload);
  } catch (err) {
    console.error('[Sync Hook] onRepoUpdated failed:', (err as Error).message);
  }
}

// ── Mesh lifecycle hooks (slice 5b) ─────────────────────────────────────────

/**
 * Fire `resource_redacted` when a federated resource's federation tier
 * narrows (e.g. `'federated' → 'hub_local'`). Peers mark the local row
 * `status='redacted_remote'`. No-op for already-private resources.
 *
 * The `oldVisibility` argument prevents redundant redaction events for
 * resources that were never federated to begin with.
 */
export function onRepoRedacted(
  repo: SyncableResource,
  oldVisibility: string,
  newVisibility: string,
): void {
  try {
    if (oldVisibility !== 'federated' || newVisibility === 'federated') return;

    const groups = listSyncGroups();
    if (groups.length === 0) return;

    const instanceId = getInstanceId(groups[0]);
    const payload: ResourceRedactedPayload = {
      resource_type: 'repo',
      canonical_url: repo.git_remote_url,
      new_visibility: newVisibility,
      redacted_at: new Date().toISOString(),
      origin_hub_id: instanceId,
    };

    recordEventOnAllGroups('resource_redacted', payload);
  } catch (err) {
    console.error('[Sync Hook] onRepoRedacted failed:', (err as Error).message);
  }
}

/**
 * Fire `resource_archived` when a federated resource is archived. Peers
 * mark the local row `status='archived'` while keeping the row + any
 * inbound references intact.
 */
export function onRepoArchived(repo: SyncableResource): void {
  try {
    const meta = (repo.metadata ?? {}) as { visibility?: string };
    if (meta.visibility !== 'federated') return;

    const groups = listSyncGroups();
    if (groups.length === 0) return;

    const instanceId = getInstanceId(groups[0]);
    const payload: ResourceArchivedPayload = {
      resource_type: 'repo',
      canonical_url: repo.git_remote_url,
      archived_at: new Date().toISOString(),
      origin_hub_id: instanceId,
    };

    recordEventOnAllGroups('resource_archived', payload);
  } catch (err) {
    console.error('[Sync Hook] onRepoArchived failed:', (err as Error).message);
  }
}

/**
 * Fire `resource_merged` when one federated repo is merged into another
 * (typically a duplicate canonical URL cleanup). Source becomes a
 * forwarding tombstone; references follow `metadata.merged_into_canonical_url`.
 *
 * Only the source repo receives the lifecycle event; the target survives
 * as the canonical row.
 */
export function onRepoMerged(
  source: SyncableResource,
  targetCanonicalUrl: string,
): void {
  try {
    const meta = (source.metadata ?? {}) as { visibility?: string };
    if (meta.visibility !== 'federated') return;

    const groups = listSyncGroups();
    if (groups.length === 0) return;

    const instanceId = getInstanceId(groups[0]);
    const payload: ResourceMergedPayload = {
      resource_type: 'repo',
      source_canonical_url: source.git_remote_url,
      target_canonical_url: targetCanonicalUrl,
      merged_at: new Date().toISOString(),
      origin_hub_id: instanceId,
    };

    recordEventOnAllGroups('resource_merged', payload);
  } catch (err) {
    console.error('[Sync Hook] onRepoMerged failed:', (err as Error).message);
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

    // Emit for SwarmCraft bridge
    mapHubEvents.emit('resource_synced', {
      resource_id: resourceId,
      commit_hash: commitHash,
      pusher_agent_id: pusherAgentId,
    });
  } catch (err) {
    console.error('[Sync Hook] onResourceSynced failed:', (err as Error).message);
  }
}
