/**
 * Task Daemon Client
 *
 * Unified OpenTasks daemon client for both reads and writes.
 * Each call connects to the daemon via Unix socket IPC, performs
 * the operation, and disconnects. Auto-starts the daemon if needed.
 *
 * OpenHive does NOT write to graph.jsonl directly — the daemon owns persistence.
 */

import { join } from 'node:path';
import { readFileSync, existsSync, statSync } from 'node:fs';
/** Task status values used throughout the daemon client. */
export type MAPTaskStatus = 'open' | 'in_progress' | 'blocked' | 'completed' | 'failed';

/** Lightweight task representation returned by daemon client functions. */
export interface MAPTask {
  id: string;
  title?: string;
  status?: MAPTaskStatus;
  description?: string;
  assignee?: string | null;
  meta?: Record<string, unknown>;
}
import { ensureDaemon } from './task-daemon-lifecycle.js';

// Dynamic import — opentasks is ESM-only
type OpenTasksClientType = import('opentasks').OpenTasksClient;
type NodeSummary = import('opentasks').NodeSummary;
type EdgeSummary = import('opentasks').EdgeSummary;
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
 * Connect to the OpenTasks daemon, run `fn`, then disconnect.
 * Auto-starts the daemon if not running (for local resources).
 */
async function withDaemon<T>(socketPath: string, fn: (client: OpenTasksClientType) => Promise<T>, opentasksDir?: string): Promise<T> {
  const { createClient } = await import('opentasks');
  const client = createClient({ socketPath, autoConnect: false, timeout: 10_000 });

  try {
    await client.connect();
  } catch {
    // Auto-start: try to start daemon, then retry
    if (opentasksDir) {
      const started = await ensureDaemon(opentasksDir);
      if (started) {
        try {
          await client.connect();
        } catch {
          throw new TaskDaemonError('DAEMON_NOT_RUNNING', `OpenTasks daemon failed to start (socket: ${socketPath})`);
        }
      } else {
        throw new TaskDaemonError('DAEMON_NOT_RUNNING', `OpenTasks daemon is not running and auto-start failed (socket: ${socketPath})`);
      }
    } else {
      throw new TaskDaemonError('DAEMON_NOT_RUNNING', `OpenTasks daemon is not running (socket: ${socketPath})`);
    }
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
// Write Operations
// ============================================================================

export async function daemonCreateTask(
  socketPath: string,
  params: { title?: string; description?: string; status?: string; priority?: number; assignee?: string; meta?: Record<string, unknown> },
  opentasksDir?: string,
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
  }, opentasksDir);
}

export async function daemonUpdateTask(
  socketPath: string,
  taskId: string,
  updates: { status?: string; title?: string; description?: string; assignee?: string | null; meta?: Record<string, unknown> },
  opentasksDir?: string,
): Promise<MAPTask> {
  return withDaemon(socketPath, async (client) => {
    if (updates.status) {
      const actionMap: Record<string, string> = {
        in_progress: 'start', completed: 'complete', closed: 'close',
        blocked: 'block', open: 'reopen', failed: 'close',
      };
      const action = actionMap[updates.status];
      if (action) {
        try {
          const result = await client.task({
            transition: { id: taskId, action: action as 'start' | 'complete' | 'block' | 'reopen' | 'close' },
          });
          if (!result.success) {
            // Semantic transition not valid for current state — fall back to direct update
            await client.updateNode(taskId, { status: updates.status });
          }
        } catch {
          // Transition threw — fall back to direct update
          await client.updateNode(taskId, { status: updates.status });
        }
      } else {
        await client.updateNode(taskId, { status: updates.status });
      }
    }

    const nodeUpdates: Record<string, unknown> = {};
    if (updates.title !== undefined) nodeUpdates.title = updates.title;
    if (updates.description !== undefined) nodeUpdates.content = updates.description;
    if (updates.assignee !== undefined) nodeUpdates.assignee = updates.assignee;
    if (Object.keys(nodeUpdates).length > 0) {
      await client.updateNode(taskId, nodeUpdates);
    }

    return {
      id: taskId,
      title: updates.title,
      status: (updates.status as MAPTaskStatus) ?? undefined,
      description: updates.description,
      assignee: updates.assignee ?? null,
      meta: updates.meta,
    };
  }, opentasksDir);
}

export async function daemonDeleteTask(
  socketPath: string,
  taskId: string,
  options?: { hard?: boolean },
  opentasksDir?: string,
): Promise<void> {
  return withDaemon(socketPath, async (client) => {
    await client.deleteNode(taskId, { hard: options?.hard ?? false });
  }, opentasksDir);
}

export async function daemonCreateLink(
  socketPath: string,
  params: { fromId: string; toId: string; type: string; metadata?: Record<string, unknown> },
  opentasksDir?: string,
): Promise<{ edgeId?: string }> {
  return withDaemon(socketPath, async (client) => {
    const result = await client.link({
      fromId: params.fromId,
      toId: params.toId,
      type: params.type as any,
      metadata: params.metadata,
    });
    if (!result.success) {
      throw new TaskDaemonError('OPERATION_FAILED', result.error || 'Link creation failed');
    }
    return { edgeId: result.edgeId };
  }, opentasksDir);
}

export async function daemonRemoveLink(
  socketPath: string,
  params: { fromId: string; toId: string; type: string },
  opentasksDir?: string,
): Promise<void> {
  return withDaemon(socketPath, async (client) => {
    const result = await client.link({
      fromId: params.fromId,
      toId: params.toId,
      type: params.type as any,
      remove: true,
    });
    if (!result.success) {
      throw new TaskDaemonError('OPERATION_FAILED', result.error || 'Link removal failed');
    }
  }, opentasksDir);
}

export async function daemonAssignTask(
  socketPath: string,
  taskId: string,
  agentId: string,
  opentasksDir?: string,
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
  }, opentasksDir);
}

// ============================================================================
// Read Operations
// ============================================================================

export async function daemonListTasks(
  socketPath: string,
  filter?: { assignee?: string; status?: string | string[] },
  limit?: number,
  opentasksDir?: string,
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
  }, opentasksDir);
}

/**
 * Get full graph data (nodes + edges) from daemon.
 * Used by the frontend graph and kanban views.
 */
export async function daemonGetGraph(
  socketPath: string,
  opentasksDir?: string,
): Promise<{ nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] }> {
  return withDaemon(socketPath, async (client) => {
    const nodesResult = await client.query({ nodes: { archived: false }, limit: 5000, verbose: true });
    const edgesResult = await client.query({ edges: {}, limit: 10000 });

    const nodes = (nodesResult.items as unknown as Record<string, unknown>[]).map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      description: n.content ?? n.description,
      status: n.status,
      priority: n.priority,
      archived: n.archived,
      assignee: n.assignee,
      created_at: n.created_at ?? n.createdAt,
      updated_at: n.updated_at ?? n.updatedAt,
    }));

    const edges = (edgesResult.items as EdgeSummary[]).map((e) => ({
      id: e.id,
      from_id: e.fromId,
      to_id: e.toId,
      type: e.type,
    }));

    return { nodes, edges };
  }, opentasksDir);
}

/**
 * Get graph summary (node/edge counts, status breakdown).
 */
export async function daemonGetSummary(
  socketPath: string,
  opentasksDir?: string,
): Promise<{
  node_count: number;
  edge_count: number;
  task_counts: Record<string, number>;
  context_count: number;
  feedback_count: number;
  ready_count: number;
  daemon_connected: boolean;
}> {
  return withDaemon(socketPath, async (client) => {
    const nodesResult = await client.query({ nodes: { archived: false }, limit: 5000 });
    const edgesResult = await client.query({ edges: {}, limit: 1 });
    const readyResult = await client.ready({ limit: 1000 });

    const items = nodesResult.items as NodeSummary[];
    const taskCounts: Record<string, number> = {};
    let contextCount = 0;
    let feedbackCount = 0;

    for (const node of items) {
      if (node.type === 'task') {
        const s = node.status || 'open';
        taskCounts[s] = (taskCounts[s] ?? 0) + 1;
      } else if (node.type === 'context') {
        contextCount++;
      } else if (node.type === 'feedback') {
        feedbackCount++;
      }
    }

    return {
      node_count: items.length,
      edge_count: edgesResult.total ?? 0,
      task_counts: taskCounts,
      context_count: contextCount,
      feedback_count: feedbackCount,
      ready_count: readyResult.length,
      daemon_connected: true,
    };
  }, opentasksDir);
}

/**
 * Get ready (unblocked) tasks from daemon.
 */
export async function daemonGetReady(
  socketPath: string,
  limit?: number,
  opentasksDir?: string,
): Promise<{ items: NodeSummary[]; total: number; daemon_connected: boolean }> {
  return withDaemon(socketPath, async (client) => {
    const items = await client.ready({ limit: limit ?? 50 });
    return { items, total: items.length, daemon_connected: true };
  }, opentasksDir);
}

/**
 * Query nodes with arbitrary filters.
 */
export async function daemonQueryNodes(
  socketPath: string,
  filter: Record<string, unknown>,
  opentasksDir?: string,
): Promise<{ items: NodeSummary[]; total?: number; daemon_connected: boolean }> {
  return withDaemon(socketPath, async (client) => {
    const result = await client.query({ nodes: filter as any });
    return { items: result.items as NodeSummary[], total: result.total, daemon_connected: true };
  }, opentasksDir);
}

/**
 * Check if daemon is alive + return graph file status.
 */
export async function daemonGetStatus(
  socketPath: string,
  opentasksDir: string,
): Promise<{ daemon_running: boolean; graph_file_exists: boolean; graph_last_modified: string | null; socket_path: string }> {
  const { isDaemonAlive } = await import('./task-daemon-lifecycle.js');
  const graphPath = join(opentasksDir, 'graph.jsonl');
  const graphExists = existsSync(graphPath);

  return {
    daemon_running: await isDaemonAlive(socketPath),
    graph_file_exists: graphExists,
    graph_last_modified: graphExists ? statSync(graphPath).mtime.toISOString() : null,
    socket_path: socketPath,
  };
}

// ============================================================================
// Socket Path Resolution
// ============================================================================

// Re-export from lifecycle to avoid duplication
export { resolveDaemonSocket } from './task-daemon-lifecycle.js';
