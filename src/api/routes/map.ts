/**
 * MAP Hub API Routes
 *
 * REST API for MAP swarm registration, agent node discovery,
 * peer coordination, and pre-auth key management.
 *
 * Routes:
 *   POST   /map/swarms               - Register a swarm
 *   GET    /map/swarms               - List swarms
 *   GET    /map/swarms/:id           - Get swarm details
 *   PUT    /map/swarms/:id           - Update swarm
 *   DELETE /map/swarms/:id           - Deregister swarm
 *   POST   /map/swarms/:id/heartbeat - Heartbeat (keep alive)
 *   POST   /map/swarms/:id/hives     - Join a hive
 *   DELETE /map/swarms/:id/hives/:hiveName - Leave a hive
 *
 *   POST   /map/nodes                - Register agent node
 *   GET    /map/nodes                - Discover nodes
 *   GET    /map/nodes/:id            - Get node details
 *   PUT    /map/nodes/:id            - Update node
 *   DELETE /map/nodes/:id            - Deregister node
 *
 *   GET    /map/peers/:swarmId       - Get peer list (headscale-style)
 *
 *   POST   /map/preauth-keys         - Create pre-auth key (admin)
 *   GET    /map/preauth-keys         - List pre-auth keys (admin)
 *   DELETE /map/preauth-keys/:id     - Revoke pre-auth key (admin)
 *
 *   GET    /map/stats                - Hub stats
 *   GET    /map/connections          - Live connection health (all)
 *   GET    /map/connections/:swarmId - Live connection health (single)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authMiddleware, optionalAuthMiddleware, createAdminAuth } from '../middleware/auth.js';
import * as mapDal from '../../db/dal/map.js';
import {
  registerSwarm,
  registerNode,
  getPeerList,
  joinHive,
  leaveHive,
  MapHubError,
} from '../../map/service.js';
import { createSwarmToken, delegateToken, revokeToken } from '../../map/token-service.js';
import type { Config } from '../../config.js';
import { broadcastToChannel } from '../../realtime/index.js';
import { broadcastSwarmLifecycleEvent } from '../../realtime/swarm-events.js';
import { getAllConnectionHealth, getConnectionHealth, getInbound, getPeerMapId } from '../../map/connection-registry.js';
import { getSyncListenerStatus } from '../../map/sync-listener.js';

// ============================================================================
// Zod Schemas
// ============================================================================

// Capabilities accept both flat booleans (legacy) and structured objects (MAP ParticipantCapabilities)
const capabilitiesSchema = z.object({
  observation: z.union([z.boolean(), z.record(z.unknown())]).optional(),
  messaging: z.union([z.boolean(), z.record(z.unknown())]).optional(),
  lifecycle: z.union([z.boolean(), z.record(z.unknown())]).optional(),
  scopes: z.boolean().optional(),
  federation: z.boolean().optional(),
  protocols: z.array(z.string()).optional(),
  mail: z.object({
    canCreate: z.boolean().optional(),
    canJoin: z.boolean().optional(),
    canInvite: z.boolean().optional(),
    canViewHistory: z.boolean().optional(),
    canCreateThreads: z.boolean().optional(),
  }).optional(),
}).passthrough();

const RegisterSwarmSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  map_endpoint: z.string().url(),
  map_transport: z.enum(['websocket', 'http-sse', 'ndjson']).optional(),
  capabilities: capabilitiesSchema.optional(),
  auth_method: z.enum(['bearer', 'api-key', 'mtls', 'none']).optional(),
  auth_token: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  preauth_key: z.string().optional(),
  stable_identity: z.string().max(500).optional(),
});

const UpdateSwarmSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  map_endpoint: z.string().url().optional(),
  map_transport: z.enum(['websocket', 'http-sse', 'ndjson']).optional(),
  status: z.enum(['online', 'offline', 'unreachable']).optional(),
  capabilities: capabilitiesSchema.optional(),
  auth_method: z.enum(['bearer', 'api-key', 'mtls', 'none']).optional(),
  auth_token: z.string().optional(),
  agent_count: z.number().int().min(0).optional(),
  scope_count: z.number().int().min(0).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const RegisterNodeSchema = z.object({
  swarm_id: z.string(),
  map_agent_id: z.string().min(1),
  name: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  role: z.string().max(50).optional(),
  state: z.enum(['registered', 'active', 'busy', 'idle', 'suspended', 'stopped', 'failed']).optional(),
  capabilities: z.record(z.unknown()).optional(),
  scopes: z.array(z.string()).optional(),
  visibility: z.enum(['public', 'hive-only', 'swarm-only']).optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

const UpdateNodeSchema = z.object({
  name: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  role: z.string().max(50).optional(),
  state: z.enum(['registered', 'active', 'busy', 'idle', 'suspended', 'stopped', 'failed']).optional(),
  capabilities: z.record(z.unknown()).optional(),
  scopes: z.array(z.string()).optional(),
  visibility: z.enum(['public', 'hive-only', 'swarm-only']).optional(),
  metadata: z.record(z.unknown()).optional(),
  tags: z.array(z.string()).optional(),
});

const JoinHiveSchema = z.object({
  hive_name: z.string().min(1),
});

const CreatePreauthKeySchema = z.object({
  hive_id: z.string().optional(),
  uses: z.number().int().min(1).max(1000).optional(),
  expires_in_hours: z.number().min(1).max(8760).optional(), // max 1 year
});

const NetworkProvisionSchema = z.object({
  hive_name: z.string().min(1).max(100),
  reusable: z.boolean().optional(),
  ephemeral: z.boolean().optional(),
  expiration_hours: z.number().min(1).max(8760).optional(),
});

// ============================================================================
// Query Param Helpers
// ============================================================================

const MAX_PAGE_SIZE = 200;

/** Parse a numeric query param with NaN guard and optional clamping */
function parseIntParam(value: string | undefined, max?: number): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return max ? Math.min(n, max) : n;
}

// ============================================================================
// Error Handler
// ============================================================================

function handleMapError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof MapHubError) {
    const statusMap: Record<string, number> = {
      DUPLICATE_ENDPOINT: 409,
      INVALID_PREAUTH_KEY: 401,
      NOT_SWARM_OWNER: 403,
      DUPLICATE_NODE: 409,
      SWARM_NOT_FOUND: 404,
      NODE_NOT_FOUND: 404,
      HIVE_NOT_FOUND: 404,
    };
    return reply.status(statusMap[error.code] || 400).send({
      error: error.code,
      message: error.message,
    });
  }
  if (error instanceof z.ZodError) {
    return reply.status(422).send({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request body',
      details: error.errors,
    });
  }
  throw error;
}

// ============================================================================
// Route Registration
// ============================================================================

export async function mapRoutes(
  fastify: FastifyInstance,
  opts: { config: Config }
): Promise<void> {
  const adminAuth = createAdminAuth(opts.config);

  // ==========================================================================
  // Swarm Routes
  // ==========================================================================

  // POST /map/swarms -- Register a swarm
  fastify.post('/map/swarms', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = RegisterSwarmSchema.parse(request.body);
      const result = registerSwarm(request.agent!.id, body);

      // In verified mode, issue an agent-iam token for the new swarm
      let swarm_token: string | undefined;
      if (opts.config.mapHub.trustModel === 'verified') {
        try {
          const { serialized } = createSwarmToken(result.swarm.id);
          swarm_token = serialized;
        } catch {
          // TokenService not initialized — skip token issuance
        }
      }

      return reply.status(201).send({ ...result, swarm_token });
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // GET /map/swarms -- List swarms
  fastify.get<{
    Querystring: {
      hive_id?: string;
      status?: string;
      limit?: string;
      offset?: string;
      dedupe?: string;
      recency_days?: string;
      include_archived?: string;
    };
  }>('/map/swarms', {
    preHandler: [optionalAuthMiddleware],
  }, async (request, reply) => {
    const { hive_id, status, limit, offset, dedupe, recency_days, include_archived } = request.query;

    // Deduped picker mode: returns unique logical swarms with variant_count
    if (dedupe === '1' || dedupe === 'true') {
      const statuses = status ? status.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const items = mapDal.listSwarmsForPicker({
        recency_days: recency_days ? parseInt(recency_days, 10) : undefined,
        status: statuses,
        include_archived: include_archived === '1' || include_archived === 'true',
      });

      const enriched = items.map((s) => {
        const hives = mapDal.getSwarmHiveNames(s.id);
        const conn = getInbound(s.id);
        const registered_agents = conn
          ? Array.from(conn.registeredAgents.values()).map((a) => ({
              id: a.id, name: a.name, role: a.role, state: a.state,
              capabilities: a.capabilities, metadata: a.metadata,
            }))
          : [];
        return {
          id: s.id, name: s.name, description: s.description,
          map_endpoint: s.map_endpoint, map_transport: s.map_transport,
          status: s.status, last_seen_at: s.last_seen_at,
          capabilities: s.capabilities, auth_method: s.auth_method,
          agent_count: s.agent_count, scope_count: s.scope_count,
          metadata: s.metadata, hives, registered_agents,
          created_at: s.created_at,
          variant_count: s.variant_count,
        };
      });
      return reply.send({ data: enriched, total: enriched.length });
    }

    const statusArr = status ? status.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const result = mapDal.listSwarms({
      hive_id,
      status: statusArr && statusArr.length === 1 ? statusArr[0] : statusArr,
      include_archived: include_archived === '1' || include_archived === 'true',
      limit: parseIntParam(limit, MAX_PAGE_SIZE),
      offset: parseIntParam(offset),
    });

    // Enrich with hive names + live registered_agents (so the swarm list can
    // render per-agent actions inline without an N+1 detail fetch).
    const data = result.data.map((s) => {
      const hives = mapDal.getSwarmHiveNames(s.id);
      const conn = getInbound(s.id);
      const registered_agents = conn
        ? Array.from(conn.registeredAgents.values()).map((a) => ({
            id: a.id, name: a.name, role: a.role, state: a.state,
            capabilities: a.capabilities, metadata: a.metadata,
          }))
        : [];
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        map_endpoint: s.map_endpoint,
        map_transport: s.map_transport,
        status: s.status,
        last_seen_at: s.last_seen_at,
        capabilities: s.capabilities,
        auth_method: s.auth_method,
        agent_count: s.agent_count,
        scope_count: s.scope_count,
        metadata: s.metadata,
        hives,
        registered_agents,
        created_at: s.created_at,
      };
    });

    return reply.send({ data, total: result.total });
  });

  // GET /map/swarms/:id -- Get swarm details
  fastify.get<{ Params: { id: string } }>('/map/swarms/:id', {
    preHandler: [optionalAuthMiddleware],
  }, async (request, reply) => {
    const pub = mapDal.getSwarmPublic(request.params.id);
    if (!pub) {
      return reply.status(404).send({ error: 'Not Found', message: 'Swarm not found' });
    }

    // Enrich with live registered agents from the connection registry
    const conn = getInbound(request.params.id);
    const registeredAgents = conn
      ? Array.from(conn.registeredAgents.values()).map(a => ({
          id: a.id, name: a.name, role: a.role, state: a.state,
          capabilities: a.capabilities, metadata: a.metadata,
        }))
      : [];

    return reply.send({ ...pub, registered_agents: registeredAgents });
  });

  // POST /map/swarms/:id/agents -- Spawn a new agent on a hostable swarm.
  // Proxies to `_macro/spawnAgent` via SwarmCraft's MAP client. Pure lifecycle
  // action: creates the agent and registers it with the hub, but does NOT
  // open an ACP session. Use POST /sessions/acp-connect with the returned
  // agent id to start a chat session.
  fastify.post<{
    Params: { id: string };
    Body?: {
      role?: string;
      cwd?: string;
      task?: string;
      // Forwarded to macro-agent's _macro/spawnAgent. No UI binding yet —
      // accepted on the wire so programmatic callers (CLI, swarm-dispatch,
      // future per-agent UI) can override the runtime defaults.
      permissionMode?: 'auto-approve' | 'auto-deny' | 'callback' | 'interactive';
      agentType?: string;
      customPrompt?: string;
      topics?: string[];
      config?: {
        model?: string;
        maxTokens?: number;
        temperature?: number;
        env?: Record<string, string>;
        mcpServers?: Array<{
          name: string;
          command: string;
          args?: string[];
          env?: Record<string, string>;
        }>;
      };
      taskRef?: { resource_id: string; node_id: string };
    };
  }>(
    '/map/swarms/:id/agents',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const swarmId = request.params.id;
      const role = request.body?.role ?? 'coordinator';
      const task = request.body?.task ?? 'Spawned via hub';

      const swarm = mapDal.findSwarmById(swarmId);
      if (!swarm) {
        return reply.status(404).send({ error: 'Swarm not found' });
      }

      const sc = (fastify as any).swarmcraft;
      if (!sc?.mapClientManager) {
        return reply.status(503).send({ error: 'SwarmCraft MAP client not available' });
      }
      const mapClient = sc.mapClientManager.getClient(swarmId);
      if (!mapClient) {
        return reply.status(503).send({ error: 'MAP client not connected to this swarm' });
      }

      // Resolve cwd from request → swarm.metadata.cwd → swarm.metadata.projectPath → '.'
      const swarmMeta = (swarm.metadata as Record<string, unknown>) || {};
      const cwd = request.body?.cwd
        ?? (typeof swarmMeta.cwd === 'string' ? swarmMeta.cwd : undefined)
        ?? (typeof swarmMeta.projectPath === 'string' ? swarmMeta.projectPath : undefined)
        ?? '.';

      // This route always spawns a fresh agent. To reuse an existing
      // coordinator, the UI should call /sessions/acp-connect directly
      // against that coordinator's hub agent id (the per-coordinator
      // "Chat" button does this). Spawn = "spawn", connect = "reuse".

      try {
        const result = await mapClient.callExtension('_macro/spawnAgent', {
          role,
          task,
          cwd,
          permissionMode: request.body?.permissionMode,
          agentType: request.body?.agentType,
          customPrompt: request.body?.customPrompt,
          topics: request.body?.topics,
          config: request.body?.config,
          taskRef: request.body?.taskRef,
        }) as { agent?: { id?: string; name?: string; localId?: string } };
        // `agent.id` from macro-agent is the swarm-side MAP server ULID
        // (peerMapId — the ACP target). `agent.localId` is macro-agent's
        // internal store id, which the lifecycle bridge publishes as
        // `metadata.peerAgentId`. They are different values.
        const peerMapId = result?.agent?.id;
        const peerAgentId = result?.agent?.localId ?? peerMapId;
        if (!peerMapId) {
          return reply.status(502).send({ error: 'Spawn returned no agent id' });
        }

        // Wait briefly for the lifecycle bridge to register the agent on the
        // hub so the returned hub_agent_id is usable immediately by the caller.
        // Match against either peerMapId or peerAgentId: the bridge resolves
        // peerMapId asynchronously (500ms timeout) and may emit the agent
        // with peerMapId still undefined, in which case peerAgentId is the
        // only resolvable link.
        const deadline = Date.now() + 2000;
        let hubAgentId: string | undefined;
        while (Date.now() < deadline) {
          const conn = getInbound(swarmId);
          if (conn) {
            for (const [id, entry] of conn.registeredAgents) {
              const peer = getPeerMapId(entry.metadata);
              if (peer === peerMapId || peer === peerAgentId) { hubAgentId = id; break; }
            }
          }
          if (hubAgentId) break;
          await new Promise((r) => setTimeout(r, 50));
        }

        return reply.send({
          agent_id: hubAgentId ?? peerMapId,
          peer_map_id: peerMapId,
          name: result?.agent?.name,
          role,
          cwd,
        });
      } catch (err) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // POST /map/swarms/:id/agents/:agentId/stop -- Stop a specific agent on a swarm.
  // Proxies to the swarm's MAP server via SwarmCraft's MAP client, calling the
  // _macro/terminateAgent extension. Resolves the agent's peerMapId from the
  // registered_agents metadata when possible; otherwise uses the provided id.
  fastify.post<{ Params: { id: string; agentId: string }; Body?: { reason?: string } }>(
    '/map/swarms/:id/agents/:agentId/stop',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const swarmId = request.params.id;
      const hubAgentId = request.params.agentId;
      const reason = request.body?.reason ?? 'cancelled';

      const sc = (fastify as any).swarmcraft;
      if (!sc?.mapClientManager) {
        return reply.status(503).send({ error: 'SwarmCraft MAP client not available' });
      }
      const mapClient = sc.mapClientManager.getClient(swarmId);
      if (!mapClient) {
        return reply.status(503).send({ error: 'MAP client not connected to this swarm' });
      }

      // Resolve the agent's peer MAP id (the ULID on the swarm's own MAP
      // server). Prefer registered_agents metadata (hub's view) which has
      // the peer-side ID stored. Fall back to the provided id.
      const conn = getInbound(swarmId);
      const entry = conn?.registeredAgents.get(hubAgentId);
      const targetId = getPeerMapId(entry?.metadata) ?? hubAgentId;

      // Try macro-agent's `_macro/terminateAgent` first. If the swarm runtime
      // doesn't expose it (most current macro-agent versions don't — there's
      // no MAP-exposed termination handler), fall back to `map/agents/unregister`
      // which at least removes the agent from the peer's MAP registry. The
      // peer's lifecycle bridge typically observes the unregister and tears
      // down the local agent.
      const isMethodNotFound = (err: unknown): boolean => {
        const msg = (err as Error)?.message ?? '';
        return /method not found/i.test(msg) || /-32601/.test(msg);
      };

      try {
        const result = await mapClient.callExtension('_macro/terminateAgent', {
          agentId: targetId,
          reason,
        }) as { success?: boolean; error?: string };
        if (result?.success === false) {
          return reply.status(500).send({ error: result.error || 'Failed to stop agent' });
        }
        return reply.send({ success: true });
      } catch (err) {
        if (!isMethodNotFound(err)) {
          return reply.status(500).send({ error: (err as Error).message });
        }
        // Fallback: standard MAP unregister
        try {
          await mapClient.callExtension('map/agents/unregister', {
            agentId: targetId,
            reason,
          });
          return reply.send({ success: true, method: 'map/agents/unregister' });
        } catch (fallbackErr) {
          return reply.status(501).send({
            error: 'Swarm does not support remote agent termination',
            detail: (fallbackErr as Error).message,
          });
        }
      }
    },
  );

  // PUT /map/swarms/:id -- Update swarm
  fastify.put<{ Params: { id: string } }>('/map/swarms/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      if (!mapDal.isSwarmOwner(request.params.id, request.agent!.id)) {
        throw new MapHubError('NOT_SWARM_OWNER', 'You do not own this swarm');
      }

      const body = UpdateSwarmSchema.parse(request.body);
      const updated = mapDal.updateSwarm(request.params.id, body);

      if (!updated) {
        return reply.status(404).send({ error: 'Not Found', message: 'Swarm not found' });
      }

      return reply.send(mapDal.getSwarmPublic(updated.id));
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // DELETE /map/swarms/:id -- Deregister swarm
  fastify.delete<{ Params: { id: string } }>('/map/swarms/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      if (!mapDal.isSwarmOwner(request.params.id, request.agent!.id)) {
        throw new MapHubError('NOT_SWARM_OWNER', 'You do not own this swarm');
      }

      const deleted = mapDal.deleteSwarm(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Not Found', message: 'Swarm not found' });
      }

      return reply.status(204).send();
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // POST /map/swarms/:id/heartbeat -- Swarm heartbeat
  fastify.post<{ Params: { id: string } }>('/map/swarms/:id/heartbeat', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      if (!mapDal.isSwarmOwner(request.params.id, request.agent!.id)) {
        throw new MapHubError('NOT_SWARM_OWNER', 'You do not own this swarm');
      }

      mapDal.heartbeatSwarm(request.params.id);
      broadcastSwarmLifecycleEvent(request.params.id, {
        type: 'swarm_heartbeat',
        data: { swarm_id: request.params.id },
      });
      return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // POST /map/swarms/:id/hives -- Join a hive
  fastify.post<{ Params: { id: string } }>('/map/swarms/:id/hives', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      if (!mapDal.isSwarmOwner(request.params.id, request.agent!.id)) {
        throw new MapHubError('NOT_SWARM_OWNER', 'You do not own this swarm');
      }

      const { hive_name } = JoinHiveSchema.parse(request.body);
      joinHive(request.params.id, hive_name);

      return reply.status(200).send({
        message: `Swarm joined hive "${hive_name}"`,
        hives: mapDal.getSwarmHiveNames(request.params.id),
      });
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // DELETE /map/swarms/:id/hives/:hiveName -- Leave a hive
  fastify.delete<{ Params: { id: string; hiveName: string } }>('/map/swarms/:id/hives/:hiveName', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      if (!mapDal.isSwarmOwner(request.params.id, request.agent!.id)) {
        throw new MapHubError('NOT_SWARM_OWNER', 'You do not own this swarm');
      }

      leaveHive(request.params.id, request.params.hiveName);
      return reply.send({
        message: `Swarm left hive "${request.params.hiveName}"`,
        hives: mapDal.getSwarmHiveNames(request.params.id),
      });
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // ==========================================================================
  // Token Routes (verified mode)
  // ==========================================================================

  // POST /map/swarms/:id/token -- Issue or rotate a token for an existing swarm
  fastify.post<{ Params: { id: string } }>('/map/swarms/:id/token', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      if (opts.config.mapHub.trustModel !== 'verified') {
        return reply.status(400).send({ error: 'Bad Request', message: 'Token issuance requires verified trust model' });
      }
      if (!mapDal.isSwarmOwner(request.params.id, request.agent!.id)) {
        throw new MapHubError('NOT_SWARM_OWNER', 'You do not own this swarm');
      }
      const { serialized } = createSwarmToken(request.params.id);
      return reply.send({ swarm_token: serialized });
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // POST /map/swarms/:id/delegate -- Delegate a narrower token for a child agent
  fastify.post<{ Params: { id: string }; Body: { parent_token: string; agent_id: string; scopes?: string[]; ttl_minutes?: number } }>('/map/swarms/:id/delegate', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      if (opts.config.mapHub.trustModel !== 'verified') {
        return reply.status(400).send({ error: 'Bad Request', message: 'Token delegation requires verified trust model' });
      }
      const { parent_token, agent_id, scopes, ttl_minutes } = request.body || {};
      if (!parent_token || !agent_id) {
        return reply.status(400).send({ error: 'Bad Request', message: 'parent_token and agent_id are required' });
      }
      const { serialized } = delegateToken(parent_token, {
        agentId: agent_id,
        scopes,
        ttlMinutes: ttl_minutes,
      });
      return reply.send({ child_token: serialized });
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // POST /map/swarms/:id/revoke — Revoke a swarm's token (admin-only)
  fastify.post<{ Params: { id: string } }>('/map/swarms/:id/revoke', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      if (opts.config.mapHub.trustModel !== 'verified') {
        return reply.status(400).send({ error: 'Bad Request', message: 'Token revocation requires verified trust model' });
      }
      const swarm = mapDal.findSwarmById(request.params.id);
      if (!swarm) {
        return reply.status(404).send({ error: 'Not Found', message: 'Swarm not found' });
      }
      revokeToken(request.params.id);
      return reply.send({ message: `Token for swarm ${request.params.id} has been revoked` });
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // ==========================================================================
  // Node Routes
  // ==========================================================================

  // POST /map/nodes -- Register an agent node
  fastify.post('/map/nodes', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = RegisterNodeSchema.parse(request.body);
      const node = registerNode(request.agent!.id, body);
      return reply.status(201).send(node);
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // GET /map/nodes -- Discover nodes
  fastify.get<{
    Querystring: {
      hive_id?: string;
      swarm_id?: string;
      role?: string;
      state?: string;
      tags?: string;
      visibility?: string;
      limit?: string;
      offset?: string;
    };
  }>('/map/nodes', {
    preHandler: [optionalAuthMiddleware],
  }, async (request, reply) => {
    const { hive_id, swarm_id, role, state, tags, visibility, limit, offset } = request.query;

    const result = mapDal.discoverNodes({
      hive_id,
      swarm_id,
      role,
      state: state as 'registered' | 'active' | 'busy' | 'idle' | 'suspended' | 'stopped' | 'failed' | undefined,
      tags: tags ? tags.split(',') : undefined,
      visibility: visibility as 'public' | 'hive-only' | 'swarm-only' | undefined,
      limit: parseIntParam(limit, MAX_PAGE_SIZE),
      offset: parseIntParam(offset),
    });

    return reply.send(result);
  });

  // GET /map/nodes/:id -- Get node details
  fastify.get<{ Params: { id: string } }>('/map/nodes/:id', {
    preHandler: [optionalAuthMiddleware],
  }, async (request, reply) => {
    const node = mapDal.findNodeById(request.params.id);
    if (!node) {
      return reply.status(404).send({ error: 'Not Found', message: 'Node not found' });
    }
    return reply.send(node);
  });

  // PUT /map/nodes/:id -- Update node
  fastify.put<{ Params: { id: string } }>('/map/nodes/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const node = mapDal.findNodeById(request.params.id);
      if (!node) {
        return reply.status(404).send({ error: 'Not Found', message: 'Node not found' });
      }

      if (!mapDal.isSwarmOwner(node.swarm_id, request.agent!.id)) {
        throw new MapHubError('NOT_SWARM_OWNER', 'You do not own the swarm this node belongs to');
      }

      const body = UpdateNodeSchema.parse(request.body);
      const oldState = node.state;
      const updated = mapDal.updateNode(request.params.id, body);

      // Broadcast node_state_changed on state transitions
      if (updated && updated.state !== oldState) {
        const event = {
          type: 'node_state_changed' as const,
          data: {
            node_id: updated.id,
            swarm_id: node.swarm_id,
            map_agent_id: node.map_agent_id,
            old_state: oldState,
            new_state: updated.state,
            needs_attention: ['idle', 'stopped', 'failed'].includes(updated.state),
          },
        };
        broadcastToChannel(`map:swarm:${node.swarm_id}`, event);
        broadcastToChannel('global', event);
      }

      return reply.send(updated);
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // DELETE /map/nodes/:id -- Deregister node
  fastify.delete<{ Params: { id: string } }>('/map/nodes/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const node = mapDal.findNodeById(request.params.id);
      if (!node) {
        return reply.status(404).send({ error: 'Not Found', message: 'Node not found' });
      }

      if (!mapDal.isSwarmOwner(node.swarm_id, request.agent!.id)) {
        throw new MapHubError('NOT_SWARM_OWNER', 'You do not own the swarm this node belongs to');
      }

      mapDal.deleteNode(request.params.id);
      return reply.status(204).send();
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // ==========================================================================
  // Peer Discovery Routes
  // ==========================================================================

  // GET /map/peers/:swarmId -- Get peer list for a swarm
  fastify.get<{ Params: { swarmId: string } }>('/map/peers/:swarmId', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      if (!mapDal.isSwarmOwner(request.params.swarmId, request.agent!.id)) {
        throw new MapHubError('NOT_SWARM_OWNER', 'You do not own this swarm');
      }

      const peerList = getPeerList(request.params.swarmId);
      return reply.send(peerList);
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // ==========================================================================
  // Pre-auth Key Routes (admin only)
  // ==========================================================================

  // POST /map/preauth-keys -- Create pre-auth key
  fastify.post('/map/preauth-keys', {
    preHandler: adminAuth,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = CreatePreauthKeySchema.parse(request.body);
      // When called via X-Admin-Key there is no authenticated agent.
      // `created_by` is a nullable FK — pass null rather than inventing a
      // sentinel id the agents table doesn't contain.
      const createdBy = request.agent?.id ?? null;
      const result = mapDal.createPreauthKey(createdBy, body);

      return reply.status(201).send({
        id: result.key.id,
        key: result.plaintext_key,
        hive_id: result.key.hive_id,
        uses_left: result.key.uses_left,
        expires_at: result.key.expires_at,
        created_at: result.key.created_at,
      });
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // GET /map/preauth-keys -- List pre-auth keys
  fastify.get<{
    Querystring: { hive_id?: string; limit?: string; offset?: string };
  }>('/map/preauth-keys', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    const { hive_id, limit, offset } = request.query;

    const keys = mapDal.listPreauthKeys({
      hive_id,
      limit: parseIntParam(limit, MAX_PAGE_SIZE),
      offset: parseIntParam(offset),
    });

    // Don't return key_hash in the response
    const data = keys.map((k) => ({
      id: k.id,
      hive_id: k.hive_id,
      uses_left: k.uses_left,
      expires_at: k.expires_at,
      created_by: k.created_by,
      created_at: k.created_at,
      last_used_at: k.last_used_at,
    }));

    return reply.send({ data });
  });

  // DELETE /map/preauth-keys/:id -- Revoke pre-auth key
  fastify.delete<{ Params: { id: string } }>('/map/preauth-keys/:id', {
    preHandler: adminAuth,
  }, async (request, reply) => {
    try {
      const deleted = mapDal.deletePreauthKey(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Not Found', message: 'Pre-auth key not found' });
      }
      return reply.status(204).send();
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // ==========================================================================
  // Stats
  // ==========================================================================

  // GET /map/stats -- Hub statistics
  fastify.get('/map/stats', {
    preHandler: [optionalAuthMiddleware],
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const stats = mapDal.getMapStats();
    return reply.send(stats);
  });

  // ==========================================================================
  // Live Connection Health
  // ==========================================================================

  // GET /map/connections -- Live connection health for all inbound swarms
  fastify.get('/map/connections', {
    preHandler: [authMiddleware],
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const connections = getAllConnectionHealth(opts.config.mapHub.missedPongsBeforeTerminate);
    const outbound = getSyncListenerStatus();

    return reply.send({
      inbound: connections,
      outbound: outbound.connections,
      summary: {
        inbound_count: connections.length,
        outbound_connected: outbound.connected,
        outbound_reconnecting: outbound.reconnecting,
        degraded: connections.filter(c => c.missedPongs > 0).length,
      },
    });
  });

  // GET /map/connections/:swarmId -- Live connection health for a specific swarm
  fastify.get<{ Params: { swarmId: string } }>('/map/connections/:swarmId', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const health = getConnectionHealth(request.params.swarmId, opts.config.mapHub.missedPongsBeforeTerminate);

    if (!health) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No active inbound connection for this swarm',
      });
    }

    return reply.send(health);
  });

  // ==========================================================================
  // Mesh Network Routes (provider-agnostic)
  // ==========================================================================

  // POST /map/swarms/:id/network -- Provision mesh network access for a swarm
  fastify.post<{
    Params: { id: string };
  }>('/map/swarms/:id/network', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const swarm = mapDal.findSwarmById(request.params.id);
      if (!swarm) {
        return reply.status(404).send({ error: 'Not Found', message: 'Swarm not found' });
      }

      if (!mapDal.isSwarmOwner(request.params.id, request.agent!.id)) {
        throw new MapHubError('NOT_SWARM_OWNER', 'You do not own this swarm');
      }

      const body = NetworkProvisionSchema.parse(request.body);

      const provider = (request.server as unknown as { networkProvider?: import('../../network/types.js').NetworkProvider }).networkProvider;
      if (!provider || !provider.isReady()) {
        return reply.status(503).send({
          error: 'NETWORK_NOT_AVAILABLE',
          message: 'No mesh network provider configured. Set network.provider in config.',
        });
      }

      const result = await provider.createAuthKey({
        hiveName: body.hive_name,
        swarmName: swarm.name || request.params.id,
        reusable: body.reusable,
        ephemeral: body.ephemeral,
        expirationHours: body.expiration_hours,
      });

      return reply.status(201).send(result);
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // GET /map/swarms/:id/network -- Get mesh network info for a swarm
  fastify.get<{ Params: { id: string } }>('/map/swarms/:id/network', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      if (!mapDal.isSwarmOwner(request.params.id, request.agent!.id)) {
        throw new MapHubError('NOT_SWARM_OWNER', 'You do not own this swarm');
      }

      const swarm = mapDal.findSwarmById(request.params.id);
      if (!swarm) {
        return reply.status(404).send({ error: 'Not Found', message: 'Swarm not found' });
      }

      const provider = (request.server as unknown as { networkProvider?: import('../../network/types.js').NetworkProvider }).networkProvider;
      if (!provider || !provider.isReady()) {
        // Return whatever we have stored in the DB
        return reply.send({
          provider: 'none',
          headscale_node_id: swarm.headscale_node_id,
          tailscale_ips: swarm.tailscale_ips,
          tailscale_dns_name: swarm.tailscale_dns_name,
        });
      }

      const hives = mapDal.getSwarmHiveNames(request.params.id);
      const deviceInfo = await provider.getDeviceInfo(swarm.name, hives[0]);

      // Update stored network info if we got data from the provider
      if (deviceInfo.id) {
        mapDal.updateSwarm(request.params.id, {
          headscale_node_id: deviceInfo.id,
          tailscale_ips: deviceInfo.ips,
          tailscale_dns_name: deviceInfo.dnsName || undefined,
        });
      }

      return reply.send({
        provider: provider.type,
        ...deviceInfo,
      });
    } catch (error) {
      return handleMapError(error, reply);
    }
  });

  // GET /map/network/status -- Check network provider status and connectivity
  fastify.get('/map/network/status', {
    preHandler: [optionalAuthMiddleware],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const provider = (request.server as unknown as { networkProvider?: import('../../network/types.js').NetworkProvider }).networkProvider;

    if (!provider || provider.type === 'none') {
      return reply.send({
        provider: 'none',
        ready: false,
        message: 'No mesh network provider configured.',
      });
    }

    const connectivity = await provider.checkConnectivity();

    return reply.send({
      provider: provider.type,
      ready: provider.isReady(),
      serverUrl: provider.getServerUrl(),
      connectivity,
    });
  });

  // GET /map/connected-task-graphs -- Live task graphs from connected swarms
  fastify.get('/map/connected-task-graphs', {
    preHandler: [authMiddleware],
  }, async (_request, reply) => {
    const { getAllInbound } = await import('../../map/connection-registry.js');
    const graphs: Array<{
      swarm_id: string;
      swarm_name: string | null;
      location_hash: string | null;
      path: string | null;
      connected_at: string;
      capabilities: Record<string, unknown> | null;
    }> = [];

    for (const [swarmId, conn] of getAllInbound()) {
      if (conn.ws.readyState !== 1) continue; // only OPEN connections
      if (!conn.defaultTaskGraph && !conn.capabilities?.tasks) continue;

      let swarmName: string | null = null;
      try {
        const swarm = mapDal.findSwarmById(swarmId);
        swarmName = swarm?.name ?? null;
      } catch { /* non-critical */ }

      graphs.push({
        swarm_id: swarmId,
        swarm_name: swarmName,
        location_hash: conn.defaultTaskGraph?.location_hash ?? null,
        path: conn.defaultTaskGraph?.path ?? null,
        connected_at: conn.connectedAt,
        capabilities: (conn.capabilities as Record<string, unknown>) ?? null,
      });
    }

    return reply.send({ data: graphs });
  });
}
