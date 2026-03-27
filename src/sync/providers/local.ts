/**
 * LocalProvider — direct filesystem reads for locally-discovered resources.
 *
 * No git overhead: reads directly from the local_path or git_remote_url.
 * The filesystem is the source of truth; sync events are ignored.
 */
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { SyncableResource } from '../../types.js';
import type { SyncProvider } from './types.js';

export class LocalProvider implements SyncProvider {
  readonly strategy = 'local' as const;

  async onSyncEvent(_resource: SyncableResource, _commitHash: string): Promise<boolean> {
    // Ignored: local filesystem is source of truth, not remote sync events
    return false;
  }

  async ensureContent(resource: SyncableResource): Promise<string | null> {
    const localPath = this.resolveLocalDir(resource);
    if (localPath && existsSync(localPath)) {
      return localPath;
    }
    return null;
  }

  async resolveGraphPath(resource: SyncableResource): Promise<string | null> {
    const localPath = this.resolveLocalDir(resource);
    if (!localPath) return null;

    // Check for graph.jsonl directly in the path (if path IS the .opentasks dir)
    const graphDirect = join(localPath, 'graph.jsonl');
    if (existsSync(graphDirect)) return localPath;

    // Check for .opentasks subdirectory
    const opentasksDir = join(localPath, '.opentasks');
    const graphNested = join(opentasksDir, 'graph.jsonl');
    if (existsSync(graphNested)) return opentasksDir;

    // No graph.jsonl found in either location
    return null;
  }

  async cleanup(_resource: SyncableResource): Promise<void> {
    // Nothing to clean up for local resources
  }

  /** Resolve the effective local directory for this resource */
  private resolveLocalDir(resource: SyncableResource): string | null {
    // Prefer explicit local_path
    if (resource.local_path) {
      return resolve(resource.local_path);
    }

    // Fall back to git_remote_url if it's a local path
    const url = resource.git_remote_url;
    if (url && !url.startsWith('http') && !url.startsWith('git://') && !url.startsWith('ssh://')) {
      return resolve(url);
    }

    return null;
  }
}
