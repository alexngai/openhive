/**
 * SyncOrchestrator — dispatches sync operations to the appropriate SyncProvider
 * based on each resource's sync_strategy field.
 *
 * Sits between the materializer/content API and the provider implementations.
 * Supports all registered strategies (metadata, local, ls-remote, mirror, bundle).
 * New strategies can be added via registerProvider().
 */
import type { SyncableResource } from '../types.js';
import { getProvider } from './providers/index.js';
import { broadcastToChannel } from '../realtime/index.js';

let instance: SyncOrchestrator | null = null;

export class SyncOrchestrator {
  /**
   * Called by materializer when a resource_synced event arrives.
   * Dispatches to the provider's onSyncEvent handler.
   */
  async handleSyncEvent(resource: SyncableResource, commitHash: string): Promise<void> {
    const provider = getProvider(resource.sync_strategy);
    const updated = await provider.onSyncEvent(resource, commitHash);
    if (updated) {
      broadcastToChannel(`resource:${resource.resource_type}:${resource.id}`, {
        type: 'resource_synced',
        data: { resource_id: resource.id, commit_hash: commitHash },
      });
    }
  }

  /**
   * Called by content API before reading graph data.
   * Ensures content is available locally (triggers clone/fetch for lazy strategies).
   * Returns the local path or null if content is unavailable.
   */
  async ensureContent(resource: SyncableResource): Promise<string | null> {
    const provider = getProvider(resource.sync_strategy);
    return provider.ensureContent(resource);
  }

  /**
   * Resolve the local graph path for an OpenTasks resource.
   */
  async resolveGraphPath(resource: SyncableResource): Promise<string | null> {
    const provider = getProvider(resource.sync_strategy);
    return provider.resolveGraphPath(resource);
  }

  /**
   * Called on unsubscribe/unpublish to clean up local state.
   */
  async cleanup(resource: SyncableResource): Promise<void> {
    const provider = getProvider(resource.sync_strategy);
    return provider.cleanup(resource);
  }
}

export function initSyncOrchestrator(): SyncOrchestrator {
  if (!instance) {
    instance = new SyncOrchestrator();
  }
  return instance;
}

export function getSyncOrchestrator(): SyncOrchestrator {
  if (!instance) {
    instance = new SyncOrchestrator();
  }
  return instance;
}
