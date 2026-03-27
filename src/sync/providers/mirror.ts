/**
 * MirrorProvider — eager clone strategy.
 *
 * Fetches immediately on every sync event. Content is always fresh.
 * Clone is created on first sync event or when ensureContent is first called.
 */

import type { SyncableResource } from '../../types.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as gitContent from '../git-content.js';
import type { SyncProvider } from './types.js';

export class MirrorProvider implements SyncProvider {
  readonly strategy = 'mirror' as const;

  constructor(
    private readonly dataDir: string,
    private readonly fetchTimeout: number = 30_000,
  ) {}

  async onSyncEvent(resource: SyncableResource, _commitHash: string): Promise<boolean> {
    if (!resource.git_remote_url) return false;

    try {
      const clonePath = await gitContent.ensureClone(resource, this.dataDir, this.fetchTimeout);

      // Always fetch latest on sync event (eager)
      const result = await gitContent.fetchLatest(clonePath, this.fetchTimeout);

      // Persist local_path if not already set
      if (!resource.local_path) {
        resourcesDAL.updateLocalPath(resource.id, clonePath);
      }

      return result.changed;
    } catch {
      return false;
    }
  }

  async ensureContent(resource: SyncableResource): Promise<string | null> {
    if (!resource.git_remote_url) return null;

    try {
      const clonePath = await gitContent.ensureClone(resource, this.dataDir, this.fetchTimeout);

      if (!resource.local_path) {
        resourcesDAL.updateLocalPath(resource.id, clonePath);
      }

      return clonePath;
    } catch {
      return null;
    }
  }

  async resolveGraphPath(resource: SyncableResource): Promise<string | null> {
    const contentPath = await this.ensureContent(resource);
    if (!contentPath) return null;
    return gitContent.resolveGraphPath(contentPath);
  }

  async cleanup(resource: SyncableResource): Promise<void> {
    await gitContent.removeClone(this.dataDir, resource.id);
    resourcesDAL.updateLocalPath(resource.id, null);
  }
}
