/**
 * Git Sync Config — opentasks config.json writer
 *
 * Translates a resource's `metadata.git_sync` (OpenHive's wire shape) into
 * the `sync.git` block that opentasks' daemon lifecycle reads on start.
 *
 * Source of truth is the resource row; this helper keeps the daemon's
 * on-disk config.json in step with it. Called on resource create/update
 * and whenever `git_sync` is toggled.
 *
 * No side effects beyond file I/O on the daemon's config.json. Safe to
 * call repeatedly (merge-preserves any unrelated config keys).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

// ============================================================================
// Schema
// ============================================================================

/**
 * OpenHive's wire shape for `resource.metadata.git_sync`. Mirrors
 * opentasks' `sync.git` config one-to-one plus `pullOnSignal` — an
 * OpenHive-specific flag used by the hub's MAP-event-driven pull
 * trigger (see Item 3 of the git-SSOT work).
 */
export const GitSyncMetadataSchema = z.object({
  enabled: z.boolean(),
  remote: z.string().optional(),
  autoCommit: z.boolean().optional(),
  autoPush: z.boolean().optional(),
  pullOnStartup: z.boolean().optional(),
  pushDebounceMs: z.number().int().min(1000).optional(),
  /**
   * When true (default), the hub's listener fires `sync.pull` on the
   * resource's daemon whenever a MAP `context.*` event arrives for
   * this resource from a peer hub. Turn off if you only want scheduled
   * pulls (e.g. via `pushDebounceMs` on the other side) to converge state.
   */
  pullOnSignal: z.boolean().optional(),
});

export type GitSyncMetadata = z.infer<typeof GitSyncMetadataSchema>;

// ============================================================================
// Config I/O
// ============================================================================

const CONFIG_FILE = 'config.json';

/**
 * Read the existing config.json at `{localPath}/.opentasks/config.json`
 * into a plain object, returning {} if the file does not exist or is
 * unreadable. Never throws.
 */
function readDaemonConfig(localPath: string): Record<string, unknown> {
  const configPath = path.join(localPath, '.opentasks', CONFIG_FILE);
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Write the provided config object back to
 * `{localPath}/.opentasks/config.json`. Ensures the `.opentasks`
 * directory exists. Best-effort — any I/O error propagates to the caller
 * so they can decide whether to fail the request or degrade.
 */
function writeDaemonConfig(localPath: string, config: Record<string, unknown>): void {
  const otDir = path.join(localPath, '.opentasks');
  fs.mkdirSync(otDir, { recursive: true });
  const configPath = path.join(otDir, CONFIG_FILE);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// ============================================================================
// Apply
// ============================================================================

/**
 * Merge the OpenHive `git_sync` metadata into an opentasks `sync.git`
 * config block on disk, preserving unrelated keys.
 *
 * Defaults (when not explicitly set) favor live git sync:
 *   - autoCommit: true
 *   - autoPush: true
 *   - pullOnStartup: true
 *   - remote: 'origin'
 *
 * These match the "git is source of truth, MAP is signaling" stance —
 * if a user flips `enabled: true` on a resource, they almost certainly
 * want the daemon to commit+push automatically. Opt-out is available
 * by setting any field explicitly to false.
 */
export function applyGitSyncConfig(
  localPath: string,
  gitSync: GitSyncMetadata,
): void {
  const config = readDaemonConfig(localPath);
  const prevSync = (config.sync as { git?: Record<string, unknown> } | undefined) ?? {};
  const prevGit = (prevSync.git ?? {}) as Record<string, unknown>;

  const nextGit: Record<string, unknown> = {
    ...prevGit,
    enabled: gitSync.enabled,
    remote: gitSync.remote ?? prevGit.remote ?? 'origin',
    autoCommit: gitSync.autoCommit ?? prevGit.autoCommit ?? true,
    autoPush: gitSync.autoPush ?? prevGit.autoPush ?? true,
    pullOnStartup: gitSync.pullOnStartup ?? prevGit.pullOnStartup ?? true,
  };
  if (gitSync.pushDebounceMs !== undefined) {
    nextGit.pushDebounceMs = gitSync.pushDebounceMs;
  } else if (prevGit.pushDebounceMs !== undefined) {
    nextGit.pushDebounceMs = prevGit.pushDebounceMs;
  }

  writeDaemonConfig(localPath, {
    ...config,
    sync: { ...prevSync, git: nextGit },
  });
}

/**
 * Read just the `sync.git` block out of the resource's daemon config,
 * for diagnostics / health checks. Returns `null` if not configured.
 */
export function readAppliedGitSyncConfig(
  localPath: string,
): Record<string, unknown> | null {
  const config = readDaemonConfig(localPath);
  const sync = config.sync as { git?: Record<string, unknown> } | undefined;
  return sync?.git ?? null;
}
