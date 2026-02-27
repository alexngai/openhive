/**
 * Event Routing API
 *
 * CRUD endpoints for post rules and event subscriptions.
 * Also exposes the delivery log for observability.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import * as eventsDAL from '../../db/dal/events.js';
import type { PostRuleThreadMode, EventFilters } from '../../events/types.js';

export async function eventsRoutes(fastify: FastifyInstance): Promise<void> {
  // All routes require authentication
  fastify.addHook('onRequest', authMiddleware);

  // ==========================================================================
  // Post Rules
  // ==========================================================================

  // GET /events/post-rules
  fastify.get('/events/post-rules', async (request: FastifyRequest, reply: FastifyReply) => {
    const { hive_id } = request.query as { hive_id?: string };
    const rules = eventsDAL.listPostRules(hive_id);
    return reply.send({ data: rules });
  });

  // POST /events/post-rules
  fastify.post('/events/post-rules', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      hive_id: string;
      source: string;
      event_types: string[];
      filters?: EventFilters;
      normalizer?: string;
      thread_mode?: PostRuleThreadMode;
      priority?: number;
    };

    if (!body.hive_id || !body.source || !body.event_types) {
      return reply.status(400).send({ error: 'hive_id, source, and event_types are required' });
    }

    const rule = eventsDAL.createPostRule({
      ...body,
      created_by: 'api',
    });

    return reply.status(201).send(rule);
  });

  // PUT /events/post-rules/:id
  fastify.put('/events/post-rules/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      source?: string;
      event_types?: string[];
      filters?: EventFilters | null;
      normalizer?: string;
      thread_mode?: PostRuleThreadMode;
      priority?: number;
      enabled?: boolean;
    };

    const rule = eventsDAL.updatePostRule(id, body);
    if (!rule) return reply.status(404).send({ error: 'Post rule not found' });
    return reply.send(rule);
  });

  // DELETE /events/post-rules/:id
  fastify.delete('/events/post-rules/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const deleted = eventsDAL.deletePostRule(id);
    if (!deleted) return reply.status(404).send({ error: 'Post rule not found' });
    return reply.status(204).send();
  });

  // ==========================================================================
  // Event Subscriptions
  // ==========================================================================

  // GET /events/subscriptions
  fastify.get('/events/subscriptions', async (request: FastifyRequest, reply: FastifyReply) => {
    const { hive_id, swarm_id } = request.query as { hive_id?: string; swarm_id?: string };
    const subs = eventsDAL.listSubscriptions({ hive_id, swarm_id });
    return reply.send({ data: subs });
  });

  // POST /events/subscriptions
  fastify.post('/events/subscriptions', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      hive_id: string;
      swarm_id?: string;
      source: string;
      event_types: string[];
      filters?: EventFilters;
      priority?: number;
    };

    if (!body.hive_id || !body.source || !body.event_types) {
      return reply.status(400).send({ error: 'hive_id, source, and event_types are required' });
    }

    const sub = eventsDAL.createSubscription({
      ...body,
      created_by: 'api',
    });

    return reply.status(201).send(sub);
  });

  // PUT /events/subscriptions/:id
  fastify.put('/events/subscriptions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      source?: string;
      event_types?: string[];
      filters?: EventFilters | null;
      priority?: number;
      enabled?: boolean;
    };

    const sub = eventsDAL.updateSubscription(id, body);
    if (!sub) return reply.status(404).send({ error: 'Subscription not found' });
    return reply.send(sub);
  });

  // DELETE /events/subscriptions/:id
  fastify.delete('/events/subscriptions/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const deleted = eventsDAL.deleteSubscription(id);
    if (!deleted) return reply.status(404).send({ error: 'Subscription not found' });
    return reply.status(204).send();
  });

  // ==========================================================================
  // Delivery Log
  // ==========================================================================

  // GET /events/delivery-log
  fastify.get('/events/delivery-log', async (request: FastifyRequest, reply: FastifyReply) => {
    const { delivery_id, swarm_id, limit, offset } = request.query as {
      delivery_id?: string;
      swarm_id?: string;
      limit?: string;
      offset?: string;
    };

    const result = eventsDAL.getDeliveryLog({
      delivery_id,
      swarm_id,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    return reply.send(result);
  });
}
