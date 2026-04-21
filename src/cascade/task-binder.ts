/**
 * Cascade → task orchestrator.
 *
 * Subscribes to `mapHubEvents.cascade_stream_merged` and resolves a close
 * policy (per-task > per-swarm > per-hub) to decide whether the hub should
 * transition the linked task. Default at every scope is `manual` — the
 * binder is a no-op unless something opted in.
 *
 * The binder is a named, switchable orchestration layer (like the dispatch
 * orchestrator). It does not hardcode workflow opinions; agents that want
 * full autonomy simply don't opt in and the binder never touches their
 * tasks, while agents that opted in via `cascade.autoCloseOnMerge` or
 * per-task `close_policy: 'on_merge'` get automation for free.
 *
 * Hub invariants preserved:
 *   - Cascade projection is the data authority on merge state.
 *   - Opentasks daemons remain the data authority on task state.
 *   - Binder never writes to either — it delegates to the opentasks daemon
 *     (local IPC or remote MAP) and lets the normal broadcast path fire.
 */

import { existsSync, statSync } from 'node:fs';
import { mapHubEvents } from '../map/service.js';
import { resolveClosePolicy, type ClosePolicy } from './policy.js';
import { getAggregateCapabilities } from '../map/connection-registry.js';
import { findResourceById } from '../db/dal/syncable-resources.js';
import {
  daemonUpdateTask,
  resolveDaemonSocket,
} from '../map/task-daemon-client.js';
import {
  findSwarmForResource,
  remoteUpdateTask,
} from '../map/opentasks-remote.js';
import { broadcastTaskStatus } from '../map/task-broadcast.js';
import type { SyncableResource } from '../types.js';

/** Payload shape emitted by `cascade-handler.handleStreamMerged`. */
interface CascadeStreamMergedEvent {
  source_swarm_id: string;
  merge_row_id?: string;
  source_stream_row_id?: string | null;
  target_stream_row_id?: string;
  source_stream_id?: string;
  target_stream_id?: string;
  merge_commit?: string;
  strategy?: string | null;
  agent_id?: string | null;
  task_ref?: { resource_id: string; node_id: string };
  created?: boolean;
}

export interface TaskBinderDeps {
  /** Hub-wide default policy. Read once at start; changes require restart. */
  defaultClosePolicy: ClosePolicy;
}

let activeHandler: ((event: CascadeStreamMergedEvent) => void) | null = null;
let activeDeps: TaskBinderDeps | null = null;

/**
 * Begin listening for cascade merge events. Idempotent — calling twice is
 * safe; the second call replaces the first.
 */
export function startTaskBinder(deps: TaskBinderDeps): void {
  stopTaskBinder();
  activeDeps = deps;
  const handler = (eventData: unknown) => {
    void handleCascadeStreamMerged(eventData as CascadeStreamMergedEvent, deps);
  };
  activeHandler = handler;
  mapHubEvents.on('cascade_stream_merged', handler);
}

/** Stop listening. Safe to call when not started. */
export function stopTaskBinder(): void {
  if (activeHandler) {
    mapHubEvents.off('cascade_stream_merged', activeHandler);
    activeHandler = null;
  }
  activeDeps = null;
}

/** Exported for tests — triggers the binder path synchronously. */
export async function handleCascadeStreamMerged(
  event: CascadeStreamMergedEvent,
  deps: TaskBinderDeps = activeDeps ?? { defaultClosePolicy: 'manual' },
): Promise<void> {
  const taskRef = event.task_ref;
  if (!taskRef || !taskRef.resource_id || !taskRef.node_id) return;

  let resource: SyncableResource | null;
  try {
    resource = findResourceById(taskRef.resource_id);
  } catch {
    return;
  }
  if (!resource) return;

  const swarmCapabilities =
    getAggregateCapabilities(event.source_swarm_id) ?? null;

  const policy = resolveClosePolicy({
    taskMetadata: resource.metadata,
    swarmCapabilities,
    hubConfig: { defaultClosePolicy: deps.defaultClosePolicy },
  });

  if (policy !== 'on_merge') return;

  await transitionTaskToCompleted(resource, taskRef.node_id);
}

async function transitionTaskToCompleted(
  resource: SyncableResource,
  nodeId: string,
): Promise<void> {
  const localPath = resolveLocalPathForResource(resource);
  if (localPath) {
    const socketPath = resolveDaemonSocket(localPath);
    try {
      await daemonUpdateTask(socketPath, nodeId, { status: 'completed' }, localPath);
      broadcastTaskStatus({
        taskId: nodeId,
        status: 'completed',
        resourceId: resource.id,
      });
      return;
    } catch {
      // Fall through to remote path — daemon may be offline.
    }
  }

  const swarmId = findSwarmForResource(resource);
  if (!swarmId) return;

  try {
    const updated = await remoteUpdateTask(swarmId, nodeId, 'completed');
    if (!updated) return;
    broadcastTaskStatus({
      taskId: nodeId,
      status: 'completed',
      resourceId: resource.id,
    });
  } catch {
    // Best-effort automation — no retry queue.
  }
}

/**
 * Mirror of `task-handler.resolveLocalPath`, narrowed to what the binder
 * needs. Kept inline to avoid importing task-handler (circular — task-handler
 * imports from task-broadcast which imports from cascade DAL which is fine,
 * but task-binder is a dependent consumer, not a peer).
 */
function resolveLocalPathForResource(resource: SyncableResource): string | null {
  const url = resource.local_path ?? resource.git_remote_url;
  if (!url) return null;
  const remotePrefixes = ['http', 'git://', 'ssh://', 'remote://', 'map://', 'local://'];
  for (const prefix of remotePrefixes) {
    if (url.startsWith(prefix) && !resource.local_path) return null;
  }
  const path = resource.local_path ?? url;
  if (!existsSync(path) || !statSync(path).isDirectory()) return null;
  return path;
}
