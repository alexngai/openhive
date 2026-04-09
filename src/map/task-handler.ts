/**
 * MAP Task Request Handler
 *
 * Handles the standard MAP protocol map/tasks/* methods by routing
 * to the OpenTasks daemon. OpenHive acts as a router — it resolves
 * which graph the request targets, connects to the daemon, and
 * returns the result.
 *
 * For local resources: daemon IPC directly.
 * For remote resources (ls-remote/mirror): clone on demand, then daemon IPC.
 * Future: forward to the owning swarm via MAP notifications.
 */

import { existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, normalize, join } from 'node:path';
import { getDefaultTaskGraph } from './connection-registry.js';
import {
  daemonCreateTask,
  daemonUpdateTask,
  daemonAssignTask,
  daemonListTasks,
  resolveDaemonSocket,
  TaskDaemonError,
} from './task-daemon-client.js';
import {
  findSwarmForResource,
  remoteQueryTasks,
  remoteCreateTask,
  remoteUpdateTask,
} from './opentasks-remote.js';
import { getSyncOrchestrator } from '../sync/sync-orchestrator.js';
import * as resourcesDAL from '../db/dal/syncable-resources.js';
import type { SyncableResource } from '../types.js';

/** Resolved graph target — either local (daemon path) or remote (swarm connection) */
type ResolvedTarget = {
  type: 'local';
  localPath: string;
  socketPath: string;
} | {
  type: 'remote';
  swarmId: string;
  resource: SyncableResource;
}

// Re-export for consumers
export { TaskDaemonError };

export interface TaskRequestContext {
  swarmId: string;
  agentId: string;
}

// ============================================================================
// MAP Task Method Constants
// ============================================================================

export const MAP_TASK_METHODS = {
  CREATE: 'map/tasks/create',
  ASSIGN: 'map/tasks/assign',
  UPDATE: 'map/tasks/update',
  LIST: 'map/tasks/list',
} as const;

export const MAP_TASK_METHOD_SET = new Set<string>(Object.values(MAP_TASK_METHODS));

// ============================================================================
// Graph Target Resolution
// ============================================================================

/** Optional targeting fields on every request */
interface TaskGraphTarget {
  resource_id?: string;
  path?: string;
  location_hash?: string;
}

const REMOTE_URL_PREFIXES = ['http', 'git://', 'ssh://', 'remote://', 'map://'];

function canonicalPath(p: string): string {
  const resolved = resolve(normalize(p));
  try {
    if (existsSync(resolved)) return realpathSync(resolved);
  } catch { /* fall through */ }
  return resolved;
}

function resolveLocalPath(resource: SyncableResource): string | null {
  if (resource.local_path) return canonicalPath(resource.local_path);
  const url = resource.git_remote_url;
  for (const prefix of REMOTE_URL_PREFIXES) {
    if (url.startsWith(prefix)) return null;
  }
  return canonicalPath(url);
}

function isValidOpenTasksDir(dirPath: string): boolean {
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return false;
  return existsSync(join(dirPath, 'config.json')) || existsSync(join(dirPath, 'graph.jsonl'));
}

function readOpenTasksMeta(opentasksDir: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { opentasks: true };
  const configPath = join(opentasksDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.location?.hash) meta.location_hash = config.location.hash;
      if (config.location?.name) meta.location_name = config.location.name;
    } catch { /* ignore */ }
  }
  return meta;
}

function autoRegisterResource(opentasksPath: string, agentId: string): SyncableResource {
  const meta = readOpenTasksMeta(opentasksPath);
  const { resource } = resourcesDAL.upsertDiscoveredResource({
    resource_type: 'task',
    name: `auto/${opentasksPath.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').slice(0, 60)}`,
    description: `Auto-registered OpenTasks store at ${opentasksPath}`,
    git_remote_url: opentasksPath,
    visibility: 'private',
    owner_agent_id: agentId,
    scope: 'agent',
    sync_strategy: 'local',
    local_path: opentasksPath,
    metadata: meta,
  });
  return resource;
}

/**
 * Validate a resource is an OpenTasks resource and resolve its local path.
 * Returns the local path string, or null if not locally available.
 */
async function resolveLocalForResource(resource: SyncableResource, agentId: string, label: string): Promise<string | null> {
  if (!resourcesDAL.canAccessResource(agentId, resource)) {
    throw new MAPTaskRequestError(-32003, `Access denied to resource: ${label}`);
  }
  const meta = resource.metadata as Record<string, unknown> | null;
  if (resource.resource_type !== 'task' || !meta?.opentasks) {
    throw new MAPTaskRequestError(-32602, `Resource is not an OpenTasks resource: ${label}`);
  }
  let localPath = resolveLocalPath(resource);
  if (!localPath) {
    const strategy = resource.sync_strategy;
    if (strategy === 'ls-remote' || strategy === 'mirror') {
      const clonePath = await getSyncOrchestrator().ensureContent(resource);
      if (clonePath) localPath = clonePath;
    }
  }
  if (localPath && existsSync(localPath) && statSync(localPath).isDirectory()) {
    return localPath;
  }
  return null;
}

/**
 * Resolve a resource to either a local daemon path or a remote swarm connection.
 */
async function resolveResourceTarget(resource: SyncableResource, agentId: string, label: string): Promise<ResolvedTarget> {
  // Try local first
  const localPath = await resolveLocalForResource(resource, agentId, label);
  if (localPath) {
    return { type: 'local', localPath, socketPath: resolveDaemonSocket(localPath) };
  }

  // Try remote — find connected swarm that owns this graph
  const swarmId = findSwarmForResource(resource);
  if (swarmId) {
    return { type: 'remote', swarmId, resource };
  }

  throw new MAPTaskRequestError(-32002, `Resource is not available locally or via connected swarm: ${label}`);
}

async function resolveGraphTarget(params: TaskGraphTarget, context: TaskRequestContext): Promise<ResolvedTarget> {
  if (params.resource_id) {
    const resource = resourcesDAL.findResourceById(params.resource_id);
    if (!resource) throw new MAPTaskRequestError(-32001, `Resource not found: ${params.resource_id}`);
    return await resolveResourceTarget(resource, context.agentId, params.resource_id);
  }

  if (params.path) {
    const normalizedPath = canonicalPath(params.path);
    let opentasksPath = normalizedPath;
    if (!isValidOpenTasksDir(normalizedPath)) {
      const nested = join(normalizedPath, '.opentasks');
      if (isValidOpenTasksDir(nested)) {
        opentasksPath = canonicalPath(nested);
      } else {
        throw new MAPTaskRequestError(-32001, `No valid .opentasks directory at path: ${params.path}`);
      }
    }
    const existing = resourcesDAL.findResourceByLocalPath(opentasksPath, context.agentId, 'task');
    if (existing) return await resolveResourceTarget(existing, context.agentId, params.path);
    const resource = autoRegisterResource(opentasksPath, context.agentId);
    return await resolveResourceTarget(resource, context.agentId, params.path);
  }

  if (params.location_hash) {
    const resource = resourcesDAL.findResourceByLocationHash(params.location_hash, context.agentId, 'task');
    if (!resource) throw new MAPTaskRequestError(-32001, `Resource not found with location_hash: ${params.location_hash}`);
    return await resolveResourceTarget(resource, context.agentId, params.location_hash);
  }

  const defaultGraph = getDefaultTaskGraph(context.swarmId);
  if (defaultGraph && (defaultGraph.resource_id || defaultGraph.path || defaultGraph.location_hash)) {
    return await resolveGraphTarget(defaultGraph, context);
  }

  throw new MAPTaskRequestError(
    -32002,
    'No task graph configured. Provide resource_id, path, or location_hash, or set a default via metadata.task_graph on registration.',
  );
}

// ============================================================================
// Handler
// ============================================================================

export async function handleTaskRequest(
  method: string,
  params: unknown,
  context: TaskRequestContext,
): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;

  switch (method) {
    case MAP_TASK_METHODS.CREATE: {
      const task = p.task as Record<string, unknown> | undefined;
      if (!task || typeof task !== 'object') {
        throw new MAPTaskRequestError(-32602, 'Invalid params: missing task object');
      }
      const target = await resolveGraphTarget(p as TaskGraphTarget, context);
      const taskParams = {
        title: task.title as string,
        description: task.description as string,
        status: task.status as string,
        priority: task.priority as number,
        assignee: (task.assignee as string) ?? undefined,
        meta: task.meta as Record<string, unknown>,
      };

      let result;
      if (target.type === 'local') {
        result = await daemonCreateTask(target.socketPath, taskParams, target.localPath);
      } else {
        const remote = await remoteCreateTask(target.swarmId, taskParams);
        if (!remote) throw new MAPTaskRequestError(-32003, 'Remote swarm did not respond');
        result = remote;
      }

      try {
        const { broadcastToChannel } = await import('../realtime/index.js');
        broadcastToChannel('map:tasks', { type: 'task.created', data: { task: result } });
      } catch { /* best effort */ }

      return { task: result };
    }

    case MAP_TASK_METHODS.ASSIGN: {
      if (!p.taskId || !p.agentId) {
        throw new MAPTaskRequestError(-32602, 'Invalid params: missing taskId or agentId');
      }
      const target = await resolveGraphTarget(p as TaskGraphTarget, context);

      let result;
      if (target.type === 'local') {
        result = await daemonAssignTask(target.socketPath, p.taskId as string, p.agentId as string, target.localPath);
      } else {
        // Remote assign not yet supported via connector — would need opentasks/task.request
        throw new MAPTaskRequestError(-32002, 'Task assignment on remote graphs is not yet supported');
      }

      try {
        const { broadcastToChannel } = await import('../realtime/index.js');
        broadcastToChannel('map:tasks', { type: 'task.assigned', data: { taskId: result.id, agentId: p.agentId } });
      } catch { /* best effort */ }

      return { task: result };
    }

    case MAP_TASK_METHODS.UPDATE: {
      if (!p.taskId) {
        throw new MAPTaskRequestError(-32602, 'Invalid params: missing taskId');
      }
      const target = await resolveGraphTarget(p as TaskGraphTarget, context);

      let result;
      if (target.type === 'local') {
        result = await daemonUpdateTask(target.socketPath, p.taskId as string, {
          status: p.status as string,
          title: p.title as string,
          description: p.description as string,
          assignee: p.assignee as string,
          meta: p.meta as Record<string, unknown>,
        }, target.localPath);
      } else {
        if (p.status) {
          const remote = await remoteUpdateTask(target.swarmId, p.taskId as string, p.status as string);
          if (!remote) throw new MAPTaskRequestError(-32003, 'Remote swarm did not respond');
          result = remote;
        } else {
          throw new MAPTaskRequestError(-32002, 'Non-status updates on remote graphs are not yet supported');
        }
      }

      if (p.status) {
        try {
          const { broadcastToChannel } = await import('../realtime/index.js');
          broadcastToChannel('map:tasks', { type: 'task.status', data: { taskId: p.taskId, current: p.status } });
        } catch { /* best effort */ }
      }

      return { task: result };
    }

    case MAP_TASK_METHODS.LIST: {
      const target = await resolveGraphTarget(p as TaskGraphTarget, context);

      const filter = p.filter as Record<string, unknown> | undefined;
      const statusFilter = filter?.status
        ? (Array.isArray(filter.status) ? filter.status : [filter.status])
        : undefined;

      if (target.type === 'local') {
        const result = await daemonListTasks(
          target.socketPath,
          { assignee: filter?.assignee as string, status: statusFilter },
          p.limit as number,
          target.localPath,
        );
        return { tasks: result.tasks, hasMore: result.hasMore };
      } else {
        const result = await remoteQueryTasks(target.swarmId, {
          status: statusFilter,
          assignee: filter?.assignee as string,
        }, p.limit as number);
        if (!result) throw new MAPTaskRequestError(-32003, 'Remote swarm did not respond');
        return { tasks: result.items, hasMore: result.hasMore };
      }
    }

    default:
      throw new MAPTaskRequestError(-32601, `Unknown task method: ${method}`);
  }
}

// ============================================================================
// Errors
// ============================================================================

export class MAPTaskRequestError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = 'MAPTaskRequestError';
  }
}
