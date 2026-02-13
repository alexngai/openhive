/**
 * Sync Protocol Routes
 *
 * Peer-to-peer sync endpoints exposed at /sync/v1/.
 * These are called by other instances, not by end users.
 */

import { FastifyInstance } from 'fastify';
import { HandshakeSchema, PushEventsSchema, PullEventsQuerySchema, HeartbeatSchema } from '../schemas/sync.js';
import { getSyncService } from '../../sync/service.js';
import { syncAuthMiddleware, syncRateLimitMiddleware } from '../../sync/middleware.js';
import * as syncGroupsDAL from '../../db/dal/sync-groups.js';
import * as syncPeersDAL from '../../db/dal/sync-peers.js';
import * as hivesDAL from '../../db/dal/hives.js';

export async function syncProtocolRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /sync/v1/handshake — initiate peer connection
  // GAP-2: When handshake_secret is configured, require it via X-Handshake-Secret header
  fastify.post('/handshake', async (request, reply) => {
    const syncService = getSyncService();
    if (!syncService) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'Sync is not enabled' });
    }

    // GAP-2: Verify pre-shared key if configured
    const requiredSecret = syncService.getHandshakeSecret();
    if (requiredSecret) {
      const providedSecret = request.headers['x-handshake-secret'] as string | undefined;
      if (!providedSecret || providedSecret !== requiredSecret) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'Invalid or missing handshake secret',
        });
      }
    }

    const parseResult = HandshakeSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation Error', details: parseResult.error.issues });
    }

    try {
      const response = syncService.handleHandshake(parseResult.data);
      return reply.send(response);
    } catch (err) {
      return reply.status(404).send({ error: 'Not Found', message: (err as Error).message });
    }
  });

  // GET /sync/v1/groups/:id/events — pull events (authenticated)
  fastify.get<{ Params: { id: string } }>('/groups/:id/events', { preHandler: [syncAuthMiddleware, syncRateLimitMiddleware] }, async (request, reply) => {
    const syncService = getSyncService();
    if (!syncService) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'Sync is not enabled' });
    }

    const parseResult = PullEventsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation Error', details: parseResult.error.issues });
    }

    try {
      const response = syncService.handleEventsPull(
        request.params.id,
        parseResult.data.since,
        parseResult.data.limit
      );
      return reply.send(response);
    } catch (err) {
      return reply.status(404).send({ error: 'Not Found', message: (err as Error).message });
    }
  });

  // POST /sync/v1/groups/:id/events — push events (authenticated)
  fastify.post<{ Params: { id: string } }>('/groups/:id/events', { preHandler: [syncAuthMiddleware, syncRateLimitMiddleware] }, async (request, reply) => {
    const syncService = getSyncService();
    if (!syncService) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'Sync is not enabled' });
    }

    const parseResult = PushEventsSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation Error', details: parseResult.error.issues });
    }

    try {
      const response = syncService.handleIncomingEvents(
        request.params.id,
        parseResult.data.events
      );
      return reply.send(response);
    } catch (err) {
      return reply.status(404).send({ error: 'Not Found', message: (err as Error).message });
    }
  });

  // POST /sync/v1/heartbeat — peer health check + gossip exchange (authenticated)
  fastify.post('/heartbeat', { preHandler: [syncAuthMiddleware] }, async (request, reply) => {
    const syncService = getSyncService();
    if (!syncService) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'Sync is not enabled' });
    }

    const parseResult = HeartbeatSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation Error', details: parseResult.error.issues });
    }

    try {
      const response = syncService.handleHeartbeat(parseResult.data);
      return reply.send(response);
    } catch (err) {
      return reply.status(500).send({ error: 'Internal Error', message: (err as Error).message });
    }
  });

  // GET /sync/v1/groups/:id/status — sync group health check (authenticated)
  fastify.get<{ Params: { id: string } }>('/groups/:id/status', { preHandler: [syncAuthMiddleware] }, async (request, reply) => {
    const syncGroup = syncGroupsDAL.findSyncGroupById(request.params.id);
    if (!syncGroup) {
      return reply.status(404).send({ error: 'Not Found', message: 'Sync group not found' });
    }

    const hive = hivesDAL.findHiveById(syncGroup.hive_id);
    const peers = syncPeersDAL.listSyncPeers(syncGroup.id);

    return reply.send({
      sync_group_id: syncGroup.id,
      hive_name: hive?.name,
      local_seq: syncGroup.seq,
      peers: peers.map(p => ({
        id: p.id,
        peer_swarm_id: p.peer_swarm_id,
        status: p.status,
        last_seq_sent: p.last_seq_sent,
        last_seq_received: p.last_seq_received,
      })),
    });
  });

  // POST /sync/v1/groups/:id/leave — leave sync group (authenticated)
  fastify.post<{ Params: { id: string } }>('/groups/:id/leave', { preHandler: [syncAuthMiddleware] }, async (request, reply) => {
    const syncGroup = syncGroupsDAL.findSyncGroupById(request.params.id);
    if (!syncGroup) {
      return reply.status(404).send({ error: 'Not Found', message: 'Sync group not found' });
    }

    // Find the requesting peer by their auth identity
    const peerId = (request as Record<string, unknown>).syncPeerId as string | undefined;
    if (peerId) {
      // Remove this peer from the sync group
      const peers = syncPeersDAL.listSyncPeers(syncGroup.id);
      for (const p of peers) {
        if (p.id === peerId || p.peer_swarm_id === peerId) {
          syncPeersDAL.deleteSyncPeer(p.id);
          break;
        }
      }
    }

    return reply.send({ status: 'left', sync_group_id: syncGroup.id });
  });
}
