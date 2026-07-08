import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as agentsDAL from '../../db/dal/agents.js';
import { toPublicAgent } from '../../db/dal/agents.js';
import { authMiddleware } from '../middleware/auth.js';
import { createIngestKey } from '../../db/dal/ingest-keys.js';
import { isLoginRateLimited, recordFailedLogin, clearLoginAttempts } from '../middleware/login-rate-limit.js';
import type { IngestKeyScope } from '../../types.js';
import type { SwarmHubConnector } from '../../swarmhub/connector.js';

const CodeExchangeSchema = z.object({
  code: z.string().min(1),
  redirect_uri: z.string().url(),
});

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

interface AuthConfig {
  authMode?: 'local' | 'swarmhub';
  swarmhubApiUrl?: string;
  swarmhubOAuthClientId?: string;
  swarmhubOAuthClientSecret?: string;
}

export async function authRoutes(
  fastify: FastifyInstance,
  opts: { config: AuthConfig; swarmhubConnector?: SwarmHubConnector | null }
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

    // Primary source: connector (fetched from SwarmHub bridge at boot).
    // Fallback: static env var (legacy, will be removed).
    const clientId =
      opts.swarmhubConnector?.getOAuthClientId() ||
      opts.config.swarmhubOAuthClientId;

    return reply.send({
      mode: 'swarmhub',
      oauth: {
        authorize_url: `${opts.config.swarmhubApiUrl}/v1/oauth/authorize`,
        client_id: clientId,
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

    // Primary source: connector (fetched from SwarmHub bridge at boot).
    // Fallback: static env var (legacy, will be removed).
    const exchangeClientId =
      opts.swarmhubConnector?.getOAuthClientId() ||
      opts.config.swarmhubOAuthClientId;
    const clientSecret =
      opts.swarmhubConnector?.getOAuthClientSecret() ||
      opts.config.swarmhubOAuthClientSecret;

    if (!clientSecret) {
      fastify.log.error('No OAuth client secret available — cannot exchange code');
      return reply.status(500).send({
        error: 'Configuration Error',
        message: 'OAuth client secret not configured',
      });
    }

    try {
      const tokenRes = await fetch(
        `${opts.config.swarmhubApiUrl}/v1/oauth/token`,
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
            client_id: exchangeClientId,
            client_secret: clientSecret,
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

  // POST /auth/login — password login for self-hosted operators. Verifies a
  // human account's password and mints a short-lived, scoped ingest key
  // (ohk_...) that the existing auth middleware already validates + scope-gates,
  // so no new token type is introduced. Not available in swarmhub mode (which
  // authenticates via OAuth only), mirroring how /auth/swarmhub/exchange is
  // gated off in local mode.
  //
  // NOTE: in `local` auth mode the hub auto-authenticates unauthenticated
  // requests, so this login provides a *real scoped operator identity* and a
  // nicer UX over a trusted network (e.g. Tailscale) rather than a hard gate.
  // Rejecting unauthenticated requests (needed for public exposure) is a
  // separate hardening — see docs/design/remote-control.md.
  fastify.post('/auth/login', async (request, reply) => {
    if (opts.config.authMode === 'swarmhub') {
      return reply.status(400).send({ error: 'Not available in swarmhub mode' });
    }

    // Throttle password brute-forcing by client IP. A successful login clears
    // the counter, so a legitimate operator isn't locked out for a typo.
    const rateKey = request.ip;
    const rl = isLoginRateLimited(rateKey);
    if (rl.limited) {
      reply.header('Retry-After', String(rl.retryAfterSec));
      return reply.status(429).send({ error: 'Too many failed login attempts. Try again later.' });
    }

    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parsed.error.issues,
      });
    }
    const { username, password } = parsed.data;

    const agent =
      agentsDAL.findAgentByName(username) ?? agentsDAL.findAgentByEmail(username);
    // Uniform 401 whether the account is missing, has no password set, or the
    // password is wrong — don't leak which usernames exist.
    if (!agent || !agent.password_hash || !(await agentsDAL.verifyPassword(agent, password))) {
      recordFailedLogin(rateKey);
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    // The web console reaches non-categorized routes (/agents, /hives, ...)
    // which require the '*' ingest-key scope, so a console login needs '*'.
    // This does NOT grant admin routes: those are gated by requireAdmin on the
    // resolved agent's is_admin flag, independent of key scope — so a non-admin
    // operator gets full console access but still can't hit /admin/*. Mirrors
    // how local-mode auto-auth already runs as an admin local agent.
    const scopes: IngestKeyScope[] = ['*'];
    const expiresInHours = 24;
    const { plaintext_key } = createIngestKey(agent.id, {
      label: `login:${agent.name}`,
      agent_id: agent.id,
      scopes,
      expires_in_hours: expiresInHours,
    });

    clearLoginAttempts(rateKey);
    return reply.send({
      token: plaintext_key,
      agent: toPublicAgent(agent),
      expires_in: expiresInHours * 3600,
    });
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
