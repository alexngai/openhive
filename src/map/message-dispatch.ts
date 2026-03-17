/**
 * Transport-agnostic MAP message dispatch
 *
 * Extracted from ws-map.ts so both WebSocket and mesh handlers share
 * the same message processing logic. Callers provide reply callbacks
 * that abstract over the underlying transport.
 */

import {
  listSwarms, createNode, deleteNode, findNodeBySwarmAndAgentId,
  updateNode, discoverNodes, findSwarmById, findNodeById, getNodeHierarchy,
} from '../db/dal/map.js';
import { handleSyncMessage, isMapSyncMessage, sendToSwarm } from './sync-listener.js';
import { isCoordinationMessage, handleCoordinationMessage } from '../coordination/listener.js';
import { routeHiveMessage, isHiveRouteError } from './hive-router.js';
import { getInboxJsonRpc, getInboxRouter, getInboxStorage } from './inbox-bridge.js';
import { handleXHiveMethod } from './hive-extensions.js';
import type { MapNode } from './types.js';
import { handleMapSubscribe, handleMapUnsubscribe } from './event-subscriptions.js';
import { getAllInbound } from './connection-registry.js';
import type { MapNodeState } from './types.js';
import { classifyMethod, getChannel } from './mesh-channels.js';

// ─── Reply abstraction ──────────────────────────────────────────────────────

export interface ReplyFunctions {
  sendNotification: (method: string, params: Record<string, unknown>) => void;
  sendError: (code: number, message: string, id?: string | number | null) => void;
  sendResult: (id: string | number | null | undefined, result: unknown) => void;
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Process a parsed JSON-RPC message from any transport.
 * The `ws` parameter is optional — only needed for subscribe/unsubscribe
 * which currently require a WebSocket reference. Pass null for mesh transport.
 */
export async function dispatchMapMessage(
  parsed: Record<string, unknown>,
  swarmId: string,
  reply: ReplyFunctions,
  ws?: import('ws').WebSocket | null,
): Promise<void> {
  // Track message on its protocol channel (if classified)
  const method = parsed.method as string | undefined;
  if (method) {
    const channelName = classifyMethod(method);
    if (channelName) {
      getChannel(channelName)?.recordReceived(parsed, swarmId);
    }
  }

  if (isMapSyncMessage(parsed)) {
    handleSyncMessage(parsed as any, swarmId);
  } else if (isCoordinationMessage(parsed)) {
    handleCoordinationMessage(parsed as any, swarmId);
  } else if (parsed.method === 'ping') {
    reply.sendNotification('pong', {});
  } else if (parsed.method === 'map/connect') {
    handleMapConnect(parsed, reply);
  } else if (parsed.method === 'map/send') {
    await handleMapSend(parsed, swarmId, reply);
  } else if (parsed.method === 'map/agents/register') {
    handleAgentRegister(parsed, swarmId, reply);
  } else if (parsed.method === 'map/agents/spawn') {
    handleAgentSpawn(parsed, swarmId, reply);
  } else if (parsed.method === 'map/agents/update') {
    handleAgentUpdate(parsed, swarmId, reply);
  } else if (parsed.method === 'map/agents/list') {
    handleAgentList(parsed, swarmId, reply);
  } else if (parsed.method === 'map/agents/unregister') {
    handleAgentUnregister(parsed, swarmId, reply);
  } else if (parsed.method === 'map/agents/hierarchy') {
    handleAgentHierarchy(parsed, swarmId, reply);
  } else if (parsed.method === 'map/subscribe' && ws) {
    handleMapSubscribe(ws, parsed as any, swarmId);
  } else if (parsed.method === 'map/unsubscribe' && ws) {
    handleMapUnsubscribe(ws, parsed as any, swarmId);
  } else if ((parsed.method as string)?.startsWith('map/federation/')) {
    handleFederationMethod(parsed, reply);
  } else if ((parsed.method as string)?.startsWith('x-hive/') && ws) {
    handleXHiveMethod(ws, parsed as any, swarmId);
  } else if ((parsed.method as string)?.startsWith('mail/')) {
    await handleMailMethod(parsed, reply);
  }
  // Unknown methods silently ignored (JSON-RPC 2.0 semantics)
}

// ============================================================================
// MAP Message Handlers
// ============================================================================

function handleMapConnect(
  msg: Record<string, unknown>,
  reply: ReplyFunctions,
): void {
  const params = msg.params as Record<string, unknown> | undefined;
  const participantId = (params?.participantId as string) ?? '';
  reply.sendResult(msg.id as string | number | null | undefined, {
    protocolVersion: '2025-01-01',
    sessionId: `session-${participantId || 'anon'}-${Date.now()}`,
    serverId: 'openhive-hub',
    capabilities: {
      mail: { enabled: true, canCreate: true, canJoin: true, canViewHistory: true },
      addressing: { hive: true, swarm: true, agent: true },
      federation: { enabled: true, methods: ['list-peers', 'add-peer', 'remove-peer'] },
      extensions: ['x-hive'],
    },
  });
}

async function handleMapSend(
  msg: Record<string, unknown>,
  sourceSwarmId: string,
  reply: ReplyFunctions,
): Promise<void> {
  const params = msg.params as Record<string, unknown> | undefined;
  const msgId = msg.id as string | number | null | undefined;
  const to = params?.to as { id?: string; scope?: string } | undefined;
  const toId = to?.id;

  // Support scope-based addressing (broadcast to all members of a scope)
  if (!toId && to?.scope) {
    // Scope-based sends are fire-and-forget broadcasts; ack without delivery tracking
    reply.sendResult(msgId, { ok: true, broadcast: true, scope: to.scope });
    return;
  }

  if (!toId) {
    reply.sendError(-32602, 'Missing to.id in map/send params', msgId);
    return;
  }

  if (toId.startsWith('hive:')) {
    const result = await routeHiveMessage(sourceSwarmId, params ?? {});
    if (isHiveRouteError(result)) {
      reply.sendError(result.code, result.message, msgId);
    } else {
      reply.sendResult(msgId, result);
    }
  } else {
    // Direct agent or swarm delivery
    const targetSwarmId = toId.startsWith('swarm:')
      ? toId.slice(6)
      : resolveAgentSwarm(toId.startsWith('agent:') ? toId.slice(6) : toId);

    if (!targetSwarmId) {
      reply.sendError(-32001, `Target not found: ${toId}`, msgId);
      return;
    }

    await handleDirectSend(msg, sourceSwarmId, targetSwarmId, reply);
  }
}

async function handleDirectSend(
  msg: Record<string, unknown>,
  sourceSwarmId: string,
  targetSwarmId: string,
  reply: ReplyFunctions,
): Promise<void> {
  const params = msg.params as Record<string, unknown> | undefined;
  const msgId = msg.id as string | number | null | undefined;

  // Resolve target agent ID for proper inbox storage (getInbox queries by agent ID).
  // Try inbound connection first, then fall back to DB lookup.
  const targetConn = getAllInbound().get(targetSwarmId);
  let targetAgentId = targetConn?.agentId;
  if (!targetAgentId) {
    const swarm = findSwarmById(targetSwarmId);
    targetAgentId = swarm?.owner_agent_id ?? targetSwarmId;
  }

  const message = await getInboxRouter().routeMessage({
    from: sourceSwarmId,
    to: targetAgentId,
    payload: params?.payload,
    subject: (params?.subject as string) ?? undefined,
  });
  const sent = sendToSwarm(targetSwarmId, {
    jsonrpc: '2.0',
    method: 'map/send',
    params: {
      from: { type: 'agent', id: sourceSwarmId },
      to: params?.to,
      payload: params?.payload,
      messageId: message.id,
    },
  });
  reply.sendResult(msgId, { messageId: message.id, delivered: sent });
}

/**
 * Resolve an agent ID to the swarm it belongs to.
 * Checks map_nodes first (agent registered within a swarm), then falls back
 * to finding a swarm owned by the agent.
 */
function resolveAgentSwarm(agentId: string): string | null {
  // Check map_nodes for an active node with this agent ID
  const { data: nodes } = discoverNodes({ map_agent_id: agentId, state: 'active', limit: 1 });
  if (nodes.length > 0) return nodes[0].swarm_id;

  // Fall back to swarm ownership
  const { data: swarms } = listSwarms({ owner_agent_id: agentId, status: 'online', limit: 1 });
  return swarms[0]?.id ?? null;
}

function handleAgentRegister(
  msg: Record<string, unknown>,
  swarmId: string,
  reply: ReplyFunctions,
): void {
  const params = msg.params as Record<string, unknown> | undefined;
  const msgId = msg.id as string | number | null | undefined;

  try {
    // SDK may not provide agentId — generate one from name or use a random ID
    const explicitId = (params?.agentId as string) ?? (params?.agent_id as string);
    const name = (params?.name as string) ?? 'unnamed';
    const agentId = explicitId || `${name}-${swarmId.slice(-8)}`;

    // Resolve parent: accept parent agent ID or parent node ID
    const parentAgentId = (params?.parent as string) ?? (params?.parent_agent_id as string);
    const parentNodeId = (params?.parent_node_id as string);
    let resolvedParentNodeId: string | undefined;
    if (parentNodeId) {
      resolvedParentNodeId = parentNodeId;
    } else if (parentAgentId) {
      const parentNode = findNodeBySwarmAndAgentId(swarmId, parentAgentId);
      resolvedParentNodeId = parentNode?.id;
    }

    const node = createNode({
      swarm_id: swarmId,
      map_agent_id: agentId,
      name,
      role: (params?.role as string) ?? 'worker',
      state: 'active',
      capabilities: (params?.capabilities as Record<string, unknown>) ?? {},
      parent_node_id: resolvedParentNodeId,
    });

    // Also register in inbox for discoverability
    try {
      const inboxStorage = getInboxStorage();
      inboxStorage.putAgent({
        agent_id: node.map_agent_id,
        scope: 'default',
        status: 'active',
        metadata: { swarm_id: swarmId, node_id: node.id, parent_node_id: node.parent_node_id },
        registered_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }

    reply.sendResult(msgId, {
      agent: { id: node.map_agent_id, state: node.state, name: node.name, role: node.role, parent: node.parent_node_id },
      nodeId: node.id,
    });
  } catch (err) {
    reply.sendError(-32603, `Failed to register agent: ${err instanceof Error ? err.message : err}`, msgId);
  }
}

function handleAgentSpawn(
  msg: Record<string, unknown>,
  swarmId: string,
  reply: ReplyFunctions,
): void {
  const params = msg.params as Record<string, unknown> | undefined;
  const msgId = msg.id as string | number | null | undefined;

  try {
    const agentId = (params?.agentId as string) ?? (params?.agent_id as string);

    // Resolve parent
    const parentAgentId = (params?.parent as string) ?? (params?.parent_agent_id as string);
    const parentNodeId = (params?.parent_node_id as string);
    let resolvedParentNodeId: string | undefined;
    if (parentNodeId) {
      resolvedParentNodeId = parentNodeId;
    } else if (parentAgentId) {
      const parentNode = findNodeBySwarmAndAgentId(swarmId, parentAgentId);
      resolvedParentNodeId = parentNode?.id;
    }

    const node = createNode({
      swarm_id: swarmId,
      map_agent_id: agentId,
      name: (params?.name as string) ?? 'spawned',
      role: (params?.role as string) ?? 'agent',
      state: 'active',
      capabilities: (params?.capabilities as Record<string, unknown>) ?? {},
      parent_node_id: resolvedParentNodeId,
    });

    // Register in inbox for discoverability
    try {
      const inboxStorage = getInboxStorage();
      inboxStorage.putAgent({
        agent_id: node.map_agent_id,
        scope: 'default',
        status: 'active',
        metadata: { swarm_id: swarmId, node_id: node.id, spawned: true, parent_node_id: node.parent_node_id },
        registered_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }

    // Return format matching MAP SDK expectations
    reply.sendResult(msgId, {
      agent: { id: node.map_agent_id, state: 'active', name: node.name, role: node.role, parent: node.parent_node_id },
    });
  } catch (err) {
    reply.sendError(-32603, `Failed to spawn agent: ${err instanceof Error ? err.message : err}`, msgId);
  }
}

function handleAgentUpdate(
  msg: Record<string, unknown>,
  swarmId: string,
  reply: ReplyFunctions,
): void {
  const params = msg.params as Record<string, unknown> | undefined;
  const msgId = msg.id as string | number | null | undefined;

  try {
    const agentId = (params?.agentId as string) ?? (params?.agent_id as string);
    const node = findNodeBySwarmAndAgentId(swarmId, agentId);
    if (!node) {
      reply.sendError(-32001, `Agent not found: ${agentId}`, msgId);
      return;
    }

    const newState = (params?.state as string) ?? node.state;
    updateNode(node.id, {
      state: newState as MapNodeState | undefined,
      capabilities: params?.metadata
        ? { ...(typeof node.capabilities === 'object' ? node.capabilities : {}), ...(params.metadata as Record<string, unknown>) }
        : undefined,
    });

    reply.sendResult(msgId, {
      agent: { id: node.map_agent_id, state: newState, name: node.name, role: node.role },
    });
  } catch (err) {
    reply.sendError(-32603, `Failed to update agent: ${err instanceof Error ? err.message : err}`, msgId);
  }
}

function handleAgentUnregister(
  msg: Record<string, unknown>,
  swarmId: string,
  reply: ReplyFunctions,
): void {
  const params = msg.params as Record<string, unknown> | undefined;
  const msgId = msg.id as string | number | null | undefined;

  try {
    const agentId = (params?.agentId as string) ?? (params?.agent_id as string);
    const node = findNodeBySwarmAndAgentId(swarmId, agentId);
    if (node) {
      deleteNode(node.id);

      // Mark offline in inbox
      try {
        const inboxStorage = getInboxStorage();
        const inboxAgent = inboxStorage.getAgent(agentId);
        if (inboxAgent) {
          inboxAgent.status = 'offline';
          inboxStorage.putAgent(inboxAgent);
        }
      } catch { /* non-fatal */ }

      reply.sendResult(msgId, { ok: true });
    } else {
      reply.sendError(-32001, `Agent node not found: ${agentId}`, msgId);
    }
  } catch (err) {
    reply.sendError(-32603, `Failed to unregister agent: ${err instanceof Error ? err.message : err}`, msgId);
  }
}

function handleAgentHierarchy(
  msg: Record<string, unknown>,
  swarmId: string,
  reply: ReplyFunctions,
): void {
  const params = msg.params as Record<string, unknown> | undefined;
  const msgId = msg.id as string | number | null | undefined;

  try {
    const agentId = (params?.agentId as string) ?? (params?.agent_id as string);
    const nodeId = params?.node_id as string | undefined;

    // Resolve node: by node_id directly, or by agent_id within the swarm
    let node;
    if (nodeId) {
      node = findNodeById(nodeId);
    } else if (agentId) {
      node = findNodeBySwarmAndAgentId(swarmId, agentId);
    }

    if (!node) {
      reply.sendError(-32001, `Agent node not found: ${agentId ?? nodeId ?? 'unspecified'}`, msgId);
      return;
    }

    const hierarchy = getNodeHierarchy(node.id, {
      includeParent: (params?.includeParent as boolean) ?? true,
      includeChildren: (params?.includeChildren as boolean) ?? true,
      includeSiblings: (params?.includeSiblings as boolean) ?? false,
      includeAncestors: (params?.includeAncestors as boolean) ?? false,
      includeDescendants: (params?.includeDescendants as boolean) ?? false,
      maxDepth: (params?.maxDepth as number) ?? 5,
    });

    if (!hierarchy) {
      reply.sendError(-32001, `Node not found: ${node.id}`, msgId);
      return;
    }

    const toAgent = (n: MapNode) => ({
      id: n.map_agent_id,
      nodeId: n.id,
      name: n.name,
      role: n.role,
      state: n.state,
      parent: n.parent_node_id,
    });

    reply.sendResult(msgId, {
      agent: toAgent(hierarchy.node),
      parent: hierarchy.parent ? toAgent(hierarchy.parent) : null,
      children: hierarchy.children?.map(toAgent),
      siblings: hierarchy.siblings?.map(toAgent),
      ancestors: hierarchy.ancestors?.map(toAgent),
      descendants: hierarchy.descendants?.map(toAgent),
    });
  } catch (err) {
    reply.sendError(-32603, `Failed to get agent hierarchy: ${err instanceof Error ? err.message : err}`, msgId);
  }
}

function handleAgentList(
  msg: Record<string, unknown>,
  _swarmId: string,
  reply: ReplyFunctions,
): void {
  const params = msg.params as Record<string, unknown> | undefined;
  const msgId = msg.id as string | number | null | undefined;

  try {
    const { data, total } = discoverNodes({
      swarm_id: params?.swarm_id as string | undefined,
      hive_id: params?.hive_id as string | undefined,
      state: params?.state as MapNodeState | undefined,
      role: params?.role as string | undefined,
      limit: (params?.limit as number) ?? 50,
      offset: (params?.offset as number) ?? 0,
    });
    reply.sendResult(msgId, { agents: data, total });
  } catch (err) {
    reply.sendError(-32603, `Failed to list agents: ${err instanceof Error ? err.message : err}`, msgId);
  }
}

// ============================================================================
// Federation Methods (stubbed — see docs/design/hive-as-map-entity.md)
// ============================================================================

const FEDERATION_METHODS = ['map/federation/list-peers', 'map/federation/add-peer', 'map/federation/remove-peer'];

function handleFederationMethod(
  msg: Record<string, unknown>,
  reply: ReplyFunctions,
): void {
  const method = msg.method as string;
  const msgId = msg.id as string | number | null | undefined;

  if (!FEDERATION_METHODS.includes(method)) {
    reply.sendError(-32601, `Unknown federation method: ${method}`, msgId);
    return;
  }

  // TODO: Add admin auth check — non-admin connections should get -32003 Forbidden
  // TODO: Implement handlers (see design doc for spec)
  reply.sendError(-32000, `${method} is not yet implemented`, msgId);
}

async function handleMailMethod(
  msg: Record<string, unknown>,
  reply: ReplyFunctions,
): Promise<void> {
  const msgId = msg.id as string | number | null | undefined;

  try {
    const jsonRpc = getInboxJsonRpc();
    const response = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: msgId ?? null,
      method: msg.method as string,
      params: msg.params as Record<string, unknown> | undefined,
    });

    // The JSON-RPC server returns a complete response object; send it raw
    // via the notification channel since it's already a fully formed JSON-RPC response.
    // We use sendResult with the response's result, or sendError with the response's error.
    const resp = response as unknown as Record<string, unknown>;
    if ('error' in resp && resp.error) {
      const err = resp.error as { code: number; message: string };
      reply.sendError(err.code, err.message, msgId);
    } else {
      reply.sendResult(msgId, resp.result);
    }
  } catch {
    reply.sendError(-32603, 'Internal error processing mail method', msgId);
  }
}
