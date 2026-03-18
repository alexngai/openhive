/**
 * SyncProvider interface — strategy pattern for resource content acquisition.
 *
 * Each sync strategy (metadata, local, ls-remote, mirror, bundle) implements
 * this interface. The SyncOrchestrator dispatches to the appropriate provider
 * based on resource.sync_strategy.
 */
import type { SyncableResource, SyncStrategy } from '../../types.js';

export { SyncStrategy };

export interface SyncProvider {
  readonly strategy: SyncStrategy;

  /**
   * Called when a resource_synced event arrives for a resource using this strategy.
   * Returns true if local content was updated.
   */
  onSyncEvent(resource: SyncableResource, commitHash: string): Promise<boolean>;

  /**
   * Ensure content is available locally for reading.
   * For eager strategies (mirror), this is a no-op.
   * For lazy strategies (ls-remote), this triggers clone/fetch if stale.
   * For metadata-only, this returns null (content not available).
   * Returns the local filesystem path to the content, or null.
   */
  ensureContent(resource: SyncableResource): Promise<string | null>;

  /**
   * Resolve the local filesystem path to the graph content.
   * Returns null if content is not available locally.
   */
  resolveGraphPath(resource: SyncableResource): Promise<string | null>;

  /**
   * Clean up any local state (clones, caches) for this resource.
   */
  cleanup(resource: SyncableResource): Promise<void>;
}
