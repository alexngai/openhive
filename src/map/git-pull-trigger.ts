/**
 * Git Pull Trigger
 *
 * When a peer hub signals a `context.*` MAP event for a resource whose
 * daemon has git sync enabled (and `pullOnSignal` isn't opted out), this
 * module fires a `sync.pull` IPC call against the local daemon to converge
 * on the pushed state immediately — no waiting for periodic pulls.
 *
 * Shape of the flow:
 *
 *   Hub A: REST POST /specs
 *     → daemon auto-commit + auto-push to shared remote
 *   Hub B: receives `context.*` over MAP (bridge in cc-swarm sidecar)
 *     → handleMapContextEvent looks up resource + its `metadata.git_sync`
 *     → triggerPullForResource(resourceId)
 *     → debounced `sync.pull` to the resource's daemon
 *     → daemon pulls → its watcher fires → bridge re-emits locally
 *     → hub broadcast goes out on map:tasks
 *     → Hub B's observers see the spec
 *
 * Debouncing: we coalesce rapid triggers per-resource (2s window) — if a
 * peer pushes ten updates in five seconds, we only pull once.
 *
 * Fire-and-forget: all git operations are best-effort. A pull failure
 * (network, merge conflict, auth) is logged to the hub's error stream but
 * must not affect the caller's request or crash the listener.
 */

import * as resourcesDAL from '../db/dal/syncable-resources.js';
import { resolveDaemonSocket } from './task-daemon-client.js';
import type { GitSyncMetadata } from '../swarmkit/git-sync-config.js';
import type { SyncableResource } from '../types.js';

/**
 * Extract the `git_sync` block from a resource's metadata, typed.
 * Returns `undefined` when the resource was never toggled.
 */
function readGitSyncFromResource(
  resource: SyncableResource,
): GitSyncMetadata | undefined {
  const metadata = resource.metadata as Record<string, unknown> | null;
  const gitSync = metadata?.git_sync as GitSyncMetadata | undefined;
  return gitSync;
}

// ============================================================================
// Debounce cache
// ============================================================================

const PULL_DEBOUNCE_MS = 2000;

/** Pending timer per resource — collapses rapid triggers into one pull. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** When a pull is already in flight for a resource, we record that so the
 *  follow-on timer doesn't start a second one concurrently. */
const inFlight = new Set<string>();

// ============================================================================
// IPC helper
// ============================================================================

/**
 * Send a single IPC request to an opentasks daemon via its Unix socket.
 * Uses the package's `createIPCClient` rather than JSON-RPC hand-rolled
 * (the daemon handlers use the package's IPC framing, so this stays
 * compatible with any future protocol changes).
 *
 * Returns silently on any error. Callers treat this as best-effort.
 */
async function sendDaemonRequest<T>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T | null> {
  try {
    const { createIPCClient } = await import('opentasks');
    const client = createIPCClient(socketPath);
    try {
      await client.connect();
    } catch {
      return null; // daemon not running
    }
    try {
      return await client.request<T>(method, params);
    } catch {
      return null; // daemon returned an error — best-effort
    } finally {
      try { client.disconnect(); } catch { /* ignore */ }
    }
  } catch {
    /* opentasks import failed — degrade silently */
    return null;
  }
}

async function sendPull(socketPath: string): Promise<void> {
  await sendDaemonRequest(socketPath, 'sync.pull');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Trigger a debounced git pull for the resource. Resolves immediately —
 * the pull runs on the debounce timer. Safe to call from hot paths like
 * the MAP event listener.
 *
 * Returns `true` if a pull was scheduled (or one is already scheduled),
 * `false` if the resource has no git sync enabled or isn't eligible
 * (missing local_path, pullOnSignal=false, etc.).
 */
export function triggerPullForResource(resourceId: string): boolean {
  const resource = resourcesDAL.findResourceById(resourceId);
  if (!resource) return false;

  const gitSync = readGitSyncFromResource(resource);
  if (!gitSync?.enabled) return false;
  if (gitSync.pullOnSignal === false) return false;
  if (!resource.local_path) return false;

  const socketPath = resolveDaemonSocket(resource.local_path);

  // Already a pending timer — don't stack. The existing timer will fire
  // within PULL_DEBOUNCE_MS with the latest state.
  if (pending.has(resourceId)) return true;

  const timer = setTimeout(() => {
    pending.delete(resourceId);
    if (inFlight.has(resourceId)) {
      // Coalesce: one more pull right after the in-flight one finishes
      // is redundant since the next pull would see the same remote state.
      return;
    }
    inFlight.add(resourceId);
    void sendPull(socketPath).finally(() => {
      inFlight.delete(resourceId);
    });
  }, PULL_DEBOUNCE_MS);

  // Don't keep the event loop alive purely for pending pulls during shutdown.
  timer.unref?.();

  pending.set(resourceId, timer);
  return true;
}

/**
 * Tell a resource's running daemon to re-read its `.opentasks/config.json`
 * and hot-swap its git syncer. Called by the PATCH /resources/:id/git-sync
 * endpoint after writing the config so the flag flip takes effect without
 * requiring a daemon restart.
 *
 * Returns the daemon's new sync status on success, or `null` if the
 * daemon isn't reachable / doesn't support sync.reload (e.g. older
 * opentasks without this method).
 */
export async function reloadSyncerForResource(
  resourceId: string,
): Promise<{ enabled: boolean; remote?: string } | null> {
  const resource = resourcesDAL.findResourceById(resourceId);
  if (!resource?.local_path) return null;

  const socketPath = resolveDaemonSocket(resource.local_path);
  type ReloadResult = {
    reloaded: boolean;
    status: { enabled: boolean; remote?: string };
    error?: string;
  };
  const result = await sendDaemonRequest<ReloadResult>(socketPath, 'sync.reload');
  if (!result?.reloaded) return null;
  return result.status;
}

/** Testing helper — cancel any pending timers and clear in-flight state. */
export function _resetGitPullTriggerForTests(): void {
  for (const t of pending.values()) clearTimeout(t);
  pending.clear();
  inFlight.clear();
}
