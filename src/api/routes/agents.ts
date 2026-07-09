import { FastifyInstance } from 'fastify';
import { RegisterAgentSchema, UpdateAgentSchema } from '../schemas/agents.js';
import { authMiddleware, optionalAuthMiddleware, createAdminAuth } from '../middleware/auth.js';
import * as agentsDAL from '../../db/dal/agents.js';
import type { Config } from '../../config.js';

export async function agentsRoutes(fastify: FastifyInstance, options: { config: Config }): Promise<void> {
  const { config } = options;
  const registrationMode = config.auth.registration;

  // `POST /agents/register` gating (config.auth.registration):
  //   - 'admin' (default): X-Admin-Key or an admin agent required; new agents
  //     are auto-verified because an operator vouched for them.
  //   - 'open': unauthenticated self-registration; new agents start UNVERIFIED.
  //   - 'disabled': the endpoint refuses outright.
  // In 'admin' mode we attach the admin preHandler (loopback/trust-aware, so
  // `openhive init` on localhost still works); other modes attach none and
  // resolve the outcome inside the handler.
  const registerPreHandler =
    registrationMode === 'admin' ? [createAdminAuth(config)] : [];

  // Register a new agent
  fastify.post('/agents/register', { preHandler: registerPreHandler }, async (request, reply) => {
    if (registrationMode === 'disabled') {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Agent registration is disabled on this instance',
      });
    }

    const parseResult = RegisterAgentSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const { name, description, metadata } = parseResult.data;

    const existing = agentsDAL.findAgentByName(name);
    if (existing) {
      return reply.status(409).send({
        error: 'Conflict',
        message: 'An agent with this name already exists',
      });
    }

    const { agent, apiKey } = await agentsDAL.createAgent({
      name,
      description,
      metadata,
    });

    // Auto-verify only when an operator registered the agent (admin mode). In
    // open mode the agent must be verified through a separate trusted path.
    if (registrationMode === 'admin') {
      agentsDAL.updateAgent(agent.id, {
        is_verified: true,
        verification_status: 'verified',
      });
    }

    const finalAgent = agentsDAL.findAgentById(agent.id)!;

    return reply.status(201).send({
      agent: agentsDAL.toPublicAgent(finalAgent),
      api_key: apiKey,
      verification: { status: finalAgent.verification_status },
    });
  });

  // Get current agent profile
  fastify.get('/agents/me', { preHandler: authMiddleware }, async (request, reply) => {
    const agent = request.agent!;
    return reply.send({
      ...agentsDAL.toPublicAgent(agent),
      is_admin: agent.is_admin,
      verification_status: agent.verification_status,
    });
  });

  // NOTE: `POST /agents/me/token` (the Phase 2 token-exchange endpoint)
  // was retired in RFC v4. Agents no longer exchange their API key for
  // an agent-iam token; session scopes are resolved at `map/connect` and
  // the only tokens minted are delegated credentials via
  // `map/agents/spawn` (agent-to-agent) or `openhive admin onboard-token`
  // (operator bootstrap).

  // Update current agent profile
  fastify.patch('/agents/me', { preHandler: authMiddleware }, async (request, reply) => {
    const parseResult = UpdateAgentSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.issues,
      });
    }

    const updated = agentsDAL.updateAgent(request.agent!.id, parseResult.data);
    return reply.send(agentsDAL.toPublicAgent(updated!));
  });

  // Bulk-resolve agent public profiles by id. Used by chat-surface
  // enrichment to look up display name + avatar_url for the senders of
  // user/supervisor turns in a single round-trip. Returns an object keyed
  // by id so missing ids are implicit (omitted from the map).
  //
  // Must be declared BEFORE `/agents/:name` — Fastify matches literal
  // segments first, so `/agents/by-ids` wouldn't collide, but keeping the
  // order explicit avoids future ambiguity if the `:name` route's matcher
  // ever becomes more permissive.
  fastify.get<{ Querystring: { ids?: string } }>(
    '/agents/by-ids',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const raw = request.query.ids ?? '';
      const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length > 100) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: 'ids parameter is limited to 100 entries',
        });
      }
      const agents = agentsDAL.findAgentsByIds(ids);
      const byId: Record<string, ReturnType<typeof agentsDAL.toPublicAgent>> = {};
      for (const a of agents) byId[a.id] = agentsDAL.toPublicAgent(a);
      return reply.send({ agents: byId });
    }
  );

  // Get agent by name
  fastify.get<{ Params: { name: string } }>(
    '/agents/:name',
    { preHandler: optionalAuthMiddleware },
    async (request, reply) => {
      const agent = agentsDAL.findAgentByName(request.params.name);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      return reply.send(agentsDAL.toPublicAgent(agent));
    }
  );
}
