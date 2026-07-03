/**
 * Hub-default OpenTasks graph bootstrap.
 *
 * A fresh openhive instance has no task-graph resources, which makes
 * /specs/new a dead end. This module creates a hub-owned OpenTasks store
 * under the data dir and registers it as a `task` resource named
 * `hub/default`, so spec authoring works out of the box.
 *
 * Design notes (north-star-flows-wave1-plan.md P2.4):
 * - `visibility: 'public'` on purpose — private resources owned by the
 *   admin agent would be invisible to every other agent's
 *   `listAccessibleResources` (the owner/subscription access-control trap).
 * - The daemon is NOT eagerly spawned; `withDaemon` auto-starts it on the
 *   first spec write.
 * - Idempotent: `ensureInitialized` skips existing files, and
 *   `upsertDiscoveredResource` dedupes on (owner, type, name).
 */

import * as path from 'node:path';
import { ensureInitialized } from './task-daemon-lifecycle.js';
import * as resourcesDAL from '../db/dal/syncable-resources.js';
import { findDefaultOwnerAgent } from '../db/dal/agents.js';
import type { SyncableResource } from '../types.js';
import { existsSync, readFileSync } from 'node:fs';

export const HUB_DEFAULT_GRAPH_NAME = 'hub/default';

/**
 * Ensure the hub-default task graph exists on disk and is registered as a
 * resource. Returns the resource, or null when there is no agent yet to
 * own it (pre-init instance — caller may retry later, e.g. via the
 * POST /map/hub-task-graph route).
 *
 * @param dataDir absolute or cwd-relative openhive data dir
 */
export function ensureHubDefaultTaskGraph(dataDir: string): SyncableResource | null {
  const owner = findDefaultOwnerAgent();
  if (!owner) {
    console.warn('[hub-task-graph] No agents exist yet — skipping hub/default bootstrap');
    return null;
  }

  // Keep the layout shallow: deep paths risk hitting the Unix-socket
  // length cap on macOS when the daemon binds `<dir>/daemon.sock`.
  const dir = path.join(dataDir, 'task-graph', '.opentasks');
  ensureInitialized(dir);

  // location_hash anchors the resource to the on-disk store identity; the
  // daemon client uses it to route writes.
  const metadata: Record<string, unknown> = { opentasks: true, hub_default: true };
  const configPath = path.join(dir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
        location?: { hash?: string; name?: string };
      };
      if (config.location?.hash) metadata.location_hash = config.location.hash;
      if (config.location?.name) metadata.location_name = config.location.name;
    } catch { /* unreadable config — resource still works, daemon re-reads on demand */ }
  }

  const { resource, created } = resourcesDAL.upsertDiscoveredResource({
    resource_type: 'task',
    name: HUB_DEFAULT_GRAPH_NAME,
    description: 'Hub-default OpenTasks graph (created automatically so specs work on a fresh instance)',
    git_remote_url: dir,
    local_path: dir,
    sync_strategy: 'local',
    owner_agent_id: owner.id,
    scope: 'global',
    visibility: 'public',
    metadata,
  });

  if (created) {
    console.log(`[hub-task-graph] Created hub-default task graph at ${dir} (resource ${resource.id})`);
  }
  return resource;
}
