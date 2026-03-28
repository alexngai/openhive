/**
 * MAP Inbound WebSocket Endpoint (/ws/map)
 *
 * Routes inbound MAP agent connections through the SDK's MAPServer for standard
 * protocol methods (connect, authenticate, agents/*, send, subscribe, disconnect)
 * while intercepting OpenHive-specific notifications (sync, coordination) at the
 * WebSocket level before they reach the MAPServer's stream.
 *
 * Two layers of auth:
 *   1. Hub access: API key via ?token= query param (both modes)
 *   2. Swarm identity:
 *      - Open mode: ?swarm_id= query param → immediate welcome + MAPServer session
 *      - Verified mode: MAPServer handles map/connect → authRequired → map/authenticate
 */

import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { websocketStream } from '@multi-agent-protocol/sdk';
import { findAgentById, findAgentByApiKey, findOrCreateSwarmHubAgent, getOrCreateLocalAgent } from '../db/dal/agents.js';
import { validateIngestKey } from '../db/dal/ingest-keys.js';
import { validateSwarmHubToken, isJwksInitialized } from '../auth/jwks.js';
import { listSwarms, createSwarm, heartbeatSwarm, updateSwarm } from '../db/dal/map.js';
import { handleSyncMessage, hasOutboundConnection } from './sync-listener.js';
import { isMapSyncMessage } from './sync-listener.js';
import { isCoordinationMessage, handleCoordinationMessage } from '../coordination/listener.js';
import { registerInbound, unregisterInbound, getAllInbound, getInbound, setDefaultTaskGraph } from './connection-registry.js';
import { getMapTaskStore } from './task-store.js';
import { handleContentResponse } from './trajectory-content.js';
import { initTaskBroadcaster, stopTaskBroadcaster } from './task-broadcaster.js';
import { initTaskBridge, stopTaskBridge } from './task-bridge.js';
import { getMailJsonRpc } from '../mail/index.js';
import { initMapServer, _resetMapServer } from './map-server-setup.js';
import { broadcastToChannel } from '../realtime/index.js';
import type { Agent } from '../types.js';
import type { Config } from '../config.js';

let HEARTBEAT_INTERVAL = 30_000;
const TOKEN_EXPIRY_WARNING_SECONDS = 300;
let heartbeatTimer: NodeJS.Timeout | null = null;

/** Override heartbeat interval (ms). Useful for testing with shorter timeouts. */
export function setHeartbeatInterval(ms: number): void {
  HEARTBEAT_INTERVAL = ms;
}

// ============================================================================
// Auth (hub access — validates API key before MAPServer sees the connection)
// ============================================================================

async function authenticateToken(token: string): Promise<Agent | null> {
  if (token.startsWith('ohk_')) {
    const ingestKey = validateIngestKey(token);
    if (ingestKey) return findAgentById(ingestKey.agent_id) ?? null;
    return null;
  }

  const agent = await findAgentByApiKey(token);
  if (agent) return agent;

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
// Swarm Resolution (open mode)
// ============================================================================

function resolveSwarmOpen(agentId: string, agentName: string, swarmIdHint?: string): { swarmId: string; created: boolean } {
  if (swarmIdHint) {
    const { data: swarms } = listSwarms({ owner_agent_id: agentId, limit: 100 });
    const match = swarms.find((s) => s.id === swarmIdHint);
    if (match) return { swarmId: match.id, created: false };

    const swarm = createSwarm(agentId, {
      id: swarmIdHint,
      name: `${agentName}-hub`,
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
    });
    return { swarmId: swarm.id, created: true };
  }

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
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }));
  }
}


// ============================================================================
// Notification Interceptor
//
// Sync and coordination messages are JSON-RPC notifications (no `id`).
// The MAPServer's router only processes requests. We intercept notifications
// at the WebSocket level and handle them directly, forwarding everything else
// to the MAPServer via the stream.
// ============================================================================

/**
 * Create a WebSocket message interceptor that handles OpenHive-specific
 * notifications (sync, coordination, mail notifications) and forwards
 * everything else to the MAPServer stream.
 *
 * Returns a modified WebSocket-like object that the MAPServer sees
 * (with notifications pre-filtered out).
 */
function createNotificationInterceptor(
  ws: WebSocket,
  swarmId: string,
): { cleanup: () => void } {
  const handler = (data: Buffer | string) => {
    try {
      const msg = JSON.parse(data.toString());

      // Only intercept notifications (no `id` field) that are OpenHive-specific
      if (msg.id != null) return; // Let requests pass through to MAPServer

      if (isMapSyncMessage(msg)) {
        handleSyncMessage(msg, swarmId);
      } else if (isCoordinationMessage(msg)) {
        handleCoordinationMessage(msg, swarmId);
      } else if (msg.method === 'ping') {
        sendJsonRpc(ws, 'pong', {});
      } else if (msg.method === 'trajectory/content.response') {
        // Content response from swarm — resolve pending content request
        handleContentResponse(msg.params as Record<string, unknown>);
      } else if (typeof msg.method === 'string' && msg.method.startsWith('mail/')) {
        // Mail notifications — fire and forget
        try { getMailJsonRpc().handleRequest(msg as any); } catch { /* ignore */ }
      }
      // Other notifications pass through to MAPServer (it will ignore unknown ones)

      // Update heartbeat on any message
      const conn = getAllInbound().get(swarmId);
      if (conn) {
        conn.lastMessageAt = new Date().toISOString();
      }
      heartbeatSwarm(swarmId);
    } catch {
      // Non-JSON — ignore
    }
  };

  ws.on('message', handler);
  return { cleanup: () => ws.removeListener('message', handler) };
}

// ============================================================================
// WebSocket Handler
// ============================================================================

export function setupMapWebSocket(fastify: FastifyInstance, config: Config): void {
  const mapServer = initMapServer(config);

  fastify.get('/ws/map', { websocket: true }, async (socket, request) => {
    const trustModel = config.mapHub.trustModel;
    const ws = socket as unknown as WebSocket;
    const query = request.query as { token?: string; swarm_id?: string };

    // Track liveness for heartbeat ping/pong
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });

    // Track swarm ID for cleanup on raw socket close
    let connectedSwarmId: string | null = null;
    let cleanedUp = false;

    const handleDisconnect = () => {
      if (cleanedUp || !connectedSwarmId) return;
      cleanedUp = true;
      const sid = connectedSwarmId;

      // Only clean up if this WS is still the current connection for this swarm.
      // A newer connection may have already replaced us via registerInbound.
      const current = getInbound(sid);
      if (current && current.ws !== ws) return;

      unregisterInbound(sid);
      try {
        if (!hasOutboundConnection(sid)) {
          updateSwarm(sid, { status: 'unreachable' });
          broadcastToChannel('map:discovery', {
            type: 'swarm_offline',
            data: { swarm_id: sid },
          });
        }
      } catch { /* */ }
      console.log(`[ws-map] Swarm ${sid} disconnected`);
    };

    ws.on('close', handleDisconnect);

    // ── Hub access auth (both modes) ──────────────────────────────────
    // Buffer messages during async auth
    const bufferedMessages: (Buffer | string)[] = [];
    const bufferHandler = (data: Buffer) => { bufferedMessages.push(data); };
    ws.on('message', bufferHandler);

    let agent: Agent | null = null;
    if (query.token) {
      agent = await authenticateToken(query.token);
    }

    // Local mode fallback: no token → use the local agent (same as HTTP auth middleware)
    if (!agent && config.auth.mode === 'local') {
      agent = await getOrCreateLocalAgent();
    }

    ws.removeListener('message', bufferHandler);

    if (!agent) {
      sendJsonRpcError(ws, -32000, 'Missing or invalid authentication token');
      ws.close(4001, 'Unauthorized');
      return;
    }

    if (trustModel === 'verified') {
      // ── Verified mode ────────────────────────────────────────────────
      // MAPServer handles the full map/connect → authRequired → authenticate flow.
      // We create the stream and let the MAPServer process everything.
      // The swarmId will be determined after auth (from the token's agentId).
      //
      // We don't know the swarmId yet, so we use a placeholder and update
      // the registry after auth completes (via MAPServer event hooks).

      const stream = websocketStream(ws as unknown as globalThis.WebSocket);
      const router = mapServer.accept(stream, {
        role: 'agent',
        transportType: 'websocket',
        metadata: { hubAgentId: agent.id, hubAgentName: agent.name },
      });

      // Replay buffered messages into the stream
      for (const msg of bufferedMessages) {
        ws.emit('message', msg);
      }

      router.start();

      // Track the connection once the agent registers
      // The MAPServer emits agent.registered when map/agents/register succeeds
      const onRegistered = (event: any) => {
        // Event data shape: { agent: { id, name, sessionId, ... } }
        const registeredAgent = event.data?.agent ?? event.data;
        if (!registeredAgent?.sessionId) return;

        // Check if this event is for our session
        try {
          const session = router.session;
          if (!session || session.id !== registeredAgent.sessionId) return;
        } catch {
          return;
        }

        const swarmId = registeredAgent.id;
        const now = new Date().toISOString();

        // Resolve/create swarm record
        const { data: existing } = listSwarms({ owner_agent_id: agent.id, limit: 100 });
        if (!existing.find((s) => s.id === swarmId)) {
          createSwarm(agent.id, {
            id: swarmId,
            name: registeredAgent.name || `${swarmId}-hub`,
            map_endpoint: 'hub-inbound',
            map_transport: 'websocket',
            auth_method: 'none',
          });
          console.log(`[ws-map] Auto-registered verified swarm ${swarmId}`);
        }

        connectedSwarmId = swarmId;
        registerInbound(swarmId, {
          ws, agentId: agent.id, swarmId,
          connectedAt: now, lastMessageAt: now,
          tokenExpiresAt: router.session?.principal?.expiresAt
            ? new Date(router.session.principal.expiresAt).toISOString()
            : undefined,
          registeredAgents: new Map(),
        });
        heartbeatSwarm(swarmId);

        // Set up notification interceptor now that we know the swarmId
        const interceptor = createNotificationInterceptor(ws, swarmId);

        console.log(`[ws-map] Swarm ${swarmId} connected via MAPServer verified auth`);

        // Cleanup on close (router.closed as backup — ws 'close' is primary)
        router.closed.then(() => {
          interceptor.cleanup();
          handleDisconnect();
        });
      };

      const unsubRegistered = mapServer.eventBus.on('agent.registered', onRegistered);

      // If no agent registers within 30s, clean up
      const regTimeout = setTimeout(() => {
        unsubRegistered();
      }, 30_000);

      router.closed.then(() => {
        clearTimeout(regTimeout);
        unsubRegistered();
      });

      return;
    }

    // ── Open mode ────────────────────────────────────────────────────────
    const { swarmId, created } = resolveSwarmOpen(agent.id, agent.name, query.swarm_id);
    if (created) {
      console.log(`[ws-map] Auto-registered hub-inbound swarm ${swarmId} for agent ${agent.name}`);
    }

    connectedSwarmId = swarmId;
    const now = new Date().toISOString();
    registerInbound(swarmId, {
      ws, agentId: agent.id, swarmId,
      connectedAt: now, lastMessageAt: now,
      registeredAgents: new Map(),
    });
    heartbeatSwarm(swarmId);

    // Send hub/welcome (open mode clients expect this)
    sendJsonRpc(ws, 'hub/welcome', {
      swarm_id: swarmId,
      agent_id: agent.id,
      agent_name: agent.name,
    });

    // Set up notification interceptor for sync/coordination
    const interceptor = createNotificationInterceptor(ws, swarmId);

    // Route JSON-RPC requests through MAPServer
    const stream = websocketStream(ws as unknown as globalThis.WebSocket);
    const router = mapServer.accept(stream, {
      role: 'agent',
      transportType: 'websocket',
      metadata: { swarmId, hubAgentId: agent.id },
    });

    // Replay buffered messages
    for (const msg of bufferedMessages) {
      ws.emit('message', msg);
    }

    router.start();

    // Capture agent capabilities and metadata when the agent registers via MAP protocol
    const onAgentRegistered = (event: any) => {
      const registeredAgent = event.data?.agent ?? event.data;
      if (!registeredAgent) return;

      // In open mode, match by session ID if available, otherwise accept any registration
      // on our router (we know the swarmId is correct because this handler is scoped to it)
      try {
        const session = router.session;
        if (session?.id && registeredAgent.sessionId && session.id !== registeredAgent.sessionId) return;
      } catch {
        // router.session may not be available — continue anyway in open mode
      }

      const conn = getInbound(swarmId);
      if (conn) {
        if (registeredAgent.capabilities) {
          conn.capabilities = registeredAgent.capabilities;
        }
        // Track registered agent on this connection
        const agentEntry = {
          id: registeredAgent.id || registeredAgent.name || 'unknown',
          name: registeredAgent.name || 'unknown',
          role: registeredAgent.role || 'agent',
          state: 'registered',
          scopes: registeredAgent.scopes || [],
        };
        conn.registeredAgents.set(agentEntry.id, agentEntry);
      }

      // Enrich swarm record with agent metadata (project, branch, template)
      if (registeredAgent.metadata) {
        const meta = registeredAgent.metadata as Record<string, unknown>;
        const project = meta.project as string | undefined;
        const branch = meta.branch as string | undefined;
        if (project) {
          const displayName = branch ? `${project} (${branch})` : project;
          try {
            updateSwarm(swarmId, {
              name: displayName,
              capabilities: registeredAgent.capabilities || undefined,
              metadata: meta,
            });
          } catch { /* non-critical */ }
        }

        // Auto-detect default task graph from agent metadata
        const taskGraph = meta.task_graph as Record<string, string> | undefined;
        if (taskGraph) {
          setDefaultTaskGraph(swarmId, {
            resource_id: taskGraph.resource_id,
            path: taskGraph.path,
            location_hash: taskGraph.location_hash,
          });
        }
      }
    };
    const unsubRegistered = mapServer.eventBus.on('agent.registered', onAgentRegistered);

    console.log(`[ws-map] Swarm ${swarmId} connected inbound (agent: ${agent.name})`);

    // Cleanup on close (router.closed as backup — ws 'close' is primary)
    router.closed.then(() => {
      unsubRegistered();
      interceptor.cleanup();
      handleDisconnect();
    });
  });

  // Start heartbeat, task broadcaster, and bidirectional task bridge
  startMapHeartbeat();
  const taskStore = getMapTaskStore();
  initTaskBroadcaster(taskStore);
  initTaskBridge({ store: taskStore }).catch(err =>
    console.error('[task-bridge] Failed to initialize:', err),
  );

  console.log(`[openhive] MAP WebSocket registered at /ws/map (trust: ${config.mapHub.trustModel})`);
}

// ============================================================================
// Heartbeat
// ============================================================================

function startMapHeartbeat(): void {
  if (heartbeatTimer) return;

  heartbeatTimer = setInterval(() => {
    const now = Date.now();

    for (const [swarmId, conn] of getAllInbound()) {
      if ((conn.ws as any).isAlive === false) {
        // No pong received since last ping — connection is dead
        conn.ws.terminate();
        unregisterInbound(swarmId);
        try {
          if (!hasOutboundConnection(swarmId)) {
            updateSwarm(swarmId, { status: 'unreachable' });
            broadcastToChannel('map:discovery', {
              type: 'swarm_offline',
              data: { swarm_id: swarmId },
            });
          }
        } catch { /* */ }
        continue;
      }

      // Mark as not-alive; set back to true when pong arrives or a message is received
      (conn.ws as any).isAlive = false;

      if (conn.ws.readyState !== WebSocket.OPEN) continue;

      // Keep last_seen_at fresh so connected swarms stay "online"
      heartbeatSwarm(swarmId);

      // Protocol-level ping — the ws library responds with a pong frame
      // at the transport layer, so this works for ALL WebSocket clients
      // (including MAP SDK clients that have no application-level ping handling).
      conn.ws.ping();
      // Also send JSON-RPC ping for clients that use application-level keepalive
      sendJsonRpc(conn.ws, 'ping', {});

      // Token expiry check
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
  stopTaskBridge();
  stopTaskBroadcaster();

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  for (const [swarmId, conn] of getAllInbound()) {
    try { conn.ws.close(); } catch { /* ignore */ }
    unregisterInbound(swarmId);
  }

  _resetMapServer();

  console.log('[ws-map] MAP WebSocket stopped');
}
