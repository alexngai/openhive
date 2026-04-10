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
import { authMiddleware, optionalAuthMiddleware } from '../middleware/auth.js';
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
import { getAllConnectionHealth, getConnectionHealth } from '../../map/connection-registry.js';
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
  const requireAdmin = (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
    const adminKey = request.headers['x-admin-key'];
    if (!opts.config.admin.key || adminKey !== opts.config.admin.key) {
      reply.status(403).send({ error: 'Forbidden', message: 'Admin key required' });
      return;
    }
    done();
  };

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
    Querystring: { hive_id?: string; status?: string; limit?: string; offset?: string };
  }>('/map/swarms', {
    preHandler: [optionalAuthMiddleware],
  }, async (request, reply) => {
    const { hive_id, status, limit, offset } = request.query;

    const result = mapDal.listSwarms({
      hive_id,
      status,
      limit: parseIntParam(limit, MAX_PAGE_SIZE),
      offset: parseIntParam(offset),
    });

    // Enrich with hive names
    const data = result.data.map((s) => {
      const hives = mapDal.getSwarmHiveNames(s.id);
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
    return reply.send(pub);
  });

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
      broadcastToChannel('map:discovery', {
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
    preHandler: [authMiddleware, requireAdmin],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = CreatePreauthKeySchema.parse(request.body);
      const result = mapDal.createPreauthKey(request.agent!.id, body);

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
    preHandler: [authMiddleware, requireAdmin],
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
    preHandler: [authMiddleware, requireAdmin],
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
