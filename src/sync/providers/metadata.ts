/**
 * MetadataProvider — no-op content provider (current default behavior).
 *
 * Tracks that a resource exists and its latest commit hash, but never
 * fetches actual content. Content API queries return null.
 */
import type { SyncableResource } from '../../types.js';
import type { SyncProvider } from './types.js';

export class MetadataProvider implements SyncProvider {
  readonly strategy = 'metadata' as const;

  async onSyncEvent(_resource: SyncableResource, _commitHash: string): Promise<boolean> {
    // No-op: metadata strategy only tracks commit hashes (handled by materializer)
    return false;
  }

  async ensureContent(_resource: SyncableResource): Promise<string | null> {
    // Content not available locally for metadata-only resources
    return null;
  }

  async resolveGraphPath(_resource: SyncableResource): Promise<string | null> {
    return null;
  }

  async cleanup(_resource: SyncableResource): Promise<void> {
    // Nothing to clean up
  }
}
