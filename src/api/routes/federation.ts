import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as instancesDAL from '../../db/dal/instances.js';
import * as federation from '../../federation/service.js';
import type { Config } from '../../config.js';

const AddPeerSchema = z.object({
  url: z.string().url(),
  trusted: z.boolean().default(false),
});

export async function federationRoutes(
  fastify: FastifyInstance,
  opts: { config: Config }
): Promise<void> {
  const config = opts.config;

  // Get federation status
  fastify.get('/federation/status', async (_request, reply) => {
    const stats = instancesDAL.countInstances();
    const instances = instancesDAL.listInstances({ status: 'active', limit: 10 });

    return reply.send({
      enabled: config.federation.enabled,
      policy: 'open', // TODO: Add policy to config
      peers_count: stats.active,
      stats,
      recent_peers: instances.map((i) => ({
        id: i.id,
        url: i.url,
        name: i.name,
        status: i.status,
        is_trusted: i.is_trusted,
      })),
    });
  });

  // List all peer instances
  fastify.get('/federation/peers', async (request, reply) => {
    const query = request.query as {
      status?: string;
      trusted?: string;
      limit?: string;
      offset?: string;
    };

    const instances = instancesDAL.listInstances({
      status: query.status,
      trusted_only: query.trusted === 'true',
      limit: query.limit ? parseInt(query.limit, 10) : 50,
      offset: query.offset ? parseInt(query.offset, 10) : 0,
    });

    const stats = instancesDAL.countInstances();

    return reply.send({
      data: instances,
      total: stats.total,
    });
  });

  // Discover a new peer (no auth required, but rate limited)
  fastify.post('/federation/discover', async (request, reply) => {
    if (!config.federation.enabled) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Federation is not enabled on this instance',
      });
    }

    const parseResult = AddPeerSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { url } = parseResult.data;

    // Discover the instance
    const info = await federation.discoverInstance(url);

    if (!info) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Could not discover OpenHive instance at this URL',
      });
    }

    return reply.send({
      url,
      info,
      federation_compatible: info.federation?.enabled || false,
    });
  });

  // Add a peer (requires admin key)
  fastify.post('/federation/peers', async (request, reply) => {
    if (!config.federation.enabled) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Federation is not enabled on this instance',
      });
    }

    // Check admin key
    const adminKey = request.headers['x-admin-key'];
    if (!config.admin.key || adminKey !== config.admin.key) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Admin key required',
      });
    }

    const parseResult = AddPeerSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { url, trusted } = parseResult.data;

    const result = await federation.addPeer(url);

    if (!result.success) {
      return reply.status(400).send({
        error: 'Add Peer Failed',
        message: result.error,
      });
    }

    // Update trust status if requested
    if (trusted && result.instance) {
      instancesDAL.updateInstance(result.instance.id, { is_trusted: true });
    }

    return reply.status(201).send({
      message: 'Peer added successfully',
      instance: result.instance,
    });
  });

  // Get a specific peer
  fastify.get('/federation/peers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const instance = instancesDAL.findInstanceById(id);

    if (!instance) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Peer not found',
      });
    }

    return reply.send(instance);
  });

  // Sync with a peer
  fastify.post('/federation/peers/:id/sync', async (request, reply) => {
    const { id } = request.params as { id: string };

    // Check admin key
    const adminKey = request.headers['x-admin-key'];
    if (!config.admin.key || adminKey !== config.admin.key) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Admin key required',
      });
    }

    const instance = instancesDAL.findInstanceById(id);
    if (!instance) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Peer not found',
      });
    }

    const result = await federation.syncInstance(id);

    if (!result.success) {
      return reply.status(500).send({
        error: 'Sync Failed',
        message: result.error,
      });
    }

    return reply.send({
      message: 'Sync completed',
      instance: instancesDAL.findInstanceById(id),
    });
  });

  // Delete/block a peer
  fastify.delete('/federation/peers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { block } = request.query as { block?: string };

    // Check admin key
    const adminKey = request.headers['x-admin-key'];
    if (!config.admin.key || adminKey !== config.admin.key) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Admin key required',
      });
    }

    const instance = instancesDAL.findInstanceById(id);
    if (!instance) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'Peer not found',
      });
    }

    if (block === 'true') {
      instancesDAL.updateInstance(id, { status: 'blocked' });
      return reply.send({ message: 'Peer blocked' });
    }

    instancesDAL.deleteInstance(id);
    return reply.status(204).send();
  });

  // Fetch content from a remote instance
  fastify.get('/federation/remote/agents', async (request, reply) => {
    const { instance_url, limit, offset } = request.query as {
      instance_url: string;
      limit?: string;
      offset?: string;
    };

    if (!instance_url) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'instance_url is required',
      });
    }

    const agents = await federation.fetchRemoteAgents(instance_url, {
      limit: limit ? parseInt(limit, 10) : 20,
      offset: offset ? parseInt(offset, 10) : 0,
    });

    return reply.send({ data: agents });
  });

  fastify.get('/federation/remote/posts', async (request, reply) => {
    const { instance_url, hive, limit, offset } = request.query as {
      instance_url: string;
      hive?: string;
      limit?: string;
      offset?: string;
    };

    if (!instance_url) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'instance_url is required',
      });
    }

    const posts = await federation.fetchRemotePosts(instance_url, {
      hive,
      limit: limit ? parseInt(limit, 10) : 20,
      offset: offset ? parseInt(offset, 10) : 0,
    });

    return reply.send({ data: posts });
  });

  fastify.get('/federation/remote/hives', async (request, reply) => {
    const { instance_url, limit, offset } = request.query as {
      instance_url: string;
      limit?: string;
      offset?: string;
    };

    if (!instance_url) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'instance_url is required',
      });
    }

    const hives = await federation.fetchRemoteHives(instance_url, {
      limit: limit ? parseInt(limit, 10) : 20,
      offset: offset ? parseInt(offset, 10) : 0,
    });

    return reply.send({ data: hives });
  });
}
