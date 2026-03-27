/**
 * Local Resource File Watcher
 *
 * Watches local memory_bank and skill resources for filesystem changes.
 * When changes are detected, broadcasts realtime events so the UI updates
 * without requiring a MAP sync round-trip.
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { broadcastToChannel } from '../realtime/index.js';
import { getDatabase } from '../db/index.js';
import type { SyncableResource } from '../types.js';

interface WatchedResource {
  resource: SyncableResource;
  watcher: FSWatcher;
}

const watchers = new Map<string, WatchedResource>();

// Debounce: ignore rapid sequential changes (e.g., editor save + auto-format)
const DEBOUNCE_MS = 1000;
const pendingBroadcasts = new Map<string, ReturnType<typeof setTimeout>>();

function debouncedBroadcast(resourceId: string, resourceType: string): void {
  const existing = pendingBroadcasts.get(resourceId);
  if (existing) clearTimeout(existing);

  pendingBroadcasts.set(resourceId, setTimeout(() => {
    pendingBroadcasts.delete(resourceId);

    const eventType = resourceType === 'memory_bank' ? 'memory:sync' : 'skill:sync';
    broadcastToChannel(`resource:${resourceType}:${resourceId}`, {
      type: eventType as 'memory:sync' | 'skill:sync',
      data: {
        resource_id: resourceId,
        resource_type: resourceType,
        source: 'local_watcher',
      },
    });

    // Also broadcast on the generic channel for useResourcesRealtime
    broadcastToChannel('global', {
      type: 'resource_synced',
      data: {
        resource_id: resourceId,
        resource_type: resourceType,
        source: 'local_watcher',
      },
    });
  }, DEBOUNCE_MS));
}

function watchResource(resource: SyncableResource): void {
  if (watchers.has(resource.id)) return;
  if (!resource.local_path) return;

  const watcher = chokidar.watch(resource.local_path, {
    ignoreInitial: true,
    ignored: [/node_modules/, /\.git/, /index\.db/, /\.cache/],
    depth: 3,
  });

  watcher.on('add', () => debouncedBroadcast(resource.id, resource.resource_type));
  watcher.on('change', () => debouncedBroadcast(resource.id, resource.resource_type));
  watcher.on('unlink', () => debouncedBroadcast(resource.id, resource.resource_type));

  watchers.set(resource.id, { resource, watcher });
}

function unwatchResource(resourceId: string): void {
  const entry = watchers.get(resourceId);
  if (entry) {
    entry.watcher.close();
    watchers.delete(resourceId);
  }
  const pending = pendingBroadcasts.get(resourceId);
  if (pending) {
    clearTimeout(pending);
    pendingBroadcasts.delete(resourceId);
  }
}

/**
 * Start watching all local resources (memory_bank and skill types with local paths).
 * Call this after server startup and after discovery.
 */
export async function startLocalResourceWatchers(): Promise<void> {
  const db = getDatabase();
  const rows = db.prepare(
    `SELECT * FROM syncable_resources
     WHERE resource_type IN ('memory_bank', 'skill')
       AND sync_strategy = 'local'
       AND local_path IS NOT NULL`
  ).all() as SyncableResource[];

  for (const resource of rows) {
    watchResource(resource);
  }
}

/**
 * Watch a newly discovered or created resource.
 */
export function watchNewResource(resource: SyncableResource): void {
  if (resource.local_path && resource.sync_strategy === 'local') {
    watchResource(resource);
  }
}

/**
 * Stop all watchers (for graceful shutdown).
 */
export function stopLocalResourceWatchers(): void {
  for (const [id] of watchers) {
    unwatchResource(id);
  }
}
