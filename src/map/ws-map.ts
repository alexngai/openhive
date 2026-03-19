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
import { MAP_TASK_METHOD_SET } from './task-types.js';
import { handleTaskRequest, MAPTaskRequestError, storeErrorToJsonRpc } from './task-handler.js';
import { getMapTaskStore, MAPTaskStoreError } from './task-store.js';
import { initTaskBroadcaster, stopTaskBroadcaster } from './task-broadcaster.js';
import { MAP_OPENTASKS_METHOD_SET } from './opentasks-types.js';
import { handleOpenTasksRequest, OpenTasksRequestError } from './opentasks-handler.js';
import { getMailJsonRpc } from '../mail/index.js';
import { verifyToken } from './token-service.js';
import { nanoid } from 'nanoid';
import type { Agent } from '../types.js';
import type { Config } from '../config.js';

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

/**
 * Resolve or create a swarm for an open-mode connection.
 *
 * - swarm_id provided + exists + owned by agent → reconnect
 * - swarm_id provided + doesn't exist → create with that ID
 * - no swarm_id → create with generated ID
 */
function resolveSwarmOpen(agentId: string, agentName: string, swarmIdHint?: string): { swarmId: string; created: boolean } {
  if (swarmIdHint) {
    // Check if this swarm already exists and is owned by the agent
    const { data: swarms } = listSwarms({ owner_agent_id: agentId, limit: 100 });
    const match = swarms.find((s) => s.id === swarmIdHint);
    if (match) return { swarmId: match.id, created: false };

    // Create with the requested ID
    const swarm = createSwarm(agentId, {
      id: swarmIdHint,
      name: `${agentName}-hub`,
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
    });
    return { swarmId: swarm.id, created: true };
  }

  // No swarm_id — create with generated ID
  const swarm = createSwarm(agentId, {
    name: `${agentName}-hub`,
    map_endpoint: 'hub-inbound',
    map_transport: 'websocket',
    auth_method: 'none',
  });
  return { swarmId: swarm.id, created: true };
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

function sendJsonRpcResponse(ws: WebSocket, id: string | number, result: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result,
    }));
  }
}

/** Type guard: is this a JSON-RPC request (has id + method)? */
function isJsonRpcRequest(data: Record<string, unknown>): boolean {
  return data.jsonrpc === '2.0' && typeof data.method === 'string' && data.id != null;
}

// ============================================================================
// WebSocket Handler
// ============================================================================

export function setupMapWebSocket(fastify: FastifyInstance, config: Config): void {
  fastify.get('/ws/map', { websocket: true }, async (socket, request) => {
    // Read trust model on each connection so runtime config changes take effect
    const trustModel = config.mapHub.trustModel;
    const ws = socket as unknown as WebSocket;
    const query = request.query as { token?: string; swarm_id?: string };

    // ── Hub access auth (both modes) ──────────────────────────────────
    // API key via query param gates WebSocket access regardless of trust model.
    if (!query.token) {
      sendJsonRpcError(ws, -32000, 'Missing token query parameter');
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Buffer messages that arrive during async auth (bcrypt can be slow).
    // This prevents a race where the client sends map/connect before we
    // register the ws.once('message') listener.
    const bufferedMessages: Buffer[] = [];
    const bufferHandler = (data: Buffer) => { bufferedMessages.push(data); };
    ws.on('message', bufferHandler);

    const agent = await authenticateToken(query.token);

    // Stop buffering — handlers below will take over
    ws.removeListener('message', bufferHandler);

    if (!agent) {
      sendJsonRpcError(ws, -32000, 'Invalid authentication token');
      ws.close(4001, 'Unauthorized');
      return;
    }

    if (trustModel === 'verified') {
      // Verified mode: hub access granted, now wait for map/connect for swarm identity.
      setupVerifiedConnection(ws, agent, bufferedMessages);
      return;
    }

    // ── Open mode: swarm identity via query params ────────────────────
    const { swarmId, created } = resolveSwarmOpen(agent.id, agent.name, query.swarm_id);
    if (created) {
      console.log(`[ws-map] Auto-registered hub-inbound swarm ${swarmId} for agent ${agent.name}`);
    }

    const now = new Date().toISOString();
    registerInbound(swarmId, {
      ws,
      agentId: agent.id,
      swarmId,
      connectedAt: now,
      lastMessageAt: now,
      registeredAgents: new Map(),
    });

    heartbeatSwarm(swarmId);

    sendJsonRpc(ws, 'hub/welcome', {
      swarm_id: swarmId,
      agent_id: agent.id,
      agent_name: agent.name,
    });

    console.log(`[ws-map] Swarm ${swarmId} connected inbound (agent: ${agent.name})`);
    setupMessageHandlers(ws, swarmId, agent.id);
  });

  // Start heartbeat and task broadcaster
  startMapHeartbeat();
  initTaskBroadcaster(getMapTaskStore());

  console.log(`[openhive] MAP WebSocket registered at /ws/map (trust: ${config.mapHub.trustModel})`);
}

// ============================================================================
// Verified Mode — MAP spec server-driven auth negotiation
//
// Two layers:
//   1. Hub access: API key via ?token= query param (already validated above)
//   2. Swarm identity: map/connect → authRequired → map/authenticate (agent-iam)
// ============================================================================

function setupVerifiedConnection(ws: WebSocket, agent: Agent, bufferedMessages: Buffer[] = []): void {
  const AUTH_TIMEOUT = 10_000;

  const timeout = setTimeout(() => {
    sendJsonRpcError(ws, -32000, 'Authentication timeout — send map/connect within 10s');
    ws.close(4001, 'Auth timeout');
  }, AUTH_TIMEOUT);

  /** Handle the map/connect message (step 1). */
  function handleConnect(data: Buffer | string): void {
    clearTimeout(timeout);
    try {
      const parsed = JSON.parse(data.toString());

      if (parsed.method !== 'map/connect') {
        sendJsonRpcError(ws, -32600, 'Expected map/connect as first message', parsed.id);
        ws.close(4002, 'Expected map/connect');
        return;
      }

      const connectParams = parsed.params || {};

      // Respond with authRequired — server drives the method selection
      sendJsonRpcResponse(ws, parsed.id, {
        protocolVersion: 1,
        authRequired: {
          methods: ['x-agent-iam'],
          required: true,
        },
      });

      // Wait for map/authenticate
      const authTimeout = setTimeout(() => {
        sendJsonRpcError(ws, -32000, 'Authentication timeout — send map/authenticate');
        ws.close(4001, 'Auth timeout');
      }, AUTH_TIMEOUT);

      ws.once('message', (authData: Buffer | string) => handleAuthenticate(authData, authTimeout, connectParams));
      ws.once('close', () => clearTimeout(authTimeout));
    } catch {
      sendJsonRpcError(ws, -32700, 'Parse error');
      ws.close(4000, 'Parse error');
    }
  }

  /** Handle the map/authenticate message (step 2). */
  function handleAuthenticate(data: Buffer | string, authTimeout: NodeJS.Timeout, connectParams: Record<string, unknown>): void {
    clearTimeout(authTimeout);
    try {
      const authMsg = JSON.parse(data.toString());
      if (authMsg.method !== 'map/authenticate') {
        sendJsonRpcError(ws, -32600, 'Expected map/authenticate', authMsg.id);
        ws.close(4002, 'Expected map/authenticate');
        return;
      }

      const authParams = authMsg.params || {};
      const method = (authParams.method as string) || '';
      const credential = (authParams.credential || authParams.token || '') as string;

      if (method !== 'x-agent-iam') {
        sendJsonRpcError(ws, 1003, `Unsupported auth method: ${method}. Use x-agent-iam.`, authMsg.id);
        ws.close(4001, 'Unsupported method');
        return;
      }

      // Verify agent-iam token
      const result = verifyToken(credential);
      if (!result.valid || !result.token) {
        sendJsonRpcError(ws, 1001, `Authentication failed: ${result.error}`, authMsg.id);
        ws.close(4001, 'Auth failed');
        return;
      }

      const token = result.token;
      const swarmId = token.agentId;

      // Find or create swarm record keyed by token agentId
      const { data: existing } = listSwarms({ owner_agent_id: agent.id, limit: 100 });
      if (!existing.find((s) => s.id === swarmId)) {
        createSwarm(agent.id, {
          id: swarmId,
          name: (connectParams.name as string) || `${swarmId}-hub`,
          map_endpoint: 'hub-inbound',
          map_transport: 'websocket',
          auth_method: 'none',
        });
        console.log(`[ws-map] Auto-registered verified swarm ${swarmId}`);
      }

      // Complete connection
      const now = new Date().toISOString();
      registerInbound(swarmId, {
        ws, agentId: agent.id, swarmId, connectedAt: now, lastMessageAt: now,
        tokenExpiresAt: token.expiresAt || undefined,
        registeredAgents: new Map(),
      });
      heartbeatSwarm(swarmId);

      sendJsonRpcResponse(ws, authMsg.id, {
        success: true,
        sessionId: `session_${nanoid(12)}`,
        participantId: swarmId,
        principal: {
          id: token.agentId,
          claims: {
            scopes: token.scopes,
            delegationDepth: token.currentDepth,
          },
        },
      });

      console.log(`[ws-map] Swarm ${swarmId} connected via verified auth (scopes: ${token.scopes.join(', ')})`);
      setupMessageHandlers(ws, swarmId, agent.id);
    } catch {
      sendJsonRpcError(ws, -32700, 'Parse error');
      ws.close(4000, 'Parse error');
    }
  }

  // If there's a buffered message from during auth, replay it immediately
  if (bufferedMessages.length > 0) {
    handleConnect(bufferedMessages[0]);
  } else {
    ws.once('message', handleConnect);
  }

  ws.once('close', () => clearTimeout(timeout));
}

// ============================================================================
// Message Handlers (shared between open and verified modes)
// ============================================================================

function setupMessageHandlers(ws: WebSocket, swarmId: string, agentId: string): void {
  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString());

      if (isJsonRpcRequest(parsed) && MAP_TASK_METHOD_SET.has(parsed.method as string)) {
        // MAP task request (needs a response)
        try {
          const result = handleTaskRequest(
            parsed.method as string,
            parsed.params,
            { swarmId, agentId },
            getMapTaskStore(),
          );
          sendJsonRpcResponse(ws, parsed.id as string | number, result);
        } catch (err) {
          if (err instanceof MAPTaskRequestError) {
            sendJsonRpcError(ws, err.code, err.message, parsed.id as string | number);
          } else if (err instanceof MAPTaskStoreError) {
            const rpcErr = storeErrorToJsonRpc(err);
            sendJsonRpcError(ws, rpcErr.code, rpcErr.message, parsed.id as string | number);
          } else {
            sendJsonRpcError(ws, -32603, 'Internal error', parsed.id as string | number);
          }
        }
      } else if (isJsonRpcRequest(parsed) && MAP_OPENTASKS_METHOD_SET.has(parsed.method as string)) {
        // MAP OpenTasks request (async — proxies to local OpenTasks daemon)
        handleOpenTasksRequest(
          parsed.method as string,
          parsed.params,
          { swarmId, agentId },
        ).then((result) => {
          sendJsonRpcResponse(ws, parsed.id as string | number, result);
        }).catch((err) => {
          if (err instanceof OpenTasksRequestError) {
            sendJsonRpcError(ws, err.code, err.message, parsed.id as string | number);
          } else {
            sendJsonRpcError(ws, -32603, 'Internal error', parsed.id as string | number);
          }
        });
      } else if (isJsonRpcRequest(parsed) && (parsed.method as string).startsWith('mail/')) {
        // MAP mail protocol — delegate to embedded agent-inbox
        getMailJsonRpc().handleRequest(parsed as any).then((mailResult: any) => {
          if (mailResult.error) {
            sendJsonRpcError(ws, mailResult.error.code, mailResult.error.message, parsed.id as string | number);
          } else {
            sendJsonRpcResponse(ws, parsed.id as string | number, mailResult.result);
          }
        }).catch(() => {
          sendJsonRpcError(ws, -32603, 'Internal mail error', parsed.id as string | number);
        });
      } else if (isMapSyncMessage(parsed)) {
        handleSyncMessage(parsed, swarmId);
      } else if (isCoordinationMessage(parsed)) {
        handleCoordinationMessage(parsed, swarmId);
      } else if (parsed.method === 'ping') {
        sendJsonRpc(ws, 'pong', {});
      } else if (isJsonRpcRequest(parsed) && parsed.method === 'map/disconnect') {
        // Graceful disconnect — acknowledge and close with a small delay
        // so the response flushes before the connection drops
        sendJsonRpcResponse(ws, parsed.id as string | number, { success: true });
        setTimeout(() => {
          try { ws.close(1000, 'Disconnected'); } catch { /* already closed */ }
        }, 50);
      } else if (isJsonRpcRequest(parsed) && parsed.method === 'map/agents/register') {
        // Agent registration — store in connection registry and update swarm agent_count
        const regParams = (parsed.params || {}) as Record<string, unknown>;
        const registeredId = (regParams.agentId as string) || swarmId;
        const registeredAgent = {
          id: registeredId,
          name: (regParams.name as string) || swarmId,
          role: (regParams.role as string) || 'agent',
          state: 'active',
          scopes: (regParams.scopes as string[]) || [],
        };

        const conn = getAllInbound().get(swarmId);
        if (conn) {
          conn.registeredAgents.set(registeredId, registeredAgent);
          try { updateSwarm(swarmId, { agent_count: conn.registeredAgents.size }); } catch { /* ignore */ }
        }

        sendJsonRpcResponse(ws, parsed.id as string | number, {
          agent: registeredAgent,
        });
      } else if (isJsonRpcRequest(parsed) && parsed.method === 'map/agents/unregister') {
        // Agent unregistration — remove from connection registry
        const unregParams = (parsed.params || {}) as Record<string, unknown>;
        const unregId = (unregParams.agentId as string) || '';
        const conn = getAllInbound().get(swarmId);
        if (conn && unregId) {
          conn.registeredAgents.delete(unregId);
          try { updateSwarm(swarmId, { agent_count: conn.registeredAgents.size }); } catch { /* ignore */ }
        }
        sendJsonRpcResponse(ws, parsed.id as string | number, { success: true });
      } else if (isJsonRpcRequest(parsed) && parsed.method === 'map/agents/update') {
        // Agent state update — update in connection registry
        const updateParams = (parsed.params || {}) as Record<string, unknown>;
        const updateId = (updateParams.agentId as string) || '';
        const conn = getAllInbound().get(swarmId);
        if (conn && updateId) {
          const existing = conn.registeredAgents.get(updateId);
          if (existing) {
            if (updateParams.state) existing.state = updateParams.state as string;
            if (updateParams.name) existing.name = updateParams.name as string;
            if (updateParams.role) existing.role = updateParams.role as string;
            sendJsonRpcResponse(ws, parsed.id as string | number, { agent: existing });
          } else {
            sendJsonRpcError(ws, -32602, `Agent ${updateId} not registered`, parsed.id as string | number);
          }
        } else {
          sendJsonRpcError(ws, -32602, 'Agent not found', parsed.id as string | number);
        }
      } else if (isJsonRpcRequest(parsed) && parsed.method === 'map/authenticate') {
        // Token refresh — re-authenticate mid-session (verified mode)
        const authParams = (parsed.params || {}) as Record<string, unknown>;
        const credential = (authParams.credential || authParams.token || '') as string;
        const result = verifyToken(credential);
        if (result.valid && result.token) {
          const conn = getAllInbound().get(swarmId);
          if (conn) {
            conn.tokenExpiresAt = result.token.expiresAt || undefined;
            conn.expiryNotified = false;
          }
          sendJsonRpcResponse(ws, parsed.id as string | number, {
            success: true,
            principal: {
              id: result.token.agentId,
              claims: { scopes: result.token.scopes },
            },
          });
        } else {
          sendJsonRpcError(ws, 1001, `Token refresh failed: ${result.error}`, parsed.id as string | number);
        }
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
  });

  // Handle close
  ws.on('close', () => {
    unregisterInbound(swarmId);

    // Clean up MAP tasks owned by this swarm
    try { getMapTaskStore().removeBySwarm(swarmId); } catch { /* DB may be closed during shutdown */ }

    console.log(`[ws-map] Swarm ${swarmId} disconnected`);

    // Mark swarm offline if no outbound connection exists either
    try {
      if (!hasOutboundConnection(swarmId)) {
        updateSwarm(swarmId, { status: 'offline' });
      }
    } catch { /* DB may be closed during shutdown */ }
  });

  // Handle errors
  ws.on('error', (err) => {
    console.warn(`[ws-map] WebSocket error for swarm ${swarmId}: ${err.message}`);
  });
}

// ============================================================================
// Heartbeat
// ============================================================================

const TOKEN_EXPIRY_WARNING_SECONDS = 300; // Notify 5 min before expiry

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
        continue;
      }

      if (conn.ws.readyState !== WebSocket.OPEN) continue;

      // Ping
      sendJsonRpc(conn.ws, 'ping', {});

      // Token expiry check (verified mode connections)
      if (conn.tokenExpiresAt && !conn.expiryNotified) {
        const expiresAt = new Date(conn.tokenExpiresAt).getTime();
        const secondsLeft = Math.floor((expiresAt - now) / 1000);

        if (secondsLeft <= TOKEN_EXPIRY_WARNING_SECONDS) {
          sendJsonRpc(conn.ws, 'map/auth.expiring', {
            expiresIn: Math.max(0, secondsLeft),
            reason: 'token_expiring',
          });
          conn.expiryNotified = true;
        }
      }
    }
  }, HEARTBEAT_INTERVAL);
}

// ============================================================================
// Lifecycle
// ============================================================================

export function stopMapWebSocket(): void {
  stopTaskBroadcaster();

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
