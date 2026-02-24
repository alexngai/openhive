/**
 * Bridge API Routes
 *
 * CRUD for bridge configs, start/stop lifecycle,
 * channel mapping management, and proxy agent listing.
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import * as bridgeDAL from '../../db/dal/bridge.js';
import { encryptCredentials } from '../../bridge/credentials.js';
import type { BridgeManager } from '../../bridge/manager.js';
import type { Config } from '../../config.js';
import type {
  BridgePlatform,
  TransportMode,
  BridgeDirection,
  ThreadMode,
} from '../../bridge/types.js';

interface BridgeRoutesOptions {
  config: Config;
  bridgeManager?: BridgeManager;
}

const VALID_PLATFORMS: BridgePlatform[] = ['slack', 'discord', 'telegram', 'whatsapp', 'matrix'];
const VALID_TRANSPORT_MODES: TransportMode[] = ['outbound', 'webhook'];
const VALID_DIRECTIONS: BridgeDirection[] = ['inbound', 'outbound', 'bidirectional'];
const VALID_THREAD_MODES: ThreadMode[] = ['post_per_message', 'single_thread', 'explicit_only'];

function requireBridgeManager(bridgeManager?: BridgeManager): BridgeManager {
  if (!bridgeManager) {
    const err = new Error('Bridge feature is not enabled');
    (err as any).statusCode = 503;
    throw err;
  }
  return bridgeManager;
}

function redactCredentials(bridge: ReturnType<typeof bridgeDAL.getBridge>) {
  if (!bridge) return null;
  const { credentials_encrypted, ...rest } = bridge;
  return { ...rest, credentials_redacted: true };
}

export async function bridgesRoutes(
  fastify: FastifyInstance,
  options: BridgeRoutesOptions,
): Promise<void> {
  const { config, bridgeManager } = options;

  // ── List bridges ──
  fastify.get('/bridges', { preHandler: authMiddleware }, async (_request, reply) => {
    const bridges = bridgeDAL.listBridges();
    return reply.send({
      data: bridges.map(redactCredentials),
    });
  });

  // ── Get bridge by ID ──
  fastify.get<{ Params: { id: string } }>(
    '/bridges/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bridge = bridgeDAL.getBridge(request.params.id);
      if (!bridge) {
        return reply.status(404).send({ error: 'Not Found', message: 'Bridge not found' });
      }

      const status = bridgeManager?.getBridgeStatus(bridge.id);

      return reply.send({
        ...redactCredentials(bridge),
        runtime_status: status?.status || 'disconnected',
        runtime_error: status?.error,
      });
    },
  );

  // ── Create bridge ──
  fastify.post('/bridges', { preHandler: authMiddleware }, async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    // Validate required fields
    const name = body.name as string;
    const platform = body.platform as BridgePlatform;
    const transport_mode = body.transport_mode as TransportMode;
    const credentials = body.credentials as Record<string, string> | undefined;

    if (!name || typeof name !== 'string') {
      return reply.status(400).send({ error: 'Validation Error', message: 'name is required' });
    }
    if (!platform || !VALID_PLATFORMS.includes(platform)) {
      return reply.status(400).send({
        error: 'Validation Error',
        message: `platform must be one of: ${VALID_PLATFORMS.join(', ')}`,
      });
    }
    if (!transport_mode || !VALID_TRANSPORT_MODES.includes(transport_mode)) {
      return reply.status(400).send({
        error: 'Validation Error',
        message: `transport_mode must be one of: ${VALID_TRANSPORT_MODES.join(', ')}`,
      });
    }
    if (!credentials || typeof credentials !== 'object') {
      return reply.status(400).send({
        error: 'Validation Error',
        message: 'credentials object is required',
      });
    }

    // Check name uniqueness
    if (bridgeDAL.getBridgeByName(name)) {
      return reply.status(409).send({ error: 'Conflict', message: 'A bridge with this name already exists' });
    }

    // Encrypt credentials
    const encryptionKey = config.bridge.credentialEncryptionKey;
    if (!encryptionKey) {
      return reply.status(500).send({
        error: 'Configuration Error',
        message: 'Bridge credential encryption key not configured',
      });
    }

    const encrypted = encryptCredentials(credentials, encryptionKey);

    const bridge = bridgeDAL.createBridge({
      name,
      platform,
      transport_mode,
      credentials_encrypted: encrypted,
      owner_agent_id: request.agent!.id,
    });

    return reply.status(201).send(redactCredentials(bridge));
  });

  // ── Update bridge ──
  fastify.patch<{ Params: { id: string } }>(
    '/bridges/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bridge = bridgeDAL.getBridge(request.params.id);
      if (!bridge) {
        return reply.status(404).send({ error: 'Not Found', message: 'Bridge not found' });
      }

      // Only owner or admin can update
      if (bridge.owner_agent_id !== request.agent!.id && !request.agent!.is_admin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Only the bridge owner can update it' });
      }

      const body = request.body as Record<string, unknown>;
      const updates: Parameters<typeof bridgeDAL.updateBridge>[1] = {};

      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name) {
          return reply.status(400).send({ error: 'Validation Error', message: 'name must be a non-empty string' });
        }
        const existing = bridgeDAL.getBridgeByName(body.name as string);
        if (existing && existing.id !== bridge.id) {
          return reply.status(409).send({ error: 'Conflict', message: 'A bridge with this name already exists' });
        }
        updates.name = body.name as string;
      }

      if (body.transport_mode !== undefined) {
        if (!VALID_TRANSPORT_MODES.includes(body.transport_mode as TransportMode)) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: `transport_mode must be one of: ${VALID_TRANSPORT_MODES.join(', ')}`,
          });
        }
        updates.transport_mode = body.transport_mode as TransportMode;
      }

      if (body.credentials !== undefined) {
        const encryptionKey = config.bridge.credentialEncryptionKey;
        if (!encryptionKey) {
          return reply.status(500).send({
            error: 'Configuration Error',
            message: 'Bridge credential encryption key not configured',
          });
        }
        updates.credentials_encrypted = encryptCredentials(
          body.credentials as Record<string, string>,
          encryptionKey,
        );
      }

      const updated = bridgeDAL.updateBridge(bridge.id, updates);
      return reply.send(redactCredentials(updated));
    },
  );

  // ── Delete bridge ──
  fastify.delete<{ Params: { id: string } }>(
    '/bridges/:id',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bridge = bridgeDAL.getBridge(request.params.id);
      if (!bridge) {
        return reply.status(404).send({ error: 'Not Found', message: 'Bridge not found' });
      }

      if (bridge.owner_agent_id !== request.agent!.id && !request.agent!.is_admin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Only the bridge owner can delete it' });
      }

      // Stop bridge if running
      if (bridgeManager) {
        await bridgeManager.stopBridge(bridge.id);
      }

      bridgeDAL.deleteBridge(bridge.id);
      return reply.status(204).send();
    },
  );

  // ── Start bridge ──
  fastify.post<{ Params: { id: string } }>(
    '/bridges/:id/start',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const mgr = requireBridgeManager(bridgeManager);

      const bridge = bridgeDAL.getBridge(request.params.id);
      if (!bridge) {
        return reply.status(404).send({ error: 'Not Found', message: 'Bridge not found' });
      }

      if (bridge.owner_agent_id !== request.agent!.id && !request.agent!.is_admin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Only the bridge owner can start it' });
      }

      try {
        await mgr.startBridge(bridge.id);
        const status = mgr.getBridgeStatus(bridge.id);
        return reply.send({ status: status?.status, message: 'Bridge started' });
      } catch (err) {
        return reply.status(400).send({
          error: 'Start Failed',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ── Stop bridge ──
  fastify.post<{ Params: { id: string } }>(
    '/bridges/:id/stop',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const mgr = requireBridgeManager(bridgeManager);

      const bridge = bridgeDAL.getBridge(request.params.id);
      if (!bridge) {
        return reply.status(404).send({ error: 'Not Found', message: 'Bridge not found' });
      }

      if (bridge.owner_agent_id !== request.agent!.id && !request.agent!.is_admin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Only the bridge owner can stop it' });
      }

      await mgr.stopBridge(bridge.id);
      return reply.send({ status: 'disconnected', message: 'Bridge stopped' });
    },
  );

  // ── Channel Mappings ──

  fastify.get<{ Params: { id: string } }>(
    '/bridges/:id/mappings',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bridge = bridgeDAL.getBridge(request.params.id);
      if (!bridge) {
        return reply.status(404).send({ error: 'Not Found', message: 'Bridge not found' });
      }

      const mappings = bridgeDAL.getChannelMappings(bridge.id);
      return reply.send({ data: mappings });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/bridges/:id/mappings',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bridge = bridgeDAL.getBridge(request.params.id);
      if (!bridge) {
        return reply.status(404).send({ error: 'Not Found', message: 'Bridge not found' });
      }

      if (bridge.owner_agent_id !== request.agent!.id && !request.agent!.is_admin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Only the bridge owner can add mappings' });
      }

      const body = request.body as Record<string, unknown>;
      const platform_channel_id = body.platform_channel_id as string;
      const hive_name = body.hive_name as string;

      if (!platform_channel_id || typeof platform_channel_id !== 'string') {
        return reply.status(400).send({ error: 'Validation Error', message: 'platform_channel_id is required' });
      }
      if (!hive_name || typeof hive_name !== 'string') {
        return reply.status(400).send({ error: 'Validation Error', message: 'hive_name is required' });
      }

      const direction = (body.direction as BridgeDirection) || undefined;
      if (direction && !VALID_DIRECTIONS.includes(direction)) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: `direction must be one of: ${VALID_DIRECTIONS.join(', ')}`,
        });
      }

      const thread_mode = (body.thread_mode as ThreadMode) || undefined;
      if (thread_mode && !VALID_THREAD_MODES.includes(thread_mode)) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: `thread_mode must be one of: ${VALID_THREAD_MODES.join(', ')}`,
        });
      }

      const mapping = bridgeDAL.addChannelMapping(bridge.id, {
        platform_channel_id,
        platform_channel_name: body.platform_channel_name as string | undefined,
        hive_name,
        direction,
        thread_mode,
      });

      // Reload mappings if bridge is running
      bridgeManager?.reloadMappings(bridge.id);

      return reply.status(201).send(mapping);
    },
  );

  fastify.delete<{ Params: { id: string; mid: string } }>(
    '/bridges/:id/mappings/:mid',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bridge = bridgeDAL.getBridge(request.params.id);
      if (!bridge) {
        return reply.status(404).send({ error: 'Not Found', message: 'Bridge not found' });
      }

      if (bridge.owner_agent_id !== request.agent!.id && !request.agent!.is_admin) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Only the bridge owner can remove mappings' });
      }

      const mapping = bridgeDAL.getChannelMapping(request.params.mid);
      if (!mapping || mapping.bridge_id !== bridge.id) {
        return reply.status(404).send({ error: 'Not Found', message: 'Mapping not found' });
      }

      bridgeDAL.deleteChannelMapping(mapping.id);

      // Reload mappings if bridge is running
      bridgeManager?.reloadMappings(bridge.id);

      return reply.status(204).send();
    },
  );

  // ── Proxy Agents ──

  fastify.get<{ Params: { id: string } }>(
    '/bridges/:id/agents',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const bridge = bridgeDAL.getBridge(request.params.id);
      if (!bridge) {
        return reply.status(404).send({ error: 'Not Found', message: 'Bridge not found' });
      }

      const agents = bridgeDAL.listProxyAgents(bridge.id);
      return reply.send({ data: agents });
    },
  );
}
