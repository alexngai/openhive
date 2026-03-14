/**
 * MAP Inbound WebSocket Endpoint (/ws/map)
 *
 * Allows MAP-compatible agents to connect INTO the hub via WebSocket and
 * send/receive JSON-RPC 2.0 messages. The hub stores, tracks, and routes
 * messages to other connected agents (both inbound and outbound).
 *
 * This is the complement to sync-listener.ts (which connects OUT to swarms).
 * Once a message arrives, it flows through the same handleSyncMessage() and
 * handleCoordinationMessage() handlers that process outbound-connected messages.
 */

import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { findAgentById, findAgentByApiKey, findOrCreateSwarmHubAgent } from '../db/dal/agents.js';
import { validateIngestKey } from '../db/dal/ingest-keys.js';
import { validateSwarmHubToken, isJwksInitialized } from '../auth/jwks.js';
import {
  listSwarms, createSwarm, heartbeatSwarm, updateSwarm,
  createNode, deleteNode, findNodeBySwarmAndAgentId, updateNode,
  discoverNodes, findSwarmById,
} from '../db/dal/map.js';
import { handleSyncMessage, hasOutboundConnection, sendToSwarm } from './sync-listener.js';
import { isMapSyncMessage } from './sync-listener.js';
import { isCoordinationMessage, handleCoordinationMessage } from '../coordination/listener.js';
import { registerInbound, unregisterInbound, getAllInbound } from './connection-registry.js';
import { routeHiveMessage, isHiveRouteError } from './hive-router.js';
import { getInboxJsonRpc, getInboxRouter, getInboxStorage } from './inbox-bridge.js';
import { handleXHiveMethod } from './hive-extensions.js';
import { handleMapSubscribe, handleMapUnsubscribe, cleanupSubscriptions } from './event-subscriptions.js';
import type { Agent } from '../types.js';

const HEARTBEAT_INTERVAL = 30_000;
let heartbeatTimer: NodeJS.Timeout | null = null;

// ============================================================================
// Auth (same pattern as src/realtime/index.ts:29-55)
// ============================================================================

async function authenticateToken(token: string): Promise<Agent | null> {
  // Try ingest key first (ohk_ prefix, SHA-256 O(1) lookup)
  if (token.startsWith('ohk_')) {
    const ingestKey = validateIngestKey(token);
    if (ingestKey) {
      return findAgentById(ingestKey.agent_id) ?? null;
    }
    return null;
  }

  // Try API key (bcrypt)
  const agent = await findAgentByApiKey(token);
  if (agent) return agent;

  // Try SwarmHub JWT
  if (isJwksInitialized()) {
    const payload = await validateSwarmHubToken(token);
    if (payload?.sub) {
      return findOrCreateSwarmHubAgent({
        swarmhubUserId: payload.sub,
        name: payload.name,
        email: payload.email,
        avatarUrl: payload.avatar_url,
      });
    }
  }

  return null;
}

// ============================================================================
// Swarm Resolution
// ============================================================================

function resolveSwarm(agentId: string, swarmIdHint?: string): string | null {
  if (swarmIdHint) {
    // Verify the hint — agent must own the swarm
    const { data: swarms } = listSwarms({ owner_agent_id: agentId, limit: 100 });
    const match = swarms.find((s) => s.id === swarmIdHint);
    return match ? match.id : null;
  }

  // Pick the first swarm owned by this agent (prefer online)
  const { data: swarms } = listSwarms({ owner_agent_id: agentId, limit: 10 });
  if (swarms.length === 0) return null;

  const online = swarms.find((s) => s.status === 'online');
  return online ? online.id : swarms[0].id;
}

function autoRegisterSwarm(agentId: string, agentName: string): string {
  const swarm = createSwarm(agentId, {
    name: `${agentName}-hub`,
    map_endpoint: 'hub-inbound',
    map_transport: 'websocket',
    auth_method: 'none',
  });
  return swarm.id;
}

// ============================================================================
// JSON-RPC Helpers
// ============================================================================

function sendJsonRpc(ws: WebSocket, method: string, params: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }
}

function sendJsonRpcError(ws: WebSocket, code: number, message: string, id?: string | number | null): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code, message },
    }));
  }
}

function sendJsonRpcResult(ws: WebSocket, id: string | number | null | undefined, result: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      result,
    }));
  }
}

// ============================================================================
// Message Processing
// ============================================================================

async function processMessage(ws: WebSocket, data: unknown, swarmId: string): Promise<void> {
  try {
    const parsed = JSON.parse((data as Buffer).toString());

    if (isMapSyncMessage(parsed)) {
      handleSyncMessage(parsed, swarmId);
    } else if (isCoordinationMessage(parsed)) {
      handleCoordinationMessage(parsed, swarmId);
    } else if (parsed.method === 'ping') {
      sendJsonRpc(ws, 'pong', {});
    } else if (parsed.method === 'map/connect') {
      handleMapConnect(ws, parsed);
    } else if (parsed.method === 'map/send') {
      await handleMapSend(ws, parsed, swarmId);
    } else if (parsed.method === 'map/agents/register') {
      handleAgentRegister(ws, parsed, swarmId);
    } else if (parsed.method === 'map/agents/spawn') {
      handleAgentSpawn(ws, parsed, swarmId);
    } else if (parsed.method === 'map/agents/update') {
      handleAgentUpdate(ws, parsed, swarmId);
    } else if (parsed.method === 'map/agents/list') {
      handleAgentList(ws, parsed, swarmId);
    } else if (parsed.method === 'map/agents/unregister') {
      handleAgentUnregister(ws, parsed, swarmId);
    } else if (parsed.method === 'map/subscribe') {
      handleMapSubscribe(ws, parsed, swarmId);
    } else if (parsed.method === 'map/unsubscribe') {
      handleMapUnsubscribe(ws, parsed, swarmId);
    } else if (parsed.method?.startsWith('map/federation/')) {
      handleFederationMethod(ws, parsed, swarmId);
    } else if (parsed.method?.startsWith('x-hive/')) {
      handleXHiveMethod(ws, parsed, swarmId);
    } else if (parsed.method?.startsWith('mail/')) {
      handleMailMethod(ws, parsed);
    }
    // Unknown methods silently ignored (JSON-RPC 2.0 semantics)

    // Update heartbeat on any valid message
    const conn = getAllInbound().get(swarmId);
    if (conn) {
      conn.lastMessageAt = new Date().toISOString();
    }
    heartbeatSwarm(swarmId);
  } catch {
    // Ignore non-JSON messages
  }
}

// ============================================================================
// WebSocket Handler
// ============================================================================

export function setupMapWebSocket(fastify: FastifyInstance): void {
  fastify.get('/ws/map', { websocket: true }, async (socket, request) => {
    const ws = socket as unknown as WebSocket;
    const query = request.query as { token?: string; swarm_id?: string; auto_register?: string };

    // Buffer messages arriving during async auth to avoid race condition:
    // The client can send messages as soon as the WebSocket opens, but
    // we need to authenticate before we can process them.
    const pendingMessages: Buffer[] = [];
    let ready = false;
    let swarmId: string | undefined;
    let agentId: string | undefined;

    // Register message/close/error handlers synchronously BEFORE any await
    // to prevent losing messages sent during async authentication
    ws.on('message', (data) => {
      if (!ready) {
        pendingMessages.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      processMessage(ws, data, swarmId!);
    });

    ws.on('close', () => {
      if (swarmId) {
        unregisterInbound(swarmId);
        cleanupSubscriptions(swarmId);
        console.log(`[ws-map] Swarm ${swarmId} disconnected`);

        // Mark agent offline in inbox
        if (agentId) {
          try {
            const inboxStorage = getInboxStorage();
            const inboxAgent = inboxStorage.getAgent(agentId);
            if (inboxAgent) {
              inboxAgent.status = 'offline';
              inboxAgent.last_active_at = new Date().toISOString();
              inboxStorage.putAgent(inboxAgent);
            }
          } catch { /* non-fatal */ }
        }

        // Mark swarm offline if no outbound connection exists either
        if (!hasOutboundConnection(swarmId)) {
          updateSwarm(swarmId, { status: 'offline' });
        }
      }
    });

    ws.on('error', (err) => {
      console.warn(`[ws-map] WebSocket error for swarm ${swarmId}: ${err.message}`);
    });

    // --- Async authentication starts here ---

    if (!query.token) {
      sendJsonRpcError(ws, -32000, 'Missing token query parameter');
      ws.close(4001, 'Unauthorized');
      return;
    }

    const agent = await authenticateToken(query.token);
    if (!agent) {
      sendJsonRpcError(ws, -32000, 'Invalid authentication token');
      ws.close(4001, 'Unauthorized');
      return;
    }

    agentId = agent.id;

    // Resolve swarm
    swarmId = resolveSwarm(agent.id, query.swarm_id);

    if (!swarmId && query.auto_register === 'true') {
      swarmId = autoRegisterSwarm(agent.id, agent.name);
      console.log(`[ws-map] Auto-registered hub-inbound swarm ${swarmId} for agent ${agent.name}`);
    }

    if (!swarmId) {
      sendJsonRpcError(ws, -32001, 'No registered swarm found. Register a swarm first or use ?auto_register=true');
      ws.close(4002, 'No swarm');
      return;
    }

    // Register inbound connection
    const now = new Date().toISOString();
    registerInbound(swarmId, {
      ws,
      agentId: agent.id,
      swarmId,
      connectedAt: now,
      lastMessageAt: now,
    });

    // Mark swarm online
    heartbeatSwarm(swarmId);

    // Register agent in inbox for discoverability and routing
    try {
      const inboxStorage = getInboxStorage();
      inboxStorage.putAgent({
        agent_id: agent.id,
        scope: 'default',
        status: 'active',
        metadata: { swarm_id: swarmId, name: agent.name },
        registered_at: new Date().toISOString(),
        last_active_at: now,
      });
    } catch {
      // Inbox bridge may not be initialized yet — non-fatal
    }

    // Send welcome with capabilities
    sendJsonRpc(ws, 'hub/welcome', {
      swarm_id: swarmId,
      agent_id: agent.id,
      agent_name: agent.name,
      capabilities: {
        mail: { enabled: true },
        addressing: { hive: true, swarm: true, hub: true },
      },
    });

    // Replay unread messages missed while disconnected
    try {
      const inbox = getInboxStorage();
      const unread = inbox.getInbox(agent.id, { unreadOnly: true, limit: 50 });
      if (unread.length > 0) {
        sendJsonRpc(ws, 'map/replay', {
          messages: unread,
          count: unread.length,
        });
        console.log(`[ws-map] Replayed ${unread.length} unread messages to ${agent.name}`);
      }
    } catch {
      // Inbox bridge may not be initialized yet — non-fatal
    }

    console.log(`[ws-map] Swarm ${swarmId} connected inbound (agent: ${agent.name})`);

    // Mark ready and drain any messages that arrived during auth
    ready = true;
    for (const buffered of pendingMessages) {
      processMessage(ws, buffered, swarmId);
    }
    pendingMessages.length = 0;
  });

  // Start heartbeat
  startMapHeartbeat();

  console.log('[openhive] MAP WebSocket registered at /ws/map');
}

// ============================================================================
// MAP Message Handlers
// ============================================================================

function handleMapConnect(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
): void {
  const participantId = (msg.params?.participantId as string) ?? '';
  sendJsonRpcResult(ws, msg.id, {
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
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  sourceSwarmId: string,
): Promise<void> {
  const to = msg.params?.to as { id?: string; scope?: string } | undefined;
  const toId = to?.id;

  // Support scope-based addressing (broadcast to all members of a scope)
  if (!toId && to?.scope) {
    // Scope-based sends are fire-and-forget broadcasts; ack without delivery tracking
    sendJsonRpcResult(ws, msg.id, { ok: true, broadcast: true, scope: to.scope });
    return;
  }

  if (!toId) {
    sendJsonRpcError(ws, -32602, 'Missing to.id in map/send params', msg.id);
    return;
  }

  if (toId.startsWith('hive:')) {
    const result = await routeHiveMessage(sourceSwarmId, msg.params ?? {});
    if (isHiveRouteError(result)) {
      sendJsonRpcError(ws, result.code, result.message, msg.id);
    } else {
      sendJsonRpcResult(ws, msg.id, result);
    }
  } else {
    // Direct agent or swarm delivery
    const targetSwarmId = toId.startsWith('swarm:')
      ? toId.slice(6)
      : resolveAgentSwarm(toId.startsWith('agent:') ? toId.slice(6) : toId);

    if (!targetSwarmId) {
      sendJsonRpcError(ws, -32001, `Target not found: ${toId}`, msg.id);
      return;
    }

    await handleDirectSend(ws, msg, sourceSwarmId, targetSwarmId);
  }
}

async function handleDirectSend(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  sourceSwarmId: string,
  targetSwarmId: string,
): Promise<void> {
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
    payload: msg.params?.payload,
    subject: (msg.params?.subject as string) ?? undefined,
  });
  const sent = sendToSwarm(targetSwarmId, {
    jsonrpc: '2.0',
    method: 'map/send',
    params: {
      from: { type: 'agent', id: sourceSwarmId },
      to: msg.params?.to,
      payload: msg.params?.payload,
      messageId: message.id,
    },
  });
  sendJsonRpcResult(ws, msg.id, { messageId: message.id, delivered: sent });
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
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  swarmId: string,
): void {
  try {
    // SDK may not provide agentId — generate one from name or use a random ID
    const explicitId = (msg.params?.agentId as string) ?? (msg.params?.agent_id as string);
    const name = (msg.params?.name as string) ?? 'unnamed';
    const agentId = explicitId || `${name}-${swarmId.slice(-8)}`;

    const node = createNode({
      swarm_id: swarmId,
      map_agent_id: agentId,
      name,
      role: (msg.params?.role as string) ?? 'worker',
      state: 'active',
      capabilities: (msg.params?.capabilities as Record<string, unknown>) ?? {},
    });

    // Also register in inbox for discoverability
    try {
      const inboxStorage = getInboxStorage();
      inboxStorage.putAgent({
        agent_id: node.map_agent_id,
        scope: 'default',
        status: 'active',
        metadata: { swarm_id: swarmId, node_id: node.id },
        registered_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }

    sendJsonRpcResult(ws, msg.id, {
      agent: { id: node.map_agent_id, state: node.state, name: node.name, role: node.role },
      nodeId: node.id,
    });
  } catch (err) {
    sendJsonRpcError(ws, -32603, `Failed to register agent: ${err instanceof Error ? err.message : err}`, msg.id);
  }
}

function handleAgentSpawn(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  swarmId: string,
): void {
  try {
    const agentId = (msg.params?.agentId as string) ?? (msg.params?.agent_id as string);
    const node = createNode({
      swarm_id: swarmId,
      map_agent_id: agentId,
      name: (msg.params?.name as string) ?? 'spawned',
      role: (msg.params?.role as string) ?? 'agent',
      state: 'active',
      capabilities: (msg.params?.capabilities as Record<string, unknown>) ?? {},
    });

    // Register in inbox for discoverability
    try {
      const inboxStorage = getInboxStorage();
      inboxStorage.putAgent({
        agent_id: node.map_agent_id,
        scope: 'default',
        status: 'active',
        metadata: { swarm_id: swarmId, node_id: node.id, spawned: true },
        registered_at: new Date().toISOString(),
        last_active_at: new Date().toISOString(),
      });
    } catch { /* non-fatal */ }

    // Return format matching MAP SDK expectations
    sendJsonRpcResult(ws, msg.id, {
      agent: { id: node.map_agent_id, state: 'active', name: node.name, role: node.role },
    });
  } catch (err) {
    sendJsonRpcError(ws, -32603, `Failed to spawn agent: ${err instanceof Error ? err.message : err}`, msg.id);
  }
}

function handleAgentUpdate(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  swarmId: string,
): void {
  try {
    const agentId = (msg.params?.agentId as string) ?? (msg.params?.agent_id as string);
    const node = findNodeBySwarmAndAgentId(swarmId, agentId);
    if (!node) {
      sendJsonRpcError(ws, -32001, `Agent not found: ${agentId}`, msg.id);
      return;
    }

    const newState = (msg.params?.state as string) ?? node.state;
    updateNode(node.id, {
      state: newState as import('../map/types.js').MapNodeState | undefined,
      capabilities: msg.params?.metadata
        ? { ...(typeof node.capabilities === 'object' ? node.capabilities : {}), ...(msg.params.metadata as Record<string, unknown>) }
        : undefined,
    });

    sendJsonRpcResult(ws, msg.id, {
      agent: { id: node.map_agent_id, state: newState, name: node.name, role: node.role },
    });
  } catch (err) {
    sendJsonRpcError(ws, -32603, `Failed to update agent: ${err instanceof Error ? err.message : err}`, msg.id);
  }
}

function handleAgentUnregister(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  swarmId: string,
): void {
  try {
    const agentId = (msg.params?.agentId as string) ?? (msg.params?.agent_id as string);
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

      sendJsonRpcResult(ws, msg.id, { ok: true });
    } else {
      sendJsonRpcError(ws, -32001, `Agent node not found: ${agentId}`, msg.id);
    }
  } catch (err) {
    sendJsonRpcError(ws, -32603, `Failed to unregister agent: ${err instanceof Error ? err.message : err}`, msg.id);
  }
}

function handleAgentList(
  ws: WebSocket,
  msg: { id?: string | number | null; params?: Record<string, unknown> },
  swarmId: string,
): void {
  try {
    const { data, total } = discoverNodes({
      swarm_id: msg.params?.swarm_id as string | undefined,
      hive_id: msg.params?.hive_id as string | undefined,
      state: msg.params?.state as import('../map/types.js').MapNodeState | undefined,
      role: msg.params?.role as string | undefined,
      limit: (msg.params?.limit as number) ?? 50,
      offset: (msg.params?.offset as number) ?? 0,
    });
    sendJsonRpcResult(ws, msg.id, { agents: data, total });
  } catch (err) {
    sendJsonRpcError(ws, -32603, `Failed to list agents: ${err instanceof Error ? err.message : err}`, msg.id);
  }
}

// ============================================================================
// Federation Methods (stubbed — see docs/design/hive-as-map-entity.md)
// ============================================================================

const FEDERATION_METHODS = ['map/federation/list-peers', 'map/federation/add-peer', 'map/federation/remove-peer'];

function handleFederationMethod(
  ws: WebSocket,
  msg: { id?: string | number | null; method: string; params?: Record<string, unknown> },
  _swarmId: string,
): void {
  if (!FEDERATION_METHODS.includes(msg.method)) {
    sendJsonRpcError(ws, -32601, `Unknown federation method: ${msg.method}`, msg.id);
    return;
  }

  // TODO: Add admin auth check — non-admin connections should get -32003 Forbidden
  // TODO: Implement handlers (see design doc for spec)
  sendJsonRpcError(ws, -32000, `${msg.method} is not yet implemented`, msg.id);
}

async function handleMailMethod(
  ws: WebSocket,
  msg: { jsonrpc: string; id?: string | number | null; method: string; params?: Record<string, unknown> },
): Promise<void> {
  try {
    const jsonRpc = getInboxJsonRpc();
    const response = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: msg.id ?? null,
      method: msg.method,
      params: msg.params,
    });

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  } catch {
    sendJsonRpcError(ws, -32603, 'Internal error processing mail method', msg.id);
  }
}

// ============================================================================
// Heartbeat
// ============================================================================

function startMapHeartbeat(): void {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    const timeout = HEARTBEAT_INTERVAL * 2;

    for (const [swarmId, conn] of getAllInbound()) {
      const lastMsg = new Date(conn.lastMessageAt).getTime();
      if (now - lastMsg > timeout) {
        // Client hasn't sent anything — terminate
        conn.ws.terminate();
        unregisterInbound(swarmId);
      } else if (conn.ws.readyState === WebSocket.OPEN) {
        sendJsonRpc(conn.ws, 'ping', {});
      }
    }
  }, HEARTBEAT_INTERVAL);
}

// ============================================================================
// Lifecycle
// ============================================================================

export function stopMapWebSocket(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // Close all inbound connections
  for (const [swarmId, conn] of getAllInbound()) {
    try { conn.ws.close(); } catch { /* ignore */ }
    unregisterInbound(swarmId);
  }

  console.log('[ws-map] MAP WebSocket stopped');
}
