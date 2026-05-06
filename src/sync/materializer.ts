/**
 * Event Materializer
 *
 * Materializes sync events into local state. The social-layer event types
 * (post_created, comment_created, vote_cast, etc.) were dropped with the
 * rest of the social surface; the mesh now only replicates resources and
 * coordination messages across openhive instances. Inbound events of the
 * removed types are logged and ignored for backward-compat with peers on
 * older versions.
 */

import { getDatabase } from '../db/index.js';
import { nanoid } from 'nanoid';
import { upsertRemoteAgent } from '../db/dal/remote-agents.js';
import {
  countPendingEvents, trimPendingEvents,
} from '../db/dal/sync-events.js';
import { createSyncEvent, findResourceById } from '../db/dal/syncable-resources.js';
import * as coordinationDal from '../db/dal/coordination.js';
import { broadcastToChannel } from '../realtime/index.js';
import { getMaterializerRepo } from './materializer-repo.js';
import { getSyncOrchestrator } from './sync-orchestrator.js';
import type {
  HiveEvent,
  ResourcePublishedPayload,
  ResourceUpdatedPayload,
  ResourceUnpublishedPayload,
  ResourceSyncedPayload,
  ResourceRedactedPayload,
  ResourceArchivedPayload,
  ResourceMergedPayload,
  CoordinationMessagePayload,
  AgentSnapshot,
} from './types.js';

/** Resolve an agent snapshot to a local ID — upserts into remote_agents_cache for remote agents. */
function resolveAuthor(author: AgentSnapshot, isLocal: boolean): { authorId: string; remoteAuthorId: string | null } {
  if (isLocal) {
    return { authorId: author.agent_id, remoteAuthorId: null };
  }
  const remoteAgent = upsertRemoteAgent({
    origin_instance_id: author.instance_id,
    origin_agent_id: author.agent_id,
    name: author.name,
    avatar_url: author.avatar_url,
  });
  return { authorId: author.agent_id, remoteAuthorId: remoteAgent.id };
}

const syncLogger = {
  info: (message: string, ctx?: Record<string, unknown>) => {
    console.info(`[Sync Materializer] ${message}`, ctx ? JSON.stringify(ctx) : '');
  },
  warn: (message: string, ctx?: Record<string, unknown>) => {
    console.warn(`[Sync Materializer] ${message}`, ctx ? JSON.stringify(ctx) : '');
  },
  error: (message: string, ctx?: Record<string, unknown>) => {
    console.error(`[Sync Materializer] ${message}`, ctx ? JSON.stringify(ctx) : '');
  },
};

const DEPRECATED_EVENT_TYPES = new Set([
  'post_created',
  'post_updated',
  'post_deleted',
  'comment_created',
  'comment_updated',
  'comment_deleted',
  'vote_cast',
  'coordination_task_offered',
  'coordination_task_claimed',
  'coordination_task_completed',
]);

/** Materialize a single event into the local database. */
export function materializeEvent(event: HiveEvent, _hiveId: string, _hiveName: string, isLocal: boolean): void {
  const payload = JSON.parse(event.payload);

  if (DEPRECATED_EVENT_TYPES.has(event.event_type)) {
    syncLogger.info(`Skipping deprecated ${event.event_type} event`, {
      event_id: event.id,
      origin: event.origin_instance_id,
    });
    return;
  }

  switch (event.event_type) {
    case 'resource_published':
      materializeResourcePublished(event, payload as ResourcePublishedPayload, isLocal);
      break;
    case 'resource_updated':
      materializeResourceUpdated(event, payload as ResourceUpdatedPayload);
      break;
    case 'resource_unpublished':
      materializeResourceUnpublished(event, payload as ResourceUnpublishedPayload);
      break;
    case 'resource_synced':
      materializeResourceSynced(event, payload as ResourceSyncedPayload);
      break;
    case 'resource_redacted':
      materializeResourceRedacted(event, payload as ResourceRedactedPayload);
      break;
    case 'resource_archived':
      materializeResourceArchived(event, payload as ResourceArchivedPayload);
      break;
    case 'resource_merged':
      materializeResourceMerged(event, payload as ResourceMergedPayload);
      break;
    case 'coordination_message':
      materializeCoordinationMessage(event, payload as CoordinationMessagePayload);
      break;
    default:
      syncLogger.warn(`Unknown event type: ${event.event_type}`, { event_id: event.id });
  }
}

/** Process a batch of events in sequence order */
export function materializeBatch(events: HiveEvent[], hiveId: string, hiveName: string, localInstanceId: string): void {
  for (const event of events) {
    const isLocal = event.origin_instance_id === localInstanceId;
    try {
      materializeEvent(event, hiveId, hiveName, isLocal);
    } catch (err) {
      syncLogger.error(`Failed to materialize event ${event.id}`, {
        event_type: event.event_type,
        error: (err as Error).message,
      });
    }
  }
}

// ── Post Materialization ────────────────────────────────────────

function materializeResourcePublished(event: HiveEvent, payload: ResourcePublishedPayload, isLocal: boolean): void {
  const repo = getMaterializerRepo();

  const existing = repo.findResourceByOrigin(event.origin_instance_id, payload.resource_id);
  if (existing) return;

  const { authorId } = resolveAuthor(payload.owner, isLocal);
  const id = `rr_${nanoid()}`;
  const createdAt = new Date(event.origin_ts).toISOString();

  repo.upsertRemoteResource({
    id, resource_type: payload.resource_type, name: payload.name,
    description: payload.description, git_remote_url: payload.git_remote_url,
    visibility: payload.visibility, owner_agent_id: authorId,
    sync_event_id: event.id, origin_instance_id: event.origin_instance_id,
    origin_resource_id: payload.resource_id,
    metadata: payload.metadata ? JSON.stringify(payload.metadata) : null,
    created_at: createdAt,
  });

  broadcastToChannel(`resource:${payload.resource_type}:${id}`, {
    type: 'resource_published',
    data: {
      resource_id: id,
      resource_type: payload.resource_type,
      name: payload.name,
      visibility: payload.visibility,
      origin_instance_id: event.origin_instance_id,
    },
  });

  syncLogger.info('Materialized resource_published', { resource_id: id, origin: event.origin_instance_id });
}

function materializeResourceUpdated(event: HiveEvent, payload: ResourceUpdatedPayload): void {
  const repo = getMaterializerRepo();

  const resource = repo.findResourceByOrigin(event.origin_instance_id, payload.resource_id);
  if (!resource) {
    syncLogger.warn('resource_updated for unknown resource', { resource_id: payload.resource_id, origin: event.origin_instance_id });
    return;
  }

  if (resource.updated_at) {
    const existingTs = new Date(resource.updated_at).getTime();
    if (event.origin_ts <= existingTs) {
      syncLogger.info('Skipping stale resource_updated (last-writer-wins)', {
        resource_id: resource.id,
        event_ts: event.origin_ts,
        existing_ts: existingTs,
      });
      return;
    }
  }

  const eventTs = new Date(event.origin_ts).toISOString();
  const f = payload.fields;
  const hasUpdates = f.name !== undefined || f.description !== undefined || f.visibility !== undefined || f.metadata !== undefined;
  if (!hasUpdates) return;

  repo.updateRemoteResource(resource.id, {
    name: f.name, description: f.description, visibility: f.visibility,
    metadata: f.metadata ? JSON.stringify(f.metadata) : undefined,
    updated_at: eventTs,
  });

  syncLogger.info('Materialized resource_updated', { resource_id: resource.id });
}

function materializeResourceUnpublished(event: HiveEvent, payload: ResourceUnpublishedPayload): void {
  const repo = getMaterializerRepo();

  const resource = repo.findResourceByOrigin(event.origin_instance_id, payload.resource_id);
  if (!resource) return;

  broadcastToChannel(`resource:${resource.resource_type}:${resource.id}`, {
    type: 'resource_unpublished',
    data: {
      resource_id: resource.id,
      resource_type: resource.resource_type,
      origin_instance_id: event.origin_instance_id,
    },
  });

  // Clean up local clones/caches before deleting the resource
  const fullResource = findResourceById(resource.id);
  if (fullResource) {
    getSyncOrchestrator().cleanup(fullResource).catch((err) => {
      syncLogger.error('SyncOrchestrator.cleanup failed', {
        resource_id: resource.id,
        error: (err as Error).message,
      });
    });
  }

  repo.deleteRemoteResource(resource.id);
  syncLogger.info('Materialized resource_unpublished', { resource_id: resource.id });
}

function materializeResourceSynced(event: HiveEvent, payload: ResourceSyncedPayload): void {
  const repo = getMaterializerRepo();

  const resource = repo.findResourceByOrigin(event.origin_instance_id, payload.resource_id);
  if (!resource) {
    syncLogger.warn('resource_synced for unknown resource', { resource_id: payload.resource_id, origin: event.origin_instance_id });
    return;
  }

  const eventTs = new Date(event.origin_ts).toISOString();
  repo.updateResourceCommit(resource.id, payload.commit_hash, eventTs);

  const syncEvent = createSyncEvent({
    resource_id: resource.id,
    commit_hash: payload.commit_hash,
    commit_message: payload.commit_message ?? undefined,
    pusher: `sync:${payload.pusher_agent_id}`,
    files_added: payload.files_added,
    files_modified: payload.files_modified,
    files_removed: payload.files_removed,
  });

  broadcastToChannel(`resource:${resource.resource_type}:${resource.id}`, {
    type: 'resource_synced',
    data: {
      resource_id: resource.id,
      resource_type: resource.resource_type,
      commit_hash: payload.commit_hash,
      commit_message: payload.commit_message,
      pusher_agent_id: payload.pusher_agent_id,
      event_id: syncEvent.id,
      origin_instance_id: event.origin_instance_id,
    },
  });

  // Dispatch to sync orchestrator for strategy-specific content handling
  // (e.g., mirror fetches immediately, ls-remote marks stale)
  const fullResource = findResourceById(resource.id);
  if (fullResource) {
    getSyncOrchestrator().handleSyncEvent(fullResource, payload.commit_hash).catch((err) => {
      syncLogger.error('SyncOrchestrator.handleSyncEvent failed', {
        resource_id: resource.id,
        error: (err as Error).message,
      });
    });
  }

  syncLogger.info('Materialized resource_synced', { resource_id: resource.id, commit: payload.commit_hash });
}

// ── Coordination Materialization ────────────────────────────────

function materializeCoordinationMessage(event: HiveEvent, payload: CoordinationMessagePayload): void {
  // Idempotency: check if message already exists by origin tracking
  const existing = coordinationDal.findMessageByOrigin(event.origin_instance_id, payload.message_id);
  if (existing) return;

  const msg = coordinationDal.createMessage({
    hive_id: payload.hive_id ?? undefined,
    from_swarm_id: payload.from_swarm_id,
    to_swarm_id: payload.to_swarm_id ?? '',
    content_type: payload.content_type,
    content: typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content),
    reply_to: payload.reply_to ?? undefined,
    metadata: payload.metadata ?? undefined,
    origin_instance_id: event.origin_instance_id,
    origin_message_id: payload.message_id,
  });

  const channel = payload.hive_id
    ? `coordination:${payload.hive_id}`
    : `swarm:${payload.to_swarm_id}`;
  broadcastToChannel(channel, {
    type: 'swarm_message_received',
    data: {
      message_id: msg.id,
      from_swarm_id: payload.from_swarm_id,
      origin_instance_id: event.origin_instance_id,
    },
  });

  syncLogger.info('Materialized coordination_message', { message_id: msg.id, origin: event.origin_instance_id });
}

// ── Pending Queue Processing ────────────────────────────────────

/** Process pending events whose dependencies are now satisfied.
 *  GAP-12: Enforces a per-sync-group cap on pending events (maxPendingEvents).
 */
export function processPendingQueue(syncGroupId: string, hiveId: string, hiveName: string, localInstanceId: string, maxPendingEvents: number = 1000): number {
  const db = getDatabase();
  const repo = getMaterializerRepo();

  // GAP-12: Enforce pending queue cap before processing
  const pendingCount = countPendingEvents(syncGroupId);
  if (pendingCount > maxPendingEvents) {
    const trimmed = trimPendingEvents(syncGroupId, maxPendingEvents);
    if (trimmed > 0) {
      syncLogger.warn('Trimmed pending event queue (GAP-12 cap exceeded)', {
        sync_group_id: syncGroupId,
        trimmed,
        remaining: maxPendingEvents,
      });
    }
  }

  const pending = db.prepare(
    'SELECT * FROM hive_events_pending WHERE sync_group_id = ? ORDER BY received_at ASC'
  ).all(syncGroupId) as Array<{ id: string; event_json: string; depends_on: string }>;

  let processed = 0;

  for (const p of pending) {
    const deps = JSON.parse(p.depends_on) as string[];
    // Check if all dependencies are satisfied (posts/comments exist)
    const allSatisfied = deps.every(dep => {
      const post = repo.findPostByOriginOrId(dep);
      const comment = repo.findCommentByOriginOrId(dep);
      return post || comment;
    });

    if (allSatisfied) {
      const event = JSON.parse(p.event_json) as HiveEvent;
      const isLocal = event.origin_instance_id === localInstanceId;
      materializeEvent(event, hiveId, hiveName, isLocal);
      db.prepare('DELETE FROM hive_events_pending WHERE id = ?').run(p.id);
      processed++;
    }
  }

  return processed;
}

// ── Mesh Lifecycle Materializers (slice 5b) ────────────────────────────────

/**
 * Mark a resource as redacted from federation. Doesn't delete the row —
 * peers retain it as a tombstone (with new_visibility recorded in
 * metadata) so cross-mesh queries can filter rather than 404.
 *
 * Local workspace bindings are NOT touched: bindings are local state and
 * a federation-tier change on the abstract repo doesn't invalidate
 * already-attached working copies. The agent's own retract path is the
 * right place for that.
 */
function materializeResourceRedacted(event: HiveEvent, payload: ResourceRedactedPayload): void {
  const repo = getMaterializerRepo();
  const resource = repo.findResourceByCanonicalUrl(payload.resource_type, payload.canonical_url);
  if (!resource) {
    syncLogger.info('resource_redacted for unknown resource — ignoring', {
      resource_type: payload.resource_type,
      canonical_url: payload.canonical_url,
      origin: event.origin_instance_id,
    });
    return;
  }

  const meta = resource.metadata ? JSON.parse(resource.metadata) : {};
  meta.visibility = payload.new_visibility;
  meta.redacted_at = payload.redacted_at;
  meta.redacted_by = payload.origin_hub_id;

  repo.updateResourceStatus(resource.id, 'redacted_remote', JSON.stringify(meta));

  broadcastToChannel(`resource:${resource.resource_type}:${resource.id}`, {
    type: 'resource_redacted' as const,
    data: {
      resource_id: resource.id,
      resource_type: resource.resource_type,
      canonical_url: payload.canonical_url,
      new_visibility: payload.new_visibility,
      origin_hub_id: payload.origin_hub_id,
    },
  });

  syncLogger.info('Materialized resource_redacted', {
    resource_id: resource.id,
    new_visibility: payload.new_visibility,
  });
}

/**
 * Mark a resource as archived. Resources are never hard-deleted — peers
 * retain the row so links from other resources (cascade artifacts,
 * dispatches, etc.) don't dangle.
 */
function materializeResourceArchived(_event: HiveEvent, payload: ResourceArchivedPayload): void {
  const repo = getMaterializerRepo();
  const resource = repo.findResourceByCanonicalUrl(payload.resource_type, payload.canonical_url);
  if (!resource) {
    syncLogger.info('resource_archived for unknown resource — ignoring', {
      resource_type: payload.resource_type,
      canonical_url: payload.canonical_url,
    });
    return;
  }

  const meta = resource.metadata ? JSON.parse(resource.metadata) : {};
  meta.archived_at = payload.archived_at;
  meta.archived_by = payload.origin_hub_id;

  repo.updateResourceStatus(resource.id, 'archived', JSON.stringify(meta));

  broadcastToChannel(`resource:${resource.resource_type}:${resource.id}`, {
    type: 'resource_archived' as const,
    data: {
      resource_id: resource.id,
      resource_type: resource.resource_type,
      canonical_url: payload.canonical_url,
      origin_hub_id: payload.origin_hub_id,
    },
  });

  syncLogger.info('Materialized resource_archived', { resource_id: resource.id });
}

/**
 * Mark a source resource as merged into a target. Stores the target
 * canonical URL in metadata as a forwarding pointer; references to the
 * source can transparently follow it. The source row stays as a
 * tombstone — chains terminate because merges are write-once.
 *
 * Race resolution between conflicting merges from two hubs is the
 * caller's responsibility (see `compareMergeEvents` in the package's
 * `protocol/resource-events.ts`).
 */
function materializeResourceMerged(_event: HiveEvent, payload: ResourceMergedPayload): void {
  const repo = getMaterializerRepo();
  const source = repo.findResourceByCanonicalUrl(payload.resource_type, payload.source_canonical_url);
  if (!source) {
    syncLogger.info('resource_merged for unknown source — ignoring', {
      resource_type: payload.resource_type,
      source: payload.source_canonical_url,
    });
    return;
  }

  const meta = source.metadata ? JSON.parse(source.metadata) : {};
  meta.merged_into_canonical_url = payload.target_canonical_url;
  meta.merged_at = payload.merged_at;
  meta.merged_by = payload.origin_hub_id;

  repo.updateResourceStatus(source.id, 'merged_into', JSON.stringify(meta));

  broadcastToChannel(`resource:${source.resource_type}:${source.id}`, {
    type: 'resource_merged' as const,
    data: {
      resource_id: source.id,
      resource_type: source.resource_type,
      source_canonical_url: payload.source_canonical_url,
      target_canonical_url: payload.target_canonical_url,
      origin_hub_id: payload.origin_hub_id,
    },
  });

  syncLogger.info('Materialized resource_merged', {
    resource_id: source.id,
    target: payload.target_canonical_url,
  });
}
