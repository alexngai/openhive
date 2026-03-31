/**
 * OpenTasks Remote Query/Mutation
 *
 * Sends opentasks/*.request notifications to connected swarms and waits
 * for opentasks/*.response. Follows the same request/response pattern
 * as trajectory/content.request → trajectory/content.response.
 *
 * Used when a resource's graph is not local (no daemon socket) but the
 * owning swarm is connected via MAP WebSocket.
 */

import { nanoid } from 'nanoid';
import { getInbound, getAllInbound } from './connection-registry.js';
import type { SyncableResource } from '../types.js';

const REQUEST_TIMEOUT_MS = 10_000;

// ============================================================================
// Pending Request Tracking
// ============================================================================

interface PendingRequest {
  resolve: (value: Record<string, unknown> | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();

/**
 * Handle an incoming opentasks/*.response notification.
 * Called by the WebSocket notification interceptor in ws-map.ts.
 */
export function handleOpenTasksResponse(params: Record<string, unknown>): void {
  const requestId = params.request_id as string;
  if (!requestId) return;

  const pending = pendingRequests.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingRequests.delete(requestId);

  if (params.error) {
    pending.resolve(null);
    return;
  }

  pending.resolve(params);
}

// ============================================================================
// Swarm Lookup
// ============================================================================

/**
 * Find which connected swarm owns a resource's task graph.
 * Matches by: location_hash → owner_agent_id → explicit resource_id.
 */
export function findSwarmForResource(resource: SyncableResource): string | null {
  const meta = resource.metadata as Record<string, unknown> | null;
  const resourceLocationHash = meta?.location_hash as string | undefined;

  for (const [swarmId, conn] of getAllInbound()) {
    // readyState 1 = OPEN (ws library constant may differ)
    if (conn.ws.readyState !== 1) continue;

    const taskGraph = conn.defaultTaskGraph;
    if (!taskGraph) continue;

    // Match by location_hash (most reliable — stable across instances)
    if (resourceLocationHash && taskGraph.location_hash && taskGraph.location_hash === resourceLocationHash) {
      return swarmId;
    }

    // Match by explicit resource_id
    if (taskGraph.resource_id && taskGraph.resource_id === resource.id) {
      return swarmId;
    }

    // Match by path (least reliable but useful for local-ish scenarios)
    if (taskGraph.path && resource.local_path && taskGraph.path === resource.local_path) {
      return swarmId;
    }
  }

  // Fallback: match by owner_agent_id, but only if the swarm declared a task graph.
  // Without this guard, in local mode every swarm matches every resource (same agent),
  // causing 10-second request timeouts to swarms that don't support opentasks.
  for (const [swarmId, conn] of getAllInbound()) {
    if (conn.ws.readyState !== 1) continue;
    if (!conn.defaultTaskGraph) continue;
    if (conn.agentId === resource.owner_agent_id) {
      return swarmId;
    }
  }

  return null;
}

// ============================================================================
// Remote Operations
// ============================================================================

/**
 * Send an opentasks request notification to a connected swarm and wait for response.
 */
async function sendRequest(
  swarmId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const conn = getInbound(swarmId);
  if (!conn || conn.ws.readyState !== 1) return null;

  const requestId = `ot-${nanoid(8)}`;

  const notification = {
    jsonrpc: '2.0',
    method,
    params: {
      ...params,
      request_id: requestId,
    },
  };

  try {
    conn.ws.send(JSON.stringify(notification));
  } catch {
    return null;
  }

  return new Promise<Record<string, unknown> | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve(null);
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(requestId, { resolve, timer });
  });
}

/**
 * Query tasks from a remote swarm's opentasks graph.
 */
export async function remoteQueryTasks(
  swarmId: string,
  filter?: Record<string, unknown>,
  limit?: number,
): Promise<{ items: Record<string, unknown>[]; hasMore: boolean } | null> {
  const result = await sendRequest(swarmId, 'opentasks/query.request', {
    query: {
      nodes: {
        type: 'task',
        archived: false,
        ...filter,
        limit: limit ?? 100,
      },
    },
  });
  if (!result) return null;
  return {
    items: (result.items as Record<string, unknown>[]) ?? [],
    hasMore: (result.hasMore as boolean) ?? false,
  };
}

/**
 * Get full graph (nodes + edges) from a remote swarm.
 */
export async function remoteGetGraph(
  swarmId: string,
): Promise<{ nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] } | null> {
  // Query nodes
  const nodesResult = await sendRequest(swarmId, 'opentasks/query.request', {
    query: { nodes: { archived: false }, limit: 5000, verbose: true },
  });
  if (!nodesResult) return null;

  // Query edges
  const edgesResult = await sendRequest(swarmId, 'opentasks/query.request', {
    query: { edges: {}, limit: 10000 },
  });

  const nodes = ((nodesResult.items as Record<string, unknown>[]) ?? []).map((n) => ({
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

  const edges = edgesResult
    ? ((edgesResult.items as Record<string, unknown>[]) ?? []).map((e) => ({
        id: e.id, from_id: e.fromId, to_id: e.toId, type: e.type,
      }))
    : [];

  return { nodes, edges };
}

/**
 * Get summary from a remote swarm.
 */
export async function remoteGetSummary(
  swarmId: string,
): Promise<Record<string, unknown> | null> {
  const result = await sendRequest(swarmId, 'opentasks/query.request', {
    query: { nodes: { archived: false }, limit: 5000 },
  });
  if (!result) return null;

  const items = (result.items as Array<{ type: string; status?: string }>) ?? [];
  const taskCounts: Record<string, number> = {};
  let contextCount = 0;
  let feedbackCount = 0;

  for (const node of items) {
    if (node.type === 'task') {
      const s = node.status || 'open';
      taskCounts[s] = (taskCounts[s] ?? 0) + 1;
    } else if (node.type === 'context') contextCount++;
    else if (node.type === 'feedback') feedbackCount++;
  }

  return {
    node_count: items.length,
    edge_count: 0,
    task_counts: taskCounts,
    context_count: contextCount,
    feedback_count: feedbackCount,
    ready_count: 0,
    daemon_connected: false,
    remote_connected: true,
  };
}

/**
 * Create a task on a remote swarm's graph.
 */
export async function remoteCreateTask(
  swarmId: string,
  params: { title?: string; description?: string; status?: string; priority?: number },
): Promise<Record<string, unknown> | null> {
  return await sendRequest(swarmId, 'opentasks/task.request', {
    task: {
      transition: undefined,
      ready: undefined,
      assign: undefined,
      validActions: undefined,
    },
    // Use the query to create — the connector routes to client.task()
    // But actually, for creation we need graph.create which goes through the connector's query path
    // Let's use a direct create approach
    create: {
      type: 'task',
      title: params.title || 'Untitled',
      content: params.description,
      status: params.status || 'open',
      priority: params.priority,
    },
  });
}

/**
 * Update a task's status on a remote swarm's graph.
 */
export async function remoteUpdateTask(
  swarmId: string,
  taskId: string,
  status: string,
): Promise<Record<string, unknown> | null> {
  return await sendRequest(swarmId, 'opentasks/task.request', {
    task: {
      transition: { id: taskId, action: statusToAction(status) },
    },
  });
}

function statusToAction(status: string): string {
  const map: Record<string, string> = {
    in_progress: 'start', completed: 'complete', closed: 'close',
    blocked: 'block', open: 'reopen', failed: 'close',
  };
  return map[status] || 'close';
}
