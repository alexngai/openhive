/**
 * Auto-Pull Service
 *
 * Periodically checks git-backed resources for new commits and pulls
 * them automatically when autoPull is enabled in the resource config.
 *
 * Supports all resource types: task (OpenTasks), memory_bank, skill, etc.
 * Runs server-side, independent of any frontend connection.
 */

import { getDatabase } from '../db/index.js';
import { pullFromRemote, getGitSyncStatus } from './git-content.js';
import { broadcastToChannel } from '../realtime/index.js';

// Default: check every 2 minutes
const DEFAULT_POLL_INTERVAL_MS = 2 * 60 * 1000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Check if a resource has autoPull enabled.
 *
 * Supports multiple config locations:
 * - OpenTasks: metadata.opentasks_config.sync.git.autoPull
 * - Generic:   metadata.sync.git.autoPull
 * - Git block: metadata.git.autoPull
 * - Top-level: metadata.autoPull
 */
function hasAutoPull(resource: { metadata: Record<string, unknown> | null }): boolean {
  const meta = resource.metadata;
  if (!meta) return false;

  // Direct flag
  if (meta.autoPull) return true;

  // Git block (e.g. metadata.git.autoPull — used by team_template rows)
  const gitBlock = meta.git as Record<string, unknown> | undefined;
  if (gitBlock?.autoPull) return true;

  // OpenTasks config path
  const otConfig = meta.opentasks_config as Record<string, unknown> | undefined;
  if (otConfig) {
    const syncConfig = otConfig.sync as Record<string, unknown> | undefined;
    const gitConfig = syncConfig?.git as Record<string, unknown> | undefined;
    if (gitConfig?.autoPull) return true;
  }

  // Generic sync config path (for memory_bank, skill, etc.)
  const syncConfig = meta.sync as Record<string, unknown> | undefined;
  if (syncConfig) {
    const gitConfig = syncConfig.git as Record<string, unknown> | undefined;
    if (gitConfig?.autoPull) return true;
  }

  return false;
}

/**
 * Run a single auto-pull sweep across all git-backed resources with autoPull enabled.
 */
/**
 * Run one auto-pull sweep. Exported for tests that need to trigger the
 * cycle deterministically rather than wait for the 2-min poll. Production
 * call sites use `startAutoPull` to schedule periodic invocations.
 */
export async function runAutoPullSweep(): Promise<void> {
  if (running) return; // Prevent overlapping sweeps
  running = true;

  try {
    // Query all git-backed resources directly — bypasses agent access filtering
    const db = getDatabase();
    const rows = db.prepare(
      `SELECT * FROM syncable_resources WHERE local_path IS NOT NULL AND local_path != ''`,
    ).all() as Record<string, unknown>[];

    const autoPullResources = rows
      .map((row) => {
        let metadata: Record<string, unknown> | null = null;
        try { metadata = row.metadata ? JSON.parse(row.metadata as string) : null; } catch { /* ignore */ }
        return {
          id: row.id as string,
          name: row.name as string,
          resource_type: row.resource_type as string,
          local_path: row.local_path as string,
          metadata,
        };
      })
      .filter((r) => hasAutoPull(r));

    if (autoPullResources.length === 0) return;

    for (const resource of autoPullResources) {
      try {
        // Check if there are unpulled commits
        const status = await getGitSyncStatus(resource.local_path!);
        if (status.unpulledCommits <= 0) continue;

        // Pull
        const result = await pullFromRemote(resource.local_path!);
        if (result.pulled) {
          console.log(
            `[auto-pull] Pulled ${status.unpulledCommits} commit(s) for ${resource.resource_type} "${resource.name}" (${resource.id})`,
          );

          // Broadcast so WebSocket subscribers + React Query get updated
          broadcastToChannel('global', {
            type: 'resource_synced',
            data: { resource_id: resource.id, commit_hash: result.newHead || '', source: 'auto-pull' },
          });

          // Layer 6 — re-bundle openteams rows whose checkout just
          // advanced so the in-memory MAP bundle store reflects the new
          // hash. Other resource types (skills, memory_banks) don't have
          // a bundle store; they rely on their own content endpoints.
          if (resource.resource_type === 'team_template' || resource.resource_type === 'loadout') {
            try {
              const { onLoadoutBundle, onTeamTemplateBundle } = await import('../openteams/sync-bridge.js');
              const { findResourceById } = await import('../db/dal/syncable-resources.js');
              const fresh = findResourceById(resource.id);
              if (fresh) {
                await (resource.resource_type === 'loadout'
                  ? onLoadoutBundle(fresh)
                  : onTeamTemplateBundle(fresh));
              }
            } catch (rebundleErr) {
              console.warn(
                `[auto-pull] re-bundle failed for ${resource.resource_type} ${resource.id}: ${(rebundleErr as Error).message}`,
              );
            }
          }
        }
      } catch (err) {
        console.warn(
          `[auto-pull] Failed for ${resource.resource_type} "${resource.name}" (${resource.id}): ${(err as Error).message}`,
        );
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Start the auto-pull service.
 * @param intervalMs - Poll interval in milliseconds (default: 2 minutes)
 */
export function startAutoPull(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
  if (pollTimer) return; // Already running

  console.log(`[auto-pull] Starting with ${intervalMs / 1000}s interval`);

  // Run first sweep after a short delay (let server finish startup)
  setTimeout(() => runAutoPullSweep(), 5_000);

  pollTimer = setInterval(() => {
    runAutoPullSweep().catch((err) => {
      console.warn(`[auto-pull] Sweep error: ${(err as Error).message}`);
    });
  }, intervalMs);
}

/**
 * Stop the auto-pull service.
 */
export function stopAutoPull(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[auto-pull] Stopped');
  }
}
