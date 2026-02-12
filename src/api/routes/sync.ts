import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/auth.js';
import { CreateSyncGroupSchema, CreatePeerConfigSchema, UpdatePeerConfigSchema } from '../schemas/sync.js';
import * as syncGroupsDAL from '../../db/dal/sync-groups.js';
import * as syncEventsDAL from '../../db/dal/sync-events.js';
import * as syncPeersDAL from '../../db/dal/sync-peers.js';
import * as syncPeerConfigsDAL from '../../db/dal/sync-peer-configs.js';
import * as hivesDAL from '../../db/dal/hives.js';
import { getSyncService } from '../../sync/service.js';
import type { Config } from '../../config.js';

export async function syncRoutes(fastify: FastifyInstance, opts: { config: Config }): Promise<void> {
  // ── Sync Group Management ─────────────────────────────────────

  // Create sync group for a hive
  fastify.post('/sync/groups', { preHandler: authMiddleware }, async (request, reply) => {
    const parseResult = CreateSyncGroupSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation Error', details: parseResult.error.issues });
    }

    const hive = hivesDAL.findHiveByName(parseResult.data.hive_name);
    if (!hive) {
      return reply.status(404).send({ error: 'Not Found', message: 'Hive not found' });
    }

    // Check ownership
    if (hive.owner_id !== request.agent!.id && !request.agent!.is_admin) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Only the hive owner can enable sync' });
    }

    const syncService = getSyncService();
    if (!syncService) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'Sync service is not enabled' });
    }

    try {
      const syncGroup = syncService.createSyncGroup(hive.id);
      return reply.status(201).send(syncGroup);
    } catch (err) {
      return reply.status(409).send({ error: 'Conflict', message: (err as Error).message });
    }
  });

  // List sync groups
  fastify.get('/sync/groups', { preHandler: authMiddleware }, async (request, reply) => {
    const groups = syncGroupsDAL.listSyncGroups();
    return reply.send({
      data: groups.map(g => {
        const hive = hivesDAL.findHiveById(g.hive_id);
        return {
          id: g.id,
          hive_name: hive?.name,
          sync_group_name: g.sync_group_name,
          seq: g.seq,
          created_at: g.created_at,
        };
      }),
    });
  });

  // Get sync group details + peer status
  fastify.get<{ Params: { id: string } }>('/sync/groups/:id', { preHandler: authMiddleware }, async (request, reply) => {
    const group = syncGroupsDAL.findSyncGroupById(request.params.id);
    if (!group) {
      return reply.status(404).send({ error: 'Not Found', message: 'Sync group not found' });
    }

    const hive = hivesDAL.findHiveById(group.hive_id);
    const peers = syncPeersDAL.listSyncPeers(group.id);
    const eventCount = syncEventsDAL.countEvents(group.id);

    return reply.send({
      id: group.id,
      hive_name: hive?.name,
      sync_group_name: group.sync_group_name,
      seq: group.seq,
      event_count: eventCount,
      created_at: group.created_at,
      peers: peers.map(p => ({
        id: p.id,
        peer_swarm_id: p.peer_swarm_id,
        peer_endpoint: p.peer_endpoint,
        status: p.status,
        last_seq_sent: p.last_seq_sent,
        last_seq_received: p.last_seq_received,
        lag: group.seq - p.last_seq_sent,
        last_sync_at: p.last_sync_at,
      })),
    });
  });

  // Delete sync group
  fastify.delete<{ Params: { id: string } }>('/sync/groups/:id', { preHandler: authMiddleware }, async (request, reply) => {
    const group = syncGroupsDAL.findSyncGroupById(request.params.id);
    if (!group) {
      return reply.status(404).send({ error: 'Not Found', message: 'Sync group not found' });
    }

    // Check ownership
    const hive = hivesDAL.findHiveById(group.hive_id);
    if (hive && hive.owner_id !== request.agent!.id && !request.agent!.is_admin) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Only the hive owner can delete the sync group' });
    }

    syncGroupsDAL.deleteSyncGroup(group.id);
    return reply.status(204).send();
  });

  // Browse event log (debug/admin)
  fastify.get<{ Params: { id: string } }>('/sync/groups/:id/events', { preHandler: authMiddleware }, async (request, reply) => {
    const group = syncGroupsDAL.findSyncGroupById(request.params.id);
    if (!group) {
      return reply.status(404).send({ error: 'Not Found', message: 'Sync group not found' });
    }

    const query = request.query as { limit?: string; offset?: string };
    const limit = parseInt(query.limit || '50', 10);
    const offset = parseInt(query.offset || '0', 10);

    const events = syncEventsDAL.listEvents(group.id, limit, offset);
    const total = syncEventsDAL.countEvents(group.id);

    return reply.send({
      data: events,
      total,
      limit,
      offset,
    });
  });

  // ── Sync Health ────────────────────────────────────────────────

  fastify.get('/sync/status', { preHandler: authMiddleware }, async (request, reply) => {
    const syncService = getSyncService();
    if (!syncService) {
      return reply.send({ enabled: false, groups: [] });
    }

    return reply.send({
      enabled: true,
      instance_id: syncService.getInstanceId(),
      groups: syncService.getSyncStatus(),
    });
  });

  // ── Peer Management ───────────────────────────────────────────

  // List configured peers
  fastify.get('/sync/peers', { preHandler: authMiddleware }, async (request, reply) => {
    const query = request.query as { source?: string; status?: string };
    const peers = syncPeerConfigsDAL.listPeerConfigs({
      source: query.source as 'manual' | 'hub' | 'gossip' | undefined,
      status: query.status as 'pending' | 'active' | 'error' | 'unreachable' | undefined,
    });

    return reply.send({ data: peers });
  });

  // Add a peer manually (admin only)
  fastify.post('/sync/peers', { preHandler: [authMiddleware, requireAdmin] }, async (request, reply) => {
    const parseResult = CreatePeerConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation Error', details: parseResult.error.issues });
    }

    const peer = syncPeerConfigsDAL.createPeerConfig({
      ...parseResult.data,
      is_manual: true,
      source: 'manual',
    });

    return reply.status(201).send(peer);
  });

  // Update peer config (admin only)
  fastify.patch<{ Params: { id: string } }>('/sync/peers/:id', { preHandler: [authMiddleware, requireAdmin] }, async (request, reply) => {
    const existing = syncPeerConfigsDAL.findPeerConfigById(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: 'Not Found', message: 'Peer not found' });
    }

    const parseResult = UpdatePeerConfigSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: 'Validation Error', details: parseResult.error.issues });
    }

    const updated = syncPeerConfigsDAL.updatePeerConfig(existing.id, parseResult.data);
    return reply.send(updated);
  });

  // Delete a peer (admin only)
  fastify.delete<{ Params: { id: string } }>('/sync/peers/:id', { preHandler: [authMiddleware, requireAdmin] }, async (request, reply) => {
    const existing = syncPeerConfigsDAL.findPeerConfigById(request.params.id);
    if (!existing) {
      return reply.status(404).send({ error: 'Not Found', message: 'Peer not found' });
    }

    syncPeerConfigsDAL.deletePeerConfig(existing.id);
    return reply.status(204).send();
  });

  // ── Advanced Operations ──────────────────────────────────────

  // Force resync from peers for a sync group (admin only)
  fastify.post<{ Params: { id: string } }>('/sync/groups/:id/resync', { preHandler: [authMiddleware, requireAdmin] }, async (request, reply) => {
    const syncService = getSyncService();
    if (!syncService) {
      return reply.status(503).send({ error: 'Service Unavailable', message: 'Sync service is not enabled' });
    }

    const group = syncGroupsDAL.findSyncGroupById(request.params.id);
    if (!group) {
      return reply.status(404).send({ error: 'Not Found', message: 'Sync group not found' });
    }

    const peers = syncPeersDAL.listActivePeers(group.id);
    const results: Array<{ peer: string; events_pulled: number; error?: string }> = [];

    for (const peer of peers) {
      try {
        const count = await syncService.pullFromPeer(group.id, peer.id);
        results.push({ peer: peer.peer_swarm_id, events_pulled: count });
      } catch (err) {
        results.push({ peer: peer.peer_swarm_id, events_pulled: 0, error: (err as Error).message });
      }
    }

    return reply.send({ results });
  });

  // Test connectivity to a peer (admin only)
  fastify.post<{ Params: { id: string } }>('/sync/peers/:id/test', { preHandler: [authMiddleware, requireAdmin] }, async (request, reply) => {
    const peerConfig = syncPeerConfigsDAL.findPeerConfigById(request.params.id);
    if (!peerConfig) {
      return reply.status(404).send({ error: 'Not Found', message: 'Peer not found' });
    }

    try {
      const start = Date.now();
      const response = await fetch(`${peerConfig.sync_endpoint}/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(peerConfig.sync_token ? { 'Authorization': `Bearer ${peerConfig.sync_token}` } : {}),
        },
        body: JSON.stringify({
          instance_id: getSyncService()?.getInstanceId() || 'test',
          seq_by_hive: {},
        }),
        signal: AbortSignal.timeout(10000),
      });
      const latencyMs = Date.now() - start;

      if (response.ok) {
        const data = await response.json();
        return reply.send({
          reachable: true,
          latency_ms: latencyMs,
          peer_instance_id: (data as Record<string, unknown>).instance_id,
          status: response.status,
        });
      } else {
        return reply.send({
          reachable: false,
          latency_ms: latencyMs,
          status: response.status,
          error: response.statusText,
        });
      }
    } catch (err) {
      return reply.send({
        reachable: false,
        error: (err as Error).message,
      });
    }
  });
}
