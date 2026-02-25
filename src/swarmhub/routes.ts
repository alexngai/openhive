/**
 * SwarmHub Connector Routes
 *
 * Internal API endpoints for interacting with the SwarmHub bridge.
 * These allow swarms and agents running on this hive to request
 * credentials and inspect the SwarmHub connection status.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware } from '../api/middleware/auth.js';
import type { SwarmHubConnector } from './connector.js';

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
}
