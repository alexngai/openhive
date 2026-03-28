/**
 * MAP Task Request Handler (Unified)
 *
 * Routes map/tasks/* JSON-RPC requests to the OpenTasks daemon.
 * OpenHive's role is to:
 *   1. Authenticate the agent
 *   2. Resolve the target graph (per-request or connection default)
 *   3. Forward the request to OpenTasks via daemon IPC
 *   4. Emit WebSocket events for real-time updates
 *
 * OpenHive does NOT write to graph.jsonl directly — the daemon owns persistence.
 */

import { existsSync, statSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, normalize, join } from 'node:path';
import { MAP_TASK_METHODS } from './task-types.js';
import type {
  TasksCreateParams,
  TasksAssignParams,
  TasksUpdateParams,
  TasksListParams,
  TasksCreateResult,
  TasksAssignResult,
  TasksUpdateResult,
  TasksListResult,
  TaskGraphTarget,
} from './task-types.js';
import type { MAPTaskStore } from './task-store.js';
import { getDefaultTaskGraph } from './connection-registry.js';
import {
  daemonCreateTask,
  daemonUpdateTask,
  daemonAssignTask,
  daemonListTasks,
  resolveDaemonSocket,
} from './task-daemon-client.js';
import * as resourcesDAL from '../db/dal/syncable-resources.js';
import type { SyncableResource } from '../types.js';

export interface TaskRequestContext {
  swarmId: string;
  agentId: string;
}

// ============================================================================
// Resource Resolution (lifted from opentasks-handler.ts)
// ============================================================================

const REMOTE_URL_PREFIXES = ['http', 'git://', 'ssh://'];

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

function validateOpenTasksResource(resource: SyncableResource, agentId: string, label: string): string {
  if (!resourcesDAL.canAccessResource(agentId, resource)) {
    throw new MAPTaskRequestError(-32003, `Access denied to resource: ${label}`);
  }
  const meta = resource.metadata as Record<string, unknown> | null;
  if (resource.resource_type !== 'task' || !meta?.opentasks) {
    throw new MAPTaskRequestError(-32602, `Resource is not an OpenTasks resource: ${label}`);
  }
  const localPath = resolveLocalPath(resource);
  if (!localPath) {
    throw new MAPTaskRequestError(-32002, `Resource is not local to this instance: ${label}`);
  }
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new MAPTaskRequestError(-32001, `Resource path does not exist: ${label}`);
  }
  return localPath;
}

/**
 * Resolve the target OpenTasks graph from per-request params or connection default.
 * Returns the local .opentasks directory path.
 */
function resolveGraphTarget(
  params: TaskGraphTarget,
  context: TaskRequestContext,
): string {
  // 1. Per-request resource targeting
  if (params.resource_id) {
    const resource = resourcesDAL.findResourceById(params.resource_id);
    if (!resource) throw new MAPTaskRequestError(-32001, `Resource not found: ${params.resource_id}`);
    return validateOpenTasksResource(resource, context.agentId, params.resource_id);
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
    if (existing) return validateOpenTasksResource(existing, context.agentId, params.path);
    const resource = autoRegisterResource(opentasksPath, context.agentId);
    return validateOpenTasksResource(resource, context.agentId, params.path);
  }

  if (params.location_hash) {
    const resource = resourcesDAL.findResourceByLocationHash(params.location_hash, context.agentId, 'task');
    if (!resource) throw new MAPTaskRequestError(-32001, `Resource not found with location_hash: ${params.location_hash}`);
    return validateOpenTasksResource(resource, context.agentId, params.location_hash);
  }

  // 2. Connection default (guard against empty/invalid defaults)
  const defaultGraph = getDefaultTaskGraph(context.swarmId);
  if (defaultGraph && (defaultGraph.resource_id || defaultGraph.path || defaultGraph.location_hash)) {
    return resolveGraphTarget(defaultGraph, context);
  }

  // 3. No target available
  throw new MAPTaskRequestError(
    -32002,
    'No task graph configured. Provide resource_id, path, or location_hash, or set a default via metadata.task_graph on registration.',
  );
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle a map/tasks/* JSON-RPC request.
 * Routes to the OpenTasks daemon for persistence.
 */
export async function handleTaskRequest(
  method: string,
  params: unknown,
  context: TaskRequestContext,
  store: MAPTaskStore,
): Promise<TasksCreateResult | TasksAssignResult | TasksUpdateResult | TasksListResult> {
  switch (method) {
    case MAP_TASK_METHODS.CREATE: {
      const p = params as TasksCreateParams;
      if (!p?.task || typeof p.task !== 'object') {
        throw new MAPTaskRequestError(-32602, 'Invalid params: missing task object');
      }

      const localPath = resolveGraphTarget(p, context);
      const socketPath = resolveDaemonSocket(localPath);
      const task = await daemonCreateTask(socketPath, {
        title: p.task.title,
        description: p.task.description,
        status: p.task.status,
        assignee: p.task.assignee ?? undefined,
        meta: p.task.meta,
      });

      store.emit({ type: 'task.created', data: { task } }, context.swarmId);
      return { task };
    }

    case MAP_TASK_METHODS.ASSIGN: {
      const p = params as TasksAssignParams;
      if (!p?.taskId || !p?.agentId) {
        throw new MAPTaskRequestError(-32602, 'Invalid params: missing taskId or agentId');
      }

      const localPath = resolveGraphTarget(p, context);
      const socketPath = resolveDaemonSocket(localPath);
      const task = await daemonAssignTask(socketPath, p.taskId, p.agentId);

      store.emit({ type: 'task.assigned', data: { taskId: task.id, agentId: p.agentId } }, context.swarmId);
      return { task };
    }

    case MAP_TASK_METHODS.UPDATE: {
      const p = params as TasksUpdateParams;
      if (!p?.taskId) {
        throw new MAPTaskRequestError(-32602, 'Invalid params: missing taskId');
      }

      const localPath = resolveGraphTarget(p, context);
      const socketPath = resolveDaemonSocket(localPath);
      const task = await daemonUpdateTask(socketPath, p.taskId, {
        status: p.status,
        title: p.title,
        description: p.description,
        assignee: p.assignee,
        meta: p.meta,
      });

      if (p.status) {
        store.emit(
          { type: 'task.status', data: { taskId: task.id, previous: null, current: p.status } },
          context.swarmId,
        );
        if (p.status === 'completed' || p.status === 'failed') {
          store.emit({ type: 'task.completed', data: { taskId: task.id } }, context.swarmId);
        }
      }
      return { task };
    }

    case MAP_TASK_METHODS.LIST: {
      const p = (params ?? {}) as TasksListParams;

      const localPath = resolveGraphTarget(p, context);
      const socketPath = resolveDaemonSocket(localPath);

      const statusFilter = p.filter?.status
        ? (Array.isArray(p.filter.status) ? p.filter.status : [p.filter.status])
        : undefined;

      const result = await daemonListTasks(
        socketPath,
        { assignee: p.filter?.assignee, status: statusFilter },
        p.limit,
      );

      return {
        tasks: result.tasks,
        hasMore: result.hasMore,
        nextCursor: undefined,
      };
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

  toJsonRpcError(): { code: number; message: string } {
    return { code: this.code, message: this.message };
  }
}
