/**
 * Task Daemon Client
 *
 * Wraps the OpenTasks client to provide typed task operations for the
 * unified map/tasks/* handler. Each call connects to the OpenTasks daemon
 * via Unix socket IPC, performs the operation, and disconnects.
 *
 * OpenHive does NOT write to graph.jsonl directly — the daemon owns persistence.
 */

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import type { MAPTask, MAPTaskStatus } from './task-types.js';

// Dynamic import — opentasks is ESM-only
type OpenTasksClientType = import('opentasks').OpenTasksClient;
type NodeSummary = import('opentasks').NodeSummary;
type QueryResult = import('opentasks').QueryResult;

export class TaskDaemonError extends Error {
  constructor(
    public code: 'DAEMON_NOT_RUNNING' | 'OPERATION_FAILED' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'TaskDaemonError';
  }
}

/**
 * Connect to the OpenTasks daemon at the given socket path, run `fn`, then disconnect.
 */
async function withDaemon<T>(socketPath: string, fn: (client: OpenTasksClientType) => Promise<T>): Promise<T> {
  const { createClient } = await import('opentasks');
  const client = createClient({ socketPath, autoConnect: false, timeout: 10_000 });
  try {
    await client.connect();
  } catch {
    throw new TaskDaemonError(
      'DAEMON_NOT_RUNNING',
      `OpenTasks daemon is not running (socket: ${socketPath})`,
    );
  }
  try {
    return await fn(client);
  } finally {
    client.disconnect();
  }
}

/**
 * Map an OpenTasks NodeSummary to a MAPTask.
 */
function nodeToTask(node: NodeSummary): MAPTask {
  return {
    id: node.id,
    title: node.title,
    status: (node.status as MAPTaskStatus) ?? 'open',
    assignee: null,
    meta: { type: node.type, priority: node.priority, archived: node.archived },
  };
}

// ============================================================================
// Task Operations
// ============================================================================

export async function daemonCreateTask(
  socketPath: string,
  params: { title?: string; description?: string; status?: string; priority?: number; assignee?: string; meta?: Record<string, unknown> },
): Promise<MAPTask> {
  return withDaemon(socketPath, async (client) => {
    const node = await client.createNode({
      type: 'task',
      title: params.title || 'Untitled task',
      content: params.description,
      status: params.status || 'open',
      priority: params.priority,
      assignee: params.assignee,
    });
    const n = node as Record<string, unknown>;
    return {
      id: n.id as string,
      title: (n.title as string) || params.title,
      status: ((n.status as string) || 'open') as MAPTaskStatus,
      description: params.description,
      assignee: (n.assignee as string) || params.assignee || null,
      meta: params.meta,
    };
  });
}

export async function daemonUpdateTask(
  socketPath: string,
  taskId: string,
  updates: { status?: string; title?: string; description?: string; assignee?: string | null; meta?: Record<string, unknown> },
): Promise<MAPTask> {
  return withDaemon(socketPath, async (client) => {
    // If status change, use the task tool's semantic transition when possible
    if (updates.status) {
      const actionMap: Record<string, string> = {
        in_progress: 'start',
        completed: 'complete',
        closed: 'close',
        blocked: 'block',
        open: 'reopen',
        failed: 'close',
      };
      const action = actionMap[updates.status];
      if (action) {
        try {
          const result = await client.task({
            transition: { id: taskId, action: action as 'start' | 'complete' | 'block' | 'reopen' | 'close' },
          });
          if (!result.success) {
            throw new TaskDaemonError('OPERATION_FAILED', result.error || 'Transition failed');
          }
        } catch (err) {
          if (err instanceof TaskDaemonError) throw err;
          // Fall back to direct update if transition fails
          await client.updateNode(taskId, { status: updates.status });
        }
      } else {
        await client.updateNode(taskId, { status: updates.status });
      }
    }

    // Apply non-status updates
    const nodeUpdates: Record<string, unknown> = {};
    if (updates.title !== undefined) nodeUpdates.title = updates.title;
    if (updates.description !== undefined) nodeUpdates.content = updates.description;
    if (updates.assignee !== undefined) nodeUpdates.assignee = updates.assignee;
    if (Object.keys(nodeUpdates).length > 0) {
      await client.updateNode(taskId, nodeUpdates);
    }

    // Return updated task shape
    return {
      id: taskId,
      title: updates.title,
      status: (updates.status as MAPTaskStatus) ?? undefined,
      description: updates.description,
      assignee: updates.assignee ?? null,
      meta: updates.meta,
    };
  });
}

export async function daemonAssignTask(
  socketPath: string,
  taskId: string,
  agentId: string,
): Promise<MAPTask> {
  return withDaemon(socketPath, async (client) => {
    const result = await client.task({
      assign: { id: taskId, assignee: agentId },
    });
    if (!result.success) {
      throw new TaskDaemonError('OPERATION_FAILED', result.error || 'Assignment failed');
    }
    const data = result.data as { node?: NodeSummary } | undefined;
    const node = data?.node;
    return {
      id: taskId,
      title: node?.title,
      status: (node?.status as MAPTaskStatus) ?? 'in_progress',
      assignee: agentId,
    };
  });
}

export async function daemonListTasks(
  socketPath: string,
  filter?: { assignee?: string; status?: string | string[] },
  limit?: number,
): Promise<{ tasks: MAPTask[]; hasMore: boolean }> {
  return withDaemon(socketPath, async (client) => {
    const result: QueryResult = await client.query({
      nodes: {
        type: 'task',
        status: filter?.status,
        assignee: filter?.assignee,
        archived: false,
        limit: limit ?? 100,
      },
    });
    const tasks = (result.items as NodeSummary[]).map(nodeToTask);
    return { tasks, hasMore: result.hasMore };
  });
}

// ============================================================================
// Socket Path Resolution
// ============================================================================

/**
 * Resolve the daemon socket path for an .opentasks directory.
 * Reads config.json for explicit socketPath, falls back to daemon.sock.
 */
export function resolveDaemonSocket(opentasksDir: string): string {
  const configPath = join(opentasksDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.daemon?.socketPath) return config.daemon.socketPath;
    } catch { /* fall through */ }
  }

  return join(opentasksDir, 'daemon.sock');
}
