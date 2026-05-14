/**
 * Event Routing API
 *
 * CRUD endpoints for post rules and event subscriptions.
 * Also exposes the delivery log for observability.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import * as eventsDAL from '../../db/dal/events.js';
import { routeEvent } from '../../events/router.js';
import { getChannelSubscriberCount, getConnectedClients } from '../../realtime/index.js';
import type { EventFilters, NormalizedEvent, EventMetadata } from '../../events/types.js';

export async function eventsRoutes(fastify: FastifyInstance): Promise<void> {
  // All routes require authentication
  fastify.addHook('onRequest', authMiddleware);

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

  // ==========================================================================
  // Test / Debug — synthesize an event and route it through the system.
  // Used by the Events page Live tab + operators investigating routing.
  // Admin-gated.
  // ==========================================================================

  // POST /events/test
  fastify.post('/events/test', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.agent?.is_admin) {
      return reply.status(403).send({ error: 'Admin required' });
    }
    const body = (request.body ?? {}) as {
      source?: string;
      event_type?: string;
      action?: string;
      metadata?: Partial<EventMetadata>;
      raw_payload?: Record<string, unknown>;
    };
    const event: NormalizedEvent = {
      source: body.source || 'test',
      event_type: body.event_type || 'synthetic.ping',
      action: body.action,
      delivery_id: `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      metadata: body.metadata ?? {},
      raw_payload: body.raw_payload ?? { synthetic: true, fired_by: request.agent.id },
      timestamp: new Date().toISOString(),
    };
    const liveSubscribers = getChannelSubscriberCount('events:live');
    const result = routeEvent(event);
    return reply.send({
      ok: true,
      delivery_id: event.delivery_id,
      matched_subs: result.deliveries.length,
      swarms_notified: result.swarms_notified,
      debug: {
        connected_ws_clients: getConnectedClients(),
        events_live_subscribers: liveSubscribers,
      },
    });
  });
}
