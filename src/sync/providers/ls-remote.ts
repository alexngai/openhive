/**
 * LsRemoteProvider — lazy clone strategy.
 *
 * Clones on first content query. Uses git ls-remote to check freshness.
 * On sync events, marks the clone as stale (doesn't fetch immediately).
 * On content queries, checks staleness and fetches if needed.
 */

import type { SyncableResource } from '../../types.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as gitContent from '../git-content.js';
import type { SyncProvider } from './types.js';

/** Track stale resources in memory (resource_id → stale_since timestamp) */
const staleResources = new Map<string, number>();

export class LsRemoteProvider implements SyncProvider {
  readonly strategy = 'ls-remote' as const;

  constructor(
    private readonly dataDir: string,
    /** TTL in seconds for polling-based freshness checks (future: heartbeat integration) */
    readonly lsRemoteTtl: number = 60,
  ) {}

  async onSyncEvent(resource: SyncableResource, _commitHash: string): Promise<boolean> {
    // Mark as stale — don't fetch yet (lazy)
    staleResources.set(resource.id, Date.now());
    return false;
  }

  async ensureContent(resource: SyncableResource): Promise<string | null> {
    if (!resource.git_remote_url) return null;

    const hasClone = gitContent.hasLocalClone(this.dataDir, resource.id);

    if (!hasClone) {
      // First access: clone the remote
      try {
        const clonePath = await gitContent.ensureClone(resource, this.dataDir);
        // Persist the local_path so future reads can find it
        resourcesDAL.updateLocalPath(resource.id, clonePath);
        staleResources.delete(resource.id);
        return clonePath;
      } catch {
        return null;
      }
    }

    // Clone exists — check if stale
    const clonePath = gitContent.getClonePath(this.dataDir, resource.id);

    if (this.isStale(resource.id)) {
      try {
        const result = await gitContent.fetchLatest(clonePath);
        staleResources.delete(resource.id);
        if (result.changed) {
          resourcesDAL.updateResourceSyncState(resource.id, result.newHead, null);
        }
      } catch {
        // Fetch failed — serve stale content rather than nothing
      }
    }

    return clonePath;
  }

  async resolveGraphPath(resource: SyncableResource): Promise<string | null> {
    const contentPath = await this.ensureContent(resource);
    if (!contentPath) return null;
    return gitContent.resolveGraphPath(contentPath);
  }

  async cleanup(resource: SyncableResource): Promise<void> {
    staleResources.delete(resource.id);
    await gitContent.removeClone(this.dataDir, resource.id);
    resourcesDAL.updateLocalPath(resource.id, null);
  }

  /** Check if the cached clone is stale and should be re-fetched */
  private isStale(resourceId: string): boolean {
    // Resource was marked stale by a sync event — fetch on next content query
    return staleResources.has(resourceId);
  }
}
