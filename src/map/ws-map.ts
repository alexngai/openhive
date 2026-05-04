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
import { listSwarms, createSwarm, heartbeatSwarm, updateSwarm, updateNode, findNodeBySwarmAndAgentId, findSwarmById, bulkUpdateSwarmNodesPresence } from '../db/dal/map.js';
import { handleSyncMessage, hasOutboundConnection } from './sync-listener.js';
import { isMapSyncMessage } from './sync-listener.js';
import { isMapTaskEvent, handleMapTaskEvent, isMapContextEvent, handleMapContextEvent } from '../coordination/listener.js';
import { registerInbound, unregisterInbound, getAllInbound, getInbound, setDefaultTaskGraph, getAggregateCapabilities, getPeerMapId, getAgentOnSwarm } from './connection-registry.js';
import { resolveSessionScopes } from './session-scopes.js';
import { verifyToken, isTokenServiceInitialized } from './token-service.js';
import { handleContentResponse } from './trajectory-content.js';
import { handleTrajectoryRequest } from './trajectory-handler.js';
import { handleOpenTasksResponse } from './opentasks-remote.js';
import {
  handleNotificationPairResponse,
  rejectPendingForSwarm,
} from './notification-rpc.js';
import { handleWorkspaceResult } from '../learning/swarm-agent-backend.js';
import { getMailJsonRpc } from '../mail/index.js';
import { pushDispatchMapReply } from '../dispatch/mail-ingress.js';
import { initMapServer, _resetMapServer } from './map-server-setup.js';
import { broadcastToChannel } from '../realtime/index.js';
import { broadcastSwarmLifecycleEvent } from '../realtime/swarm-events.js';
import { mapHubEvents } from './service.js';
import type { Agent } from '../types.js';
import type { Config } from '../config.js';

// ============================================================================
// SwarmCraft graph projection filter
// ============================================================================

/**
 * Roles that should NOT appear as selectable nodes in the SwarmCraft agent
 * graph even though they're tracked on the MAP connection.
 *   - `sidecar` — plumbing / not a user-facing agent
 *   - `subagent` — short-lived spawned helpers (e.g. Claude's Explore tool);
 *     including them would churn the graph as they come and go per turn.
 * Other roles (orchestrator, coordinator, integrator, worker, agent, etc.)
 * are persisted and lifecycle-tracked by the SwarmCraft bridge.
 */
function isGraphHiddenRole(role: string | undefined): boolean {
  return role === 'sidecar' || role === 'subagent';
}

// ============================================================================
// Trajectory Checkpoint Bridge
// ============================================================================

function handleTrajectoryCheckpoint(
  params: Record<string, unknown>,
  swarmId: string,
  ws: WebSocket,
  requestId?: string | number | null,
): void {
  try {
    const conn = getInbound(swarmId);
    const agentId = conn?.agentId ?? swarmId;

    const result = handleTrajectoryRequest('trajectory/checkpoint', params, {
      swarmId,
      agentId,
    });
    console.log(`[ws-map] trajectory checkpoint processed: resource=${result?.resource_id} created=${result?.created}`);

    // Send JSON-RPC response if this was a request (has id)
    if (requestId != null) {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, result }));
    }
  } catch (err) {
    console.error(`[ws-map] trajectory checkpoint error:`, (err as Error).message);
    if (requestId != null) {
      const code = (err as any).code ?? -32603;
      const message = (err as Error).message ?? 'Internal error';
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: requestId, error: { code, message } }));
    }
  }
}

// ============================================================================
// Agent Registration Session Filter
//
// The MAPServer's eventBus is a singleton shared by every inbound connection,
// so a naive `on('agent.registered', ...)` handler fires for every swarm's
// registration, not just the current one. We filter strictly on session
// identity — reject unless both sides are known and equal. Missing ids (e.g.
// router.session throws before processing starts) reject rather than accept.
//
// Exported for unit testing only.
// ============================================================================

export function shouldAcceptAgentRegistration(
  event: unknown,
  mySessionId: string | undefined,
): boolean {
  if (!mySessionId) return false;
  if (!event || typeof event !== 'object') return false;

  const e = event as { source?: { sessionId?: string }; data?: { agent?: { sessionId?: string } } };
  const eventSessionId = e.source?.sessionId ?? e.data?.agent?.sessionId;
  if (!eventSessionId) return false;
  return eventSessionId === mySessionId;
}

let HEARTBEAT_INTERVAL = 30_000;
const TOKEN_EXPIRY_WARNING_SECONDS = 300;
let heartbeatTimer: NodeJS.Timeout | null = null;

// Connection persistence settings (overridden from config at setup time)
let MISSED_PONGS_BEFORE_TERMINATE = 3;
let HEARTBEAT_DEBOUNCE_MS = 10_000;

/** Override heartbeat interval (ms). Useful for testing with shorter timeouts. */
export function setHeartbeatInterval(ms: number): void {
  HEARTBEAT_INTERVAL = ms;
}

// ============================================================================
// Debounced Heartbeat
//
// Instead of writing to SQLite on every JSON-RPC message, we batch heartbeat
// writes per-swarm with a debounce timer. This reduces DB pressure under load
// while still keeping last_seen_at reasonably fresh.
// ============================================================================

const heartbeatDebounceTimers: Map<string, NodeJS.Timeout> = new Map();

/**
 * Schedule a debounced heartbeatSwarm() DB write.
 * Collapses multiple calls within HEARTBEAT_DEBOUNCE_MS into a single write.
 */
function debouncedHeartbeat(swarmId: string): void {
  if (heartbeatDebounceTimers.has(swarmId)) return;

  const timer = setTimeout(() => {
    heartbeatDebounceTimers.delete(swarmId);
    try { heartbeatSwarm(swarmId); } catch { /* swarm may have been deleted */ }
  }, HEARTBEAT_DEBOUNCE_MS);

  heartbeatDebounceTimers.set(swarmId, timer);
}

function clearHeartbeatDebounce(swarmId: string): void {
  const timer = heartbeatDebounceTimers.get(swarmId);
  if (timer) {
    clearTimeout(timer);
    heartbeatDebounceTimers.delete(swarmId);
  }
}

// ============================================================================
// Auth (hub access — validates API key before MAPServer sees the connection)
// ============================================================================

/**
 * Result of the outer WS-access auth gate.
 *
 * The MAP `?token=` may be an agent-iam delegated token — either minted
 * by the operator via `admin onboard-token` or by a parent swarm via
 * `map/agents/spawn`. When it is, we return the parsed claims so the
 * connect handler can use them as session scopes and track expiry
 * without re-verifying.
 */
interface AuthResult {
  agent: Agent;
  tokenScopes?: string[];
  /** ISO 8601 string per agent-iam's `AgentToken.expiresAt`. */
  tokenExpiresAt?: string;
  tokenDelegatable?: boolean;
  tokenSerialized?: string;
}

async function authenticateToken(token: string): Promise<AuthResult | null> {
  if (token.startsWith('ohk_')) {
    const ingestKey = validateIngestKey(token);
    if (ingestKey) {
      const agent = findAgentById(ingestKey.agent_id);
      return agent ? { agent } : null;
    }
    return null;
  }

  const apiKeyAgent = await findAgentByApiKey(token);
  if (apiKeyAgent) return { agent: apiKeyAgent };

  // Agent-iam delegated tokens — minted by `admin onboard-token` or
  // `map/agents/spawn`. The REST middleware already honors these; the
  // WS gate was missing the same check before v4 delegation landed.
  if (isTokenServiceInitialized()) {
    const verified = verifyToken(token);
    if (verified.valid && verified.token) {
      const agent = findAgentById(verified.token.agentId);
      if (agent) {
        return {
          agent,
          tokenScopes: verified.token.scopes,
          tokenExpiresAt: verified.token.expiresAt,
          tokenDelegatable: verified.token.delegatable,
          tokenSerialized: token,
        };
      }
    }
  }

  if (isJwksInitialized()) {
    const payload = await validateSwarmHubToken(token);
    if (payload?.sub) {
      const agent = await findOrCreateSwarmHubAgent({
        swarmhubUserId: payload.sub,
        name: payload.name,
        email: payload.email,
        avatarUrl: payload.avatar_url,
      });
      return agent ? { agent } : null;
    }
  }

  return null;
}

// ============================================================================
// Swarm Resolution (open mode)
// ============================================================================

function resolveSwarmOpen(agentId: string, agentName: string, swarmIdHint?: string): { swarmId: string; created: boolean } {
  if (swarmIdHint) {
    // First try direct lookup by ID (covers pre-registered swarms owned by different agents)
    const directMatch = findSwarmById(swarmIdHint);
    if (directMatch) return { swarmId: directMatch.id, created: false };

    // Fall back to owner-scoped search
    const { data: swarms } = listSwarms({ owner_agent_id: agentId, limit: 100 });
    const match = swarms.find((s) => s.id === swarmIdHint);
    if (match) return { swarmId: match.id, created: false };

    // Use the swarm_id hint as a short label when it looks like a session ID
    const shortId = swarmIdHint.length > 12 ? swarmIdHint.slice(0, 8) : swarmIdHint;
    const swarm = createSwarm(agentId, {
      id: swarmIdHint,
      name: `session ${shortId}`,
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


      // Handle trajectory/checkpoint requests before they reach the MAPServer.
      // These are JSON-RPC requests (have id) sent by the sidecar's callExtension.
      if (msg.method === 'trajectory/checkpoint' && msg.id != null) {
        console.log(`[ws-map] trajectory/checkpoint from ${swarmId}, id=${msg.id}`);
        handleTrajectoryCheckpoint(msg.params as Record<string, unknown>, swarmId, ws, msg.id);
        // Note: MAPServer will also see this message (we can't prevent it from
        // the on('message') handler), but it will return an "unknown method" error
        // which the sidecar ignores since it already got our success response first.
      }

      // Only intercept notifications (no `id` field) that are OpenHive-specific
      if (msg.id != null) return; // Let requests pass through to MAPServer

      if (isMapSyncMessage(msg)) {
        handleSyncMessage(msg, swarmId);
      } else if (isMapTaskEvent(msg)) {
        handleMapTaskEvent(msg.payload as Record<string, unknown>, swarmId);
      } else if (isMapContextEvent(msg)) {
        const conn = getInbound(swarmId);
        handleMapContextEvent(
          msg.payload as Record<string, unknown>,
          swarmId,
          conn?.agentId ?? swarmId,
        );
      } else if (msg.method === 'ping') {
        sendJsonRpc(ws, 'pong', {});
      } else if (msg.method === 'trajectory/content.response') {
        // Content response from swarm — resolve pending content request
        handleContentResponse(msg.params as Record<string, unknown>);
      } else if (msg.method === 'x-workspace/task.result' || msg.method === 'x-openhive/learning.workspace.result') {
        // Workspace execution result from swarm — resolve pending task
        handleWorkspaceResult(msg.params as Record<string, unknown>);
      } else if (typeof msg.method === 'string' && msg.method.startsWith('opentasks/') && msg.method.endsWith('.response')) {
        // OpenTasks response from swarm — resolve pending remote query
        handleOpenTasksResponse(msg.params as Record<string, unknown>);
      } else if (
        typeof msg.method === 'string' &&
        msg.method === 'dispatch/spawn-agent.response'
      ) {
        // Response side of the notification-pair RPC used for hub→swarm
        // request/response on `dispatch/spawn-agent`. AgentConnection
        // doesn't expose setRequestHandler, so we simulate request/response
        // over notifications. See src/map/notification-rpc.ts.
        handleNotificationPairResponse(msg.params);
      } else if (typeof msg.method === 'string' && msg.method.startsWith('mail/')) {
        // Mail notifications — fire and forget
        try { getMailJsonRpc().handleRequest(msg as any); } catch { /* ignore */ }
      } else if (msg.method === 'map/dispatch/reply') {
        // Dispatch reply from agent — fan out to the mail-transport listeners.
        // Verify from_agent_id is actually registered on the inbound swarm so a
        // compromised sidecar can't spoof replies on behalf of another agent.
        // Cross-swarm spoofing is already blocked — swarmId comes from the
        // authenticated connection, not the payload.
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const fromAgentId = typeof params.from_agent_id === 'string' ? params.from_agent_id : '';
        const envelope = (params.envelope ?? params.message) as Record<string, unknown> | undefined;
        if (fromAgentId && envelope && typeof envelope === 'object' && getAgentOnSwarm(swarmId, fromAgentId)) {
          pushDispatchMapReply({ swarmId, fromAgentId, message: envelope });
        }
      }
      // Other notifications pass through to MAPServer (it will ignore unknown ones)

      // Update heartbeat on any message (debounced to reduce DB writes)
      const conn = getAllInbound().get(swarmId);
      if (conn) {
        conn.lastMessageAt = new Date().toISOString();
      }
      debouncedHeartbeat(swarmId);
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
  // Apply connection persistence config
  MISSED_PONGS_BEFORE_TERMINATE = config.mapHub.missedPongsBeforeTerminate;
  HEARTBEAT_DEBOUNCE_MS = config.mapHub.heartbeatDebounceMs;

  const mapServer = initMapServer(config);

  // Subscribe to MAP scope messages for task event interception.
  // When agents send task events via connection.send({ scope }, payload),
  // the MAPServer processes the map/send request and fires message.sent.
  // We intercept these to route task events to the OpenTasks compat shim.
  mapServer.eventBus.on('message.sent', (event: any) => {
    const message = event?.data?.message;
    if (!message?.payload || typeof message.payload !== 'object') return;
    const payload = message.payload as Record<string, unknown>;
    if (typeof payload.type !== 'string') return;

    // Only handle task + context events
    const taskTypes = new Set(['task.created', 'task.assigned', 'task.status']);
    const contextTypes = new Set(['context.created', 'context.updated']);
    const isTask = taskTypes.has(payload.type);
    const isContext = contextTypes.has(payload.type);
    if (!isTask && !isContext) return;

    // Resolve the OpenHive agent ID + swarm ID from the MAP message sender.
    // message.from is the MAP session agent ID (a ULID assigned by MAPServer),
    // not the OpenHive swarmId or agentId. We need to find which inbound
    // connection this MAP agent belongs to, then use its OpenHive agentId.
    // Context events additionally need the swarmId to look up the connection's
    // default task graph (→ resource_id) in the broadcast.
    const mapFrom = typeof message.from === 'string' ? message.from : 'unknown';
    let resolvedAgentId = mapFrom;
    let resolvedSwarmId: string | undefined;

    // Try direct lookup (message.from might be a swarmId)
    const directConn = getInbound(mapFrom);
    if (directConn) {
      resolvedAgentId = directConn.agentId;
      resolvedSwarmId = directConn.swarmId;
    } else {
      // Search all connections — message.from might be a MAP session agent ID
      // or a registered agent name. Check both registeredAgents and the ULID match.
      for (const [, conn] of getAllInbound()) {
        if (conn.registeredAgents.has(mapFrom)) {
          resolvedAgentId = conn.agentId;
          resolvedSwarmId = conn.swarmId;
          break;
        }
      }
      // Fallback: the MAP session agent ID doesn't directly map to our registry.
      // Try matching via the event's session metadata or by finding the connection
      // whose router session owns this agent.
      if (resolvedAgentId === mapFrom) {
        for (const [, conn] of getAllInbound()) {
          // Check if any registered agent on this connection matches
          for (const [, regAgent] of conn.registeredAgents) {
            if (regAgent.id === mapFrom || regAgent.name === mapFrom) {
              resolvedAgentId = conn.agentId;
              resolvedSwarmId = conn.swarmId;
              break;
            }
          }
          if (resolvedAgentId !== mapFrom) break;
        }
        // Last resort: if still unresolved and only one connection, use it
        if (resolvedAgentId === mapFrom) {
          const allInbound = getAllInbound();
          if (allInbound.size === 1) {
            const only = [...allInbound.values()][0];
            resolvedAgentId = only.agentId;
            resolvedSwarmId = only.swarmId;
          }
        }
      }
    }

    if (isTask) {
      handleMapTaskEvent(payload, resolvedAgentId);
    } else if (isContext && resolvedSwarmId) {
      handleMapContextEvent(payload, resolvedSwarmId, resolvedAgentId);
    }
  });

  fastify.get('/ws/map', { websocket: true }, async (socket, request) => {
    const trustModel = config.mapHub.trustModel;
    const ws = socket as unknown as WebSocket;
    const query = request.query as { token?: string; swarm_id?: string };

    // Track liveness for heartbeat ping/pong
    (ws as any).isAlive = true;
    (ws as any).missedPongs = 0;
    ws.on('pong', () => {
      (ws as any).isAlive = true;
      (ws as any).missedPongs = 0;
      // Pong receipt is a liveness signal — refresh heartbeat via debounced path
      if (connectedSwarmId) debouncedHeartbeat(connectedSwarmId);
    });

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

      // Cascade node_unregistered for every graph-visible agent on this swarm
      // so the SwarmCraft agent graph marks them stopped when the swarm drops
      // (the MAP SDK does not reliably emit agent.unregistered on session
      // close, so we do it here explicitly before tearing down the connection).
      if (current) {
        for (const [agentEntryId, entry] of current.registeredAgents) {
          if (isGraphHiddenRole(entry.role)) continue;
          mapHubEvents.emit('node_unregistered', {
            node_id: agentEntryId,
            swarm_id: sid,
            map_agent_id: agentEntryId,
          });
        }
      }

      clearHeartbeatDebounce(sid);
      unregisterInbound(sid);
      // Fail any pending notification-pair RPCs to this swarm fast,
      // instead of waiting out their (default 30s) timeouts. Callers see
      // a typed `NotificationPairTransportLost` error and can retry.
      try { rejectPendingForSwarm(sid, 'swarm_ws_closed'); } catch { /* non-critical */ }
      try {
        if (!hasOutboundConnection(sid)) {
          updateSwarm(sid, { status: 'unreachable' });
          // Stop advertising this swarm's nodes as reachable. Last-known
          // state is retained as a breadcrumb; presence is what the UI reads.
          try { bulkUpdateSwarmNodesPresence(sid, 'offline'); } catch { /* non-critical */ }
          broadcastSwarmLifecycleEvent(sid, {
            type: 'swarm_offline',
            data: { swarm_id: sid },
          });
          broadcastSwarmLifecycleEvent(sid, {
            type: 'swarm.status_changed',
            data: { swarm_id: sid, status: 'unreachable' },
          });
          mapHubEvents.emit('swarm_offline', { swarm_id: sid });
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

    let authResult: AuthResult | null = null;
    if (query.token) {
      authResult = await authenticateToken(query.token);
    }

    // Local mode fallback: no token → use the local agent (same as HTTP auth middleware)
    if (!authResult && config.auth.mode === 'local') {
      const local = await getOrCreateLocalAgent();
      if (local) authResult = { agent: local };
    }

    ws.removeListener('message', bufferHandler);

    if (!authResult) {
      sendJsonRpcError(ws, -32000, 'Missing or invalid authentication token');
      ws.close(4001, 'Unauthorized');
      return;
    }
    const agent = authResult.agent;

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
        if (!registeredAgent) return;

        // Filter strictly by session ID. The MAPServer eventBus is shared
        // across all inbound connections, so without this filter every
        // swarm's handler would claim every other swarm's registrations.
        let mySessionId: string | undefined;
        try {
          mySessionId = router.session?.id;
        } catch {
          mySessionId = undefined;
        }
        if (!shouldAcceptAgentRegistration(event, mySessionId)) return;

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
        // Scope resolution, in priority order:
        //   1. Token presented at the WS `?token=` gate (authResult)
        //   2. MAPServer's own map/authenticate flow (router.session.principal)
        //   3. DB fallback (agent.is_admin / capabilities column)
        // The two token paths converge on agent-iam; priority 1 covers
        // spawned swarms that present a delegated token directly, priority
        // 2 covers full MAP handshake clients.
        const principalClaims = (router.session?.principal?.claims ?? {}) as Record<string, unknown>;
        const tokenScopes = authResult.tokenScopes
          ?? (Array.isArray(principalClaims.scopes) ? (principalClaims.scopes as string[]) : undefined);
        const tokenExpiresAt = authResult.tokenExpiresAt
          ?? (router.session?.principal?.expiresAt
            ? new Date(router.session.principal.expiresAt).toISOString()
            : undefined);
        registerInbound(swarmId, {
          ws, agentId: agent.id, swarmId,
          connectedAt: now, lastMessageAt: now,
          tokenExpiresAt,
          tokenDelegatable: authResult.tokenDelegatable,
          tokenSerialized: authResult.tokenSerialized,
          sessionScopes: resolveSessionScopes({ agent, tokenScopes }),
          registeredAgents: new Map(),
        });
        heartbeatSwarm(swarmId);
        try {
          broadcastSwarmLifecycleEvent(swarmId, {
            type: 'swarm.status_changed',
            data: { swarm_id: swarmId, status: 'online' },
          });
        } catch { /* non-critical */ }

        // Fires on every handshake (first connect AND reconnect). The
        // swarm-bridge uses this as an idempotent upsert signal so that
        // swarms which were previously marked stopped (via swarm_offline)
        // are reactivated in the SwarmCraft agent graph, and late-arriving
        // swarms that missed startup hydration get projected.
        mapHubEvents.emit('swarm_online', {
          swarm_id: swarmId,
          name: registeredAgent.name || `${swarmId}-hub`,
        });

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
    // Open mode: session scopes come from the presented agent-iam token if
    // one was accepted at the outer gate, else fall back to DB capabilities
    // + is_admin. Delegated swarms spawned via map/agents/spawn always
    // arrive with a token; vanilla API-key connections use the DB path.
    registerInbound(swarmId, {
      ws, agentId: agent.id, swarmId,
      connectedAt: now, lastMessageAt: now,
      tokenExpiresAt: authResult.tokenExpiresAt,
      tokenDelegatable: authResult.tokenDelegatable,
      tokenSerialized: authResult.tokenSerialized,
      sessionScopes: resolveSessionScopes({ agent, tokenScopes: authResult.tokenScopes }),
      registeredAgents: new Map(),
    });
    heartbeatSwarm(swarmId);
    try {
      broadcastSwarmLifecycleEvent(swarmId, {
        type: 'swarm.status_changed',
        data: { swarm_id: swarmId, status: 'online' },
      });
    } catch { /* non-critical */ }

    // See verified-mode emission above for rationale.
    mapHubEvents.emit('swarm_online', {
      swarm_id: swarmId,
      name: agent.name || `${swarmId}-hub`,
    });

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

      // The MAPServer eventBus is shared across every inbound connection,
      // so this handler fires for every swarm's registration. Filter on
      // router session identity — otherwise agents leak between swarms.
      let mySessionId: string | undefined;
      try {
        mySessionId = router.session?.id;
      } catch {
        mySessionId = undefined;
      }
      if (!shouldAcceptAgentRegistration(event, mySessionId)) return;

      console.log(`[ws-map] Agent registered on ${swarmId}: ${registeredAgent.name || registeredAgent.id} (${registeredAgent.role || 'agent'})`);

      const conn = getInbound(swarmId);
      if (conn) {
        // Track registered agent on this connection (with per-agent capabilities + metadata)
        const agentEntry = {
          id: registeredAgent.id || registeredAgent.name || 'unknown',
          name: registeredAgent.name || 'unknown',
          role: registeredAgent.role || 'agent',
          state: 'registered',
          scopes: registeredAgent.scopes || [],
          capabilities: registeredAgent.capabilities || undefined,
          metadata: registeredAgent.metadata || undefined,
        };
        conn.registeredAgents.set(agentEntry.id, agentEntry);

        // Reconnect: if a map_nodes row already exists for this agent (e.g.
        // it was populated earlier via HTTP POST /map/nodes and then flipped
        // offline on the previous disconnect), flip it back online now rather
        // than waiting for the first state.changed event.
        try {
          const node = findNodeBySwarmAndAgentId(swarmId, agentEntry.id);
          if (node && node.presence !== 'online') {
            updateNode(node.id, { presence: 'online' });
          }
        } catch { /* non-critical */ }

        // Update connection-level capabilities (kept for backward compat;
        // getMergedCapabilities() provides the union across all agents)
        if (registeredAgent.capabilities) {
          conn.capabilities = registeredAgent.capabilities;
        }

        // Keep DB agent_count in sync with live registrations
        try { updateSwarm(swarmId, { agent_count: conn.registeredAgents.size }); } catch { /* non-critical */ }

        // Project into the SwarmCraft agent graph so child agents (coordinators,
        // integrators, workers) become selectable nodes. Skip infrastructure
        // roles (sidecar — not a user-facing agent) and transient roles
        // (subagent — short-lived spawned helpers that would churn the graph).
        // Capabilities are forwarded so SwarmCraft's capability resolver can
        // detect ACP/mail/messaging without re-probing the MAP connection.
        if (!isGraphHiddenRole(agentEntry.role)) {
          mapHubEvents.emit('node_registered', {
            node_id: agentEntry.id,
            swarm_id: swarmId,
            map_agent_id: agentEntry.id,
            name: agentEntry.name,
            role: agentEntry.role,
            state: agentEntry.state,
            capabilities: agentEntry.capabilities,
            metadata: agentEntry.metadata,
          });
        }
      }

      // Enrich swarm record with agent metadata (project, branch, template).
      // Only update the swarm's name and metadata when the registering agent
      // carries workspace-level context (project). Sidecars carry this;
      // spawned coordinators/workers do not — their per-agent random names and
      // sparse metadata should NOT overwrite the swarm's identity. Without
      // this guard, every spawn would rename the swarm and clobber its
      // workspace metadata.
      if (registeredAgent.metadata) {
        const meta = registeredAgent.metadata as Record<string, unknown>;
        const project = meta.project as string | undefined;
        const branch = meta.branch as string | undefined;

        try {
          // Always refresh aggregate capabilities (union across all agents)
          const aggCaps = getAggregateCapabilities(swarmId);
          if (project) {
            // Workspace-bearing registration (sidecar): set name + metadata
            updateSwarm(swarmId, {
              name: branch ? `${project} (${branch})` : project,
              capabilities: aggCaps || registeredAgent.capabilities || undefined,
              metadata: meta,
            });
          } else {
            // Per-agent registration (coordinator/worker): only update caps
            updateSwarm(swarmId, {
              capabilities: aggCaps || registeredAgent.capabilities || undefined,
            });
          }
        } catch { /* non-critical */ }

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

      // Mirror MAP-protocol registrations into the hub's `node_registered`
      // event stream so SwarmCraft's bridge (and any other consumer) sees
      // individual coordinators/workers — not just the parent swarm. The
      // legacy HTTP `/map/nodes` path emits this event natively; without
      // this mirror, agents spawned inside a hosted macro-agent never land
      // in SwarmCraft's agents list or its UI.
      //
      // Skip the sidecar role: it's the swarm connection itself, not a
      // separate agent. Emitting for it would duplicate the swarm row.
      const role = registeredAgent.role || 'agent';
      if (role !== 'sidecar') {
        // Prefer the peer-side ULID so repeat registrations across
        // reconnects hash to the same SwarmCraft agent id. Falls back to
        // the hub-assigned id when the peer didn't send one.
        const peerId = getPeerMapId(registeredAgent.metadata) ?? registeredAgent.id;
        try {
          mapHubEvents.emit('node_registered', {
            node_id: registeredAgent.id,
            swarm_id: swarmId,
            map_agent_id: peerId,
            name: registeredAgent.name ?? null,
            role,
            state: 'registered',
          });
        } catch { /* non-critical */ }

        // Fan out to fleet (`map:discovery`) + per-swarm. Without the
        // fleet broadcast, agents spawned dynamically inside an already-
        // online hosted macro-agent (e.g. a new coordinator created via
        // the "+" button or via macro-agent's spawn API) appear in the
        // hub DB but the picker UI never learns about them until a
        // reload. See realtime/swarm-events.ts for the routing contract.
        try {
          broadcastSwarmLifecycleEvent(swarmId, {
            type: 'node_registered',
            data: {
              node_id: registeredAgent.id,
              swarm_id: swarmId,
              map_agent_id: peerId,
              role,
            },
          });
        } catch { /* non-critical */ }
      }
    };
    const unsubRegistered = mapServer.eventBus.on('agent.registered', onAgentRegistered);

    // Listen for MAP agent state changes (e.g. active→idle on turn completion)
    // and propagate to OpenHive's node DB + WebSocket channels.
    // MAP SDK emits: { type: 'agent.state.changed', data: { agent, previousState }, source: { agentId, sessionId } }
    const onAgentStateChanged = (event: any) => {
      const agentData = event?.data?.agent;
      const previousState = event?.data?.previousState;
      if (!agentData?.id || !agentData?.state) return;

      const newState = agentData.state;
      const mapAgentId = agentData.id;

      // Match this event to our connection — check if the agent is registered on this swarm
      const conn = getInbound(swarmId);
      if (!conn) return;
      if (!conn.registeredAgents.has(mapAgentId)) return;

      const agentEntry = conn.registeredAgents.get(mapAgentId);
      if (agentEntry) {
        agentEntry.state = newState;
      }

      // Update the MAP node in the DB if one exists. A state event means the
      // agent is alive — stamp presence=online too so reconnect self-heals
      // even if we missed the swarm's connect-side presence write.
      const node = findNodeBySwarmAndAgentId(swarmId, mapAgentId);
      if (node) {
        const patch: { state?: string; presence?: 'online' } = {};
        if (node.state !== newState) patch.state = newState;
        if (node.presence !== 'online') patch.presence = 'online';
        if (patch.state || patch.presence) {
          try { updateNode(node.id, patch as Parameters<typeof updateNode>[1]); } catch { /* non-critical */ }
        }
      }

      // Broadcast to WebSocket for frontend attention detection
      const wsEvent = {
        type: 'node_state_changed' as const,
        data: {
          node_id: node?.id || mapAgentId,
          swarm_id: swarmId,
          map_agent_id: mapAgentId,
          old_state: previousState,
          new_state: newState,
          needs_attention: ['idle', 'stopped', 'failed'].includes(newState),
        },
      };
      broadcastToChannel(`map:swarm:${swarmId}`, wsEvent);
      broadcastToChannel('global', wsEvent);

      // Propagate state changes to the SwarmCraft agent graph for the same
      // roles we project on register (skip sidecar + subagent).
      if (!isGraphHiddenRole(agentEntry?.role)) {
        mapHubEvents.emit('node_state_changed', {
          node_id: mapAgentId,
          swarm_id: swarmId,
          map_agent_id: mapAgentId,
          previous_state: previousState,
          new_state: newState,
        });
      }
    };
    const unsubStateChanged = mapServer.eventBus.on('agent.state.changed', onAgentStateChanged);

    // Listen for metadata updates (e.g. sidecar publishes canHostAcp post-connect).
    // The MAP SDK's register() doesn't forward the `metadata` field from connect
    // options, so the sidecar calls updateMetadata() after connecting. We update
    // the cached per-agent metadata so the /map/swarms/:id endpoint returns
    // current values in registered_agents[].metadata (used by the UI to detect
    // swarms that can spawn ACP coordinators on demand).
    const onAgentMetadataChanged = (event: any) => {
      const agentData = event?.data?.agent;
      if (!agentData?.id) return;

      const conn = getInbound(swarmId);
      if (!conn) return;
      const entry = conn.registeredAgents.get(agentData.id);
      if (!entry) return;

      entry.metadata = agentData.metadata || {};
    };
    const unsubMetadataChanged = mapServer.eventBus.on('agent.metadata.changed', onAgentMetadataChanged);

    // Listen for MAP agent unregistration (e.g. when a coordinator is terminated
    // via _macro/terminateAgent and the lifecycle bridge calls map/agents/unregister).
    // MAP SDK emits: { type: 'agent.unregistered', data: { agentId, agent }, source: { agentId, sessionId } }
    const onAgentUnregistered = (event: any) => {
      const agentId = event?.data?.agentId ?? event?.data?.agent?.id;
      if (!agentId) return;

      const conn = getInbound(swarmId);
      if (!conn) return;
      if (!conn.registeredAgents.has(agentId)) return;

      const removedEntry = conn.registeredAgents.get(agentId);
      conn.registeredAgents.delete(agentId);
      console.log(`[ws-map] Agent unregistered on ${swarmId}: ${agentId}`);

      // Flip the matching map_nodes row to offline so the UI doesn't keep
      // showing its last-known MAP state (e.g. 'idle') as if it were live.
      try {
        const node = findNodeBySwarmAndAgentId(swarmId, agentId);
        if (node && node.presence !== 'offline') {
          updateNode(node.id, { presence: 'offline' });
        }
      } catch { /* non-critical */ }

      // Keep DB agent_count in sync
      try { updateSwarm(swarmId, { agent_count: conn.registeredAgents.size }); } catch { /* non-critical */ }

      // Refresh aggregate capabilities since the removed agent's capabilities no longer contribute
      try {
        const aggCaps = getAggregateCapabilities(swarmId);
        updateSwarm(swarmId, { capabilities: aggCaps || undefined });
      } catch { /* non-critical */ }

      // Broadcast to frontend so the UI can refresh the registered_agents list
      const wsEvent = {
        type: 'agent_unregistered' as const,
        data: { swarm_id: swarmId, agent_id: agentId },
      };
      broadcastToChannel(`map:swarm:${swarmId}`, wsEvent);
      broadcastToChannel('global', wsEvent);

      // Remove from the SwarmCraft agent graph for roles we project.
      if (!isGraphHiddenRole(removedEntry?.role)) {
        mapHubEvents.emit('node_unregistered', {
          node_id: agentId,
          swarm_id: swarmId,
          map_agent_id: agentId,
        });
      }
    };
    const unsubUnregistered = mapServer.eventBus.on('agent.unregistered', onAgentUnregistered);

    console.log(`[ws-map] Swarm ${swarmId} connected inbound (agent: ${agent.name})`);

    // Cleanup on close (router.closed as backup — ws 'close' is primary)
    router.closed.then(() => {
      unsubRegistered();
      unsubStateChanged();
      unsubMetadataChanged();
      unsubUnregistered();
      interceptor.cleanup();
      handleDisconnect();
    });
  });

  // Start heartbeat
  startMapHeartbeat();

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
        // Increment missed pong counter instead of immediately terminating
        const missed = ((conn.ws as any).missedPongs = ((conn.ws as any).missedPongs || 0) + 1);

        if (missed >= MISSED_PONGS_BEFORE_TERMINATE) {
          // Send reconnect hint then close gracefully. We use ws.close()
          // instead of ws.terminate() so the send buffer flushes and the
          // client actually receives the hub/reconnect notification. A
          // fallback terminate fires after 1s in case close hangs.
          try {
            sendJsonRpc(conn.ws, 'hub/reconnect', {
              reason: 'heartbeat_timeout',
              missed_pongs: missed,
              message: 'Connection will be terminated due to missed heartbeats. Please reconnect.',
            });
          } catch { /* connection may already be dead */ }

          console.log(`[ws-map] Closing swarm ${swarmId} after ${missed} missed pongs`);
          clearHeartbeatDebounce(swarmId);
          unregisterInbound(swarmId);

          // Graceful close with a hard terminate fallback
          try { conn.ws.close(4000, 'heartbeat_timeout'); } catch { /* ignore */ }
          setTimeout(() => {
            try { conn.ws.terminate(); } catch { /* already gone */ }
          }, 1000);

          try {
            if (!hasOutboundConnection(swarmId)) {
              updateSwarm(swarmId, { status: 'unreachable' });
              try { bulkUpdateSwarmNodesPresence(swarmId, 'offline'); } catch { /* non-critical */ }
              broadcastSwarmLifecycleEvent(swarmId, {
                type: 'swarm_offline',
                data: { swarm_id: swarmId },
              });
              broadcastSwarmLifecycleEvent(swarmId, {
                type: 'swarm.status_changed',
                data: { swarm_id: swarmId, status: 'unreachable' },
              });
              mapHubEvents.emit('swarm_offline', { swarm_id: swarmId });
            }
          } catch { /* */ }
          continue;
        }

        // Not yet at threshold — log warning, broadcast degraded event, continue pinging
        console.log(`[ws-map] Swarm ${swarmId} missed pong (${missed}/${MISSED_PONGS_BEFORE_TERMINATE})`);
        broadcastSwarmLifecycleEvent(swarmId, {
          type: 'connection_degraded',
          data: {
            swarm_id: swarmId,
            missed_pongs: missed,
            max_missed_pongs: MISSED_PONGS_BEFORE_TERMINATE,
          },
        });
      } else {
        // Pong was received — reset counter
        const previousMissed = (conn.ws as any).missedPongs || 0;
        (conn.ws as any).missedPongs = 0;

        // Broadcast recovery if connection was previously degraded
        if (previousMissed > 0) {
          broadcastSwarmLifecycleEvent(swarmId, {
            type: 'connection_recovered',
            data: {
              swarm_id: swarmId,
              recovered_from_missed: previousMissed,
            },
          });
        }
      }

      // Mark as not-alive; set back to true when pong arrives or a message is received
      (conn.ws as any).isAlive = false;

      if (conn.ws.readyState !== WebSocket.OPEN) continue;

      // Keep last_seen_at fresh so connected swarms stay "online" (debounced)
      debouncedHeartbeat(swarmId);

      // Protocol-level ping — the ws library responds with a pong frame
      // at the transport layer, so this works for ALL WebSocket clients
      // (including MAP SDK clients that have no application-level ping handling).
      conn.ws.ping();
      // Also send JSON-RPC ping for clients that use application-level keepalive
      sendJsonRpc(conn.ws, 'ping', {});

      // Token expiry check
      if (conn.tokenExpiresAt) {
        const expiresAt = new Date(conn.tokenExpiresAt).getTime();
        const secondsLeft = Math.floor((expiresAt - now) / 1000);
        // Past expiry → force the WS closed. Method dispatch would
        // start failing (agent-iam verify rejects expired tokens) but
        // `sessionScopes` was cached at connect time, so without this
        // close a stale session could keep calling MAP methods
        // indefinitely. Closing here matches the RFC §"Session scope
        // resolution" expiry contract.
        if (secondsLeft <= 0) {
          try {
            sendJsonRpc(conn.ws, 'map/auth.expired', { reason: 'token_expired' });
            conn.ws.close(4003, 'Token expired');
          } catch { /* ignore */ }
          continue;
        }
        if (!conn.expiryNotified && secondsLeft <= TOKEN_EXPIRY_WARNING_SECONDS) {
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

/**
 * Force-disconnect any open WS sessions whose authenticating token
 * chain intersects `agentId`. Called from `token-service.revokeToken`
 * so operator-initiated revocation kicks active sessions off before
 * the heartbeat catches expiry.
 *
 * Matches either:
 *  - `conn.agentId === agentId` (direct revocation of the session's
 *    hub agent), or
 *  - any ancestor in the parent-chain registry for the session's token
 *    subject — handled inside `verifyToken`, which `tokenHasScope` and
 *    future revalidation sweeps will consult.
 *
 * For v4 the simple case is sufficient: most sessions are one delegation
 * deep (coordinator → child), and revoking the coordinator disconnects
 * the session whose conn.agentId == coordinator.id.
 */
export function disconnectSessionsForAgent(agentId: string): void {
  for (const [swarmId, conn] of getAllInbound()) {
    if (conn.agentId !== agentId) continue;
    try {
      sendJsonRpc(conn.ws, 'map/auth.revoked', { reason: 'token_revoked' });
      conn.ws.close(4003, 'Token revoked');
    } catch { /* ignore */ }
    unregisterInbound(swarmId);
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

export function stopMapWebSocket(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // Clean up all debounce timers
  for (const timer of heartbeatDebounceTimers.values()) {
    clearTimeout(timer);
  }
  heartbeatDebounceTimers.clear();

  for (const [swarmId, conn] of getAllInbound()) {
    try { conn.ws.close(); } catch { /* ignore */ }
    unregisterInbound(swarmId);
  }

  _resetMapServer();

  console.log('[ws-map] MAP WebSocket stopped');
}
