/**
 * SwarmHub Connector Routes
 *
 * Internal API endpoints for interacting with the SwarmHub bridge.
 * These allow swarms and agents running on this hive to request
 * credentials and inspect the SwarmHub connection status.
 *
 * Also handles webhook ingestion for events forwarded from SwarmHub
 * (Slack messages, GitHub events, etc.).
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../api/middleware/auth.js';
import { handleForwardedSlackEvent } from './webhook-handler.js';
import { normalize, routeEvent } from '../events/index.js';
import * as eventsDAL from '../db/dal/events.js';
import type { SwarmHubConnector } from './connector.js';
import type { ForwardedSlackEvent } from './types.js';
import type { EventFilters, PostRuleThreadMode } from '../events/types.js';

export async function swarmhubRoutes(
  fastify: FastifyInstance,
  options: { connector: SwarmHubConnector },
): Promise<void> {
  const { connector } = options;

  // Apply auth middleware to all routes
  fastify.addHook('onRequest', authMiddleware);

  // ==========================================================================
  // GET /swarmhub/status — Connector status
  // ==========================================================================

  fastify.get('/swarmhub/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const state = connector.getState();
    return reply.send({
      connected: connector.isConnected,
      status: state.status,
      identity: state.identity,
      last_health_check: state.lastHealthCheck,
      last_error: state.lastError,
      connected_at: state.connectedAt,
    });
  });

  // ==========================================================================
  // GET /swarmhub/repos — List mapped repositories
  // ==========================================================================

  fastify.get('/swarmhub/repos', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!connector.isConnected) {
      return reply.status(503).send({ error: 'SwarmHub connector not connected' });
    }

    try {
      const repos = await connector.getRepos();
      return reply.send(repos);
    } catch (err) {
      return reply.status(502).send({
        error: 'Failed to fetch repos from SwarmHub',
        message: (err as Error).message,
      });
    }
  });

  // ==========================================================================
  // POST /swarmhub/github-token — Request a scoped GitHub token
  // ==========================================================================

  fastify.post<{
    Body: {
      repositories?: string[];
      permissions?: Record<string, string>;
    };
  }>('/swarmhub/github-token', async (request: FastifyRequest<{
    Body: {
      repositories?: string[];
      permissions?: Record<string, string>;
    };
  }>, reply: FastifyReply) => {
    if (!connector.isConnected) {
      return reply.status(503).send({ error: 'SwarmHub connector not connected' });
    }

    try {
      const body = request.body as { repositories?: string[]; permissions?: Record<string, string> } | undefined;
      const token = await connector.getGitHubToken({
        repositories: body?.repositories,
        permissions: body?.permissions,
      });
      return reply.send(token);
    } catch (err) {
      const statusCode = (err as Error & { statusCode?: number }).statusCode || 502;
      return reply.status(statusCode).send({
        error: 'Failed to get GitHub token from SwarmHub',
        message: (err as Error).message,
      });
    }
  });

  // ==========================================================================
  // Slack Integration (SwarmHub as Slack App host)
  // ==========================================================================

  // GET /swarmhub/slack/installations — List Slack workspaces mapped to this hive
  fastify.get('/swarmhub/slack/installations', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!connector.isConnected) {
      return reply.status(503).send({ error: 'SwarmHub connector not connected' });
    }

    try {
      const installations = await connector.getSlackInstallations();
      return reply.send(installations);
    } catch (err) {
      return reply.status(502).send({
        error: 'Failed to fetch Slack installations from SwarmHub',
        message: (err as Error).message,
      });
    }
  });

  // POST /swarmhub/slack/credentials — Request Slack bot credentials
  fastify.post<{
    Body: { team_id?: string };
  }>('/swarmhub/slack/credentials', async (request: FastifyRequest<{
    Body: { team_id?: string };
  }>, reply: FastifyReply) => {
    if (!connector.isConnected) {
      return reply.status(503).send({ error: 'SwarmHub connector not connected' });
    }

    try {
      const body = request.body as { team_id?: string } | undefined;
      const creds = await connector.getSlackCredentials({
        team_id: body?.team_id,
      });
      return reply.send(creds);
    } catch (err) {
      const statusCode = (err as Error & { statusCode?: number }).statusCode || 502;
      return reply.status(statusCode).send({
        error: 'Failed to get Slack credentials from SwarmHub',
        message: (err as Error).message,
      });
    }
  });
}

/**
 * SwarmHub webhook ingestion routes.
 *
 * These are registered separately (no auth middleware) because SwarmHub
 * authenticates via the X-SwarmHub-Signature header, not Bearer tokens.
 */
export async function swarmhubWebhookRoutes(
  fastify: FastifyInstance,
  options: { connector: SwarmHubConnector },
): Promise<void> {
  const { connector } = options;

  // ==========================================================================
  // POST /webhooks/swarmhub — Receive forwarded events from SwarmHub
  // ==========================================================================

  fastify.post('/webhooks/swarmhub', async (request: FastifyRequest, reply: FastifyReply) => {
    // Verify the request is from SwarmHub using the forwarded header
    const forwardedBy = request.headers['x-swarmhub-forwarded'];
    if (!forwardedBy) {
      return reply.status(401).send({ error: 'Missing X-SwarmHub-Forwarded header' });
    }

    if (!connector.isConnected) {
      return reply.status(503).send({ error: 'SwarmHub connector not connected' });
    }

    const body = request.body as Record<string, unknown>;
    const source = body.source as string | undefined;

    if (source === 'slack') {
      // Slack events go through bridge inbound for channel mapping
      handleSlackWebhook(body, reply);

      // Also route through event system for MAP dispatch + post rules
      const normalized = normalize(
        'slack',
        body.event_type as string || 'unknown',
        body.event_id as string || `wh_${Date.now()}`,
        body,
      );
      routeEvent(normalized);
      return;
    }

    // All other sources (github, linear, etc.) go through the event router
    const normalized = normalize(
      source || 'unknown',
      body.event_type as string || 'unknown',
      body.delivery_id as string || body.event_id as string || `wh_${Date.now()}`,
      source === 'github'
        ? (body.payload as Record<string, unknown>) || body
        : body,
    );
    const result = routeEvent(normalized);

    return reply.status(200).send({
      ok: true,
      source: source || 'unknown',
      posts_created: result.posts_created,
      swarms_notified: result.swarms_notified,
    });
  });

  // ==========================================================================
  // POST /swarmhub/event-config — Receive event routing config from SwarmHub
  // ==========================================================================

  fastify.post('/swarmhub/event-config', async (request: FastifyRequest, reply: FastifyReply) => {
    const forwardedBy = request.headers['x-swarmhub-forwarded'];
    if (!forwardedBy) {
      return reply.status(401).send({ error: 'Missing X-SwarmHub-Forwarded header' });
    }

    const body = request.body as {
      post_rules?: Array<{
        hive_id: string;
        source: string;
        event_types: string[];
        filters?: EventFilters;
        normalizer?: string;
        thread_mode?: PostRuleThreadMode;
        priority?: number;
      }>;
      subscriptions?: Array<{
        hive_id: string;
        swarm_id?: string;
        source: string;
        event_types: string[];
        filters?: EventFilters;
        priority?: number;
      }>;
    };

    let rulesCreated = 0;
    let subsCreated = 0;

    if (body.post_rules) {
      for (const rule of body.post_rules) {
        eventsDAL.createPostRule({ ...rule, created_by: 'swarmhub' });
        rulesCreated++;
      }
    }

    if (body.subscriptions) {
      for (const sub of body.subscriptions) {
        eventsDAL.createSubscription({ ...sub, created_by: 'swarmhub' });
        subsCreated++;
      }
    }

    return reply.status(200).send({
      ok: true,
      post_rules_created: rulesCreated,
      subscriptions_created: subsCreated,
    });
  });
}

/**
 * Handle a Slack event forwarded from SwarmHub.
 */
function handleSlackWebhook(body: Record<string, unknown>, reply: FastifyReply) {
  const event: ForwardedSlackEvent = {
    team_id: body.team_id as string,
    event_type: body.event_type as string,
    event: body.event as ForwardedSlackEvent['event'],
    event_id: body.event_id as string | undefined,
  };

  if (!event.team_id || !event.event_type || !event.event) {
    return reply.status(400).send({
      error: 'Invalid forwarded Slack event',
      message: 'Missing team_id, event_type, or event payload',
    });
  }

  const result = handleForwardedSlackEvent(event);

  return reply.status(200).send({
    ok: true,
    source: 'slack',
    team_id: event.team_id,
    event_type: event.event_type,
    result: result
      ? { action: result.action, post_id: result.postId, comment_id: result.commentId }
      : { action: 'skipped' },
  });
}
