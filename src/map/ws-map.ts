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
} from '../db/dal/map.js';
import { hasOutboundConnection } from './sync-listener.js';
import { registerInbound, unregisterInbound, getAllInbound } from './connection-registry.js';
import { getInboxStorage } from './inbox-bridge.js';
import { cleanupSubscriptions } from './event-subscriptions.js';
import { dispatchMapMessage } from './message-dispatch.js';
import type { ReplyFunctions } from './message-dispatch.js';
import type { Agent } from '../types.js';
import { flushAllQueues } from './mesh-channels.js';

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

    const reply: ReplyFunctions = {
      sendNotification: (method, params) => sendJsonRpc(ws, method, params),
      sendError: (code, message, id) => sendJsonRpcError(ws, code, message, id),
      sendResult: (id, result) => sendJsonRpcResult(ws, id, result),
    };

    await dispatchMapMessage(parsed, swarmId, reply, ws);

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
      transport: { type: 'websocket', ws },
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

    // Flush any queued channel messages for this swarm
    flushAllQueues(swarmId);

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
        if (conn.transport.type === 'websocket') {
          conn.transport.ws.terminate();
        }
        unregisterInbound(swarmId);
      } else if (conn.transport.type === 'websocket' && conn.transport.ws.readyState === WebSocket.OPEN) {
        sendJsonRpc(conn.transport.ws, 'ping', {});
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
    if (conn.transport.type === 'websocket') {
      try { conn.transport.ws.close(); } catch { /* ignore */ }
    }
    unregisterInbound(swarmId);
  }

  console.log('[ws-map] MAP WebSocket stopped');
}
