import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as agentsDAL from '../../db/dal/agents.js';
import { toPublicAgent } from '../../db/dal/agents.js';
import { authMiddleware } from '../middleware/auth.js';

const CodeExchangeSchema = z.object({
  code: z.string().min(1),
  redirect_uri: z.string().url(),
});

interface AuthConfig {
  authMode?: 'local' | 'swarmhub';
  swarmhubApiUrl?: string;
  swarmhubOAuthClientId?: string;
  swarmhubOAuthClientSecret?: string;
}

export async function authRoutes(
  fastify: FastifyInstance,
  opts: { config: AuthConfig }
): Promise<void> {

  // GET /auth/mode — public, returns auth mode and SwarmHub OAuth URL
  fastify.get('/auth/mode', async (_request, reply) => {
    const mode = opts.config.authMode || 'swarmhub';

    if (mode === 'local') {
      const agent = agentsDAL.findAgentByName('local');
      return reply.send({
        mode: 'local',
        agent: agent ? toPublicAgent(agent) : null,
      });
    }

    return reply.send({
      mode: 'swarmhub',
      oauth: {
        authorize_url: `${opts.config.swarmhubApiUrl}/oauth/authorize`,
        client_id: opts.config.swarmhubOAuthClientId,
      },
    });
  });

  // POST /auth/swarmhub/exchange — exchange OAuth code for token
  fastify.post('/auth/swarmhub/exchange', async (request, reply) => {
    if (opts.config.authMode === 'local') {
      return reply.status(400).send({ error: 'Not available in local mode' });
    }

    const parseResult = CodeExchangeSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { code, redirect_uri } = parseResult.data;

    try {
      const tokenRes = await fetch(
        `${opts.config.swarmhubApiUrl}/oauth/token`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            redirect_uri,
            client_id: opts.config.swarmhubOAuthClientId,
            client_secret: opts.config.swarmhubOAuthClientSecret,
          }),
          signal: AbortSignal.timeout(10_000),
        }
      );

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text().catch(() => '');
        fastify.log.error({ status: tokenRes.status, body: errBody }, 'SwarmHub token exchange failed');
        return reply.status(401).send({
          error: 'OAuth Error',
          message: 'Failed to exchange authorization code',
        });
      }

      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        token_type: string;
        user?: {
          id: string;
          name: string;
          email?: string;
          avatar_url?: string;
        };
      };

      // Find or create local agent record if user info is provided
      let agent: ReturnType<typeof agentsDAL.findAgentBySwarmHubUserId> = null;
      if (tokenData.user) {
        agent = agentsDAL.findOrCreateSwarmHubAgent({
          swarmhubUserId: tokenData.user.id,
          name: tokenData.user.name,
          email: tokenData.user.email,
          avatarUrl: tokenData.user.avatar_url,
        });
      }

      return reply.send({
        token: tokenData.access_token,
        agent: agent ? toPublicAgent(agent) : undefined,
        expires_in: tokenData.expires_in,
      });

    } catch (error) {
      fastify.log.error(error, 'SwarmHub OAuth exchange failed');
      return reply.status(500).send({
        error: 'OAuth Error',
        message: 'Failed to complete authentication',
      });
    }
  });

  // GET /auth/me — get current authenticated user
  fastify.get(
    '/auth/me',
    { preHandler: authMiddleware },
    async (request, reply) => {
      if (!request.agent) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
      return reply.send(toPublicAgent(request.agent));
    }
  );
}
