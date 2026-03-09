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
import { listSwarms, createSwarm, heartbeatSwarm, updateSwarm } from '../db/dal/map.js';
import { handleSyncMessage, hasOutboundConnection } from './sync-listener.js';
import { isMapSyncMessage } from './sync-listener.js';
import { isCoordinationMessage, handleCoordinationMessage } from '../coordination/listener.js';
import { registerInbound, unregisterInbound, getAllInbound } from './connection-registry.js';
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

function sendJsonRpcError(ws: WebSocket, code: number, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code, message },
    }));
  }
}

// ============================================================================
// WebSocket Handler
// ============================================================================

export function setupMapWebSocket(fastify: FastifyInstance): void {
  fastify.get('/ws/map', { websocket: true }, async (socket, request) => {
    const ws = socket as unknown as WebSocket;
    const query = request.query as { token?: string; swarm_id?: string; auto_register?: string };

    // Authenticate
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

    // Resolve swarm
    let swarmId = resolveSwarm(agent.id, query.swarm_id);

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

    // Send welcome
    sendJsonRpc(ws, 'hub/welcome', {
      swarm_id: swarmId,
      agent_id: agent.id,
      agent_name: agent.name,
    });

    console.log(`[ws-map] Swarm ${swarmId} connected inbound (agent: ${agent.name})`);

    // Handle messages
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());

        if (isMapSyncMessage(parsed)) {
          handleSyncMessage(parsed, swarmId!);
        } else if (isCoordinationMessage(parsed)) {
          handleCoordinationMessage(parsed, swarmId!);
        } else if (parsed.method === 'ping') {
          sendJsonRpc(ws, 'pong', {});
        }
        // Unknown methods silently ignored (JSON-RPC 2.0 semantics)

        // Update heartbeat on any valid message
        const conn = getAllInbound().get(swarmId!);
        if (conn) {
          conn.lastMessageAt = new Date().toISOString();
        }
        heartbeatSwarm(swarmId!);
      } catch {
        // Ignore non-JSON messages
      }
    });

    // Handle close
    ws.on('close', () => {
      unregisterInbound(swarmId!);
      console.log(`[ws-map] Swarm ${swarmId} disconnected`);

      // Mark swarm offline if no outbound connection exists either
      if (!hasOutboundConnection(swarmId!)) {
        updateSwarm(swarmId!, { status: 'offline' });
      }
    });

    // Handle errors
    ws.on('error', (err) => {
      console.warn(`[ws-map] WebSocket error for swarm ${swarmId}: ${err.message}`);
    });
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
