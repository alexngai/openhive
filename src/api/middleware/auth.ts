import { FastifyRequest, FastifyReply } from 'fastify';
import { findAgentByApiKey, updateAgentLastSeen } from '../../db/dal/agents.js';
import { validateSwarmHubToken, isJwksInitialized } from '../../auth/jwks.js';
import { findOrCreateSwarmHubAgent } from '../../db/dal/agents.js';
import type { Agent } from '../../types.js';

// Extend FastifyRequest to include agent
declare module 'fastify' {
  interface FastifyRequest {
    agent?: Agent;
  }
}

// Local auth mode: when set, requests without auth headers are auto-authenticated
let localAgent: Agent | null = null;

export function setLocalAgent(agent: Agent | null): void {
  localAgent = agent;
}

/**
 * Try to authenticate using a SwarmHub JWT token (JWKS validation).
 * Returns the agent if successful, null otherwise.
 */
async function trySwarmHubAuth(token: string): Promise<Agent | null> {
  if (!isJwksInitialized()) {
    return null;
  }

  const payload = await validateSwarmHubToken(token);
  if (!payload?.sub) {
    return null;
  }

  return findOrCreateSwarmHubAgent({
    swarmhubUserId: payload.sub,
    name: payload.name,
    email: payload.email,
    avatarUrl: payload.avatar_url,
  });
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    if (localAgent) {
      updateAgentLastSeen(localAgent.id);
      request.agent = localAgent;
      return;
    }

    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Missing Authorization header',
    });
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid Authorization header format. Use: Bearer <token>',
    });
  }

  // 1. Try API key authentication (for agents/bots)
  let agent = await findAgentByApiKey(token);

  // 2. Try SwarmHub JWT authentication (for humans via OAuth)
  if (!agent) {
    agent = await trySwarmHubAuth(token);
  }

  if (!agent) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid authentication token',
    });
  }

  updateAgentLastSeen(agent.id);
  request.agent = agent;
}

export async function optionalAuthMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    if (localAgent) {
      updateAgentLastSeen(localAgent.id);
      request.agent = localAgent;
    }
    return;
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return;
  }

  // 1. Try API key authentication
  let agent = await findAgentByApiKey(token);

  // 2. Try SwarmHub JWT authentication
  if (!agent) {
    agent = await trySwarmHubAuth(token);
  }

  if (agent) {
    updateAgentLastSeen(agent.id);
    request.agent = agent;
  }
}

export function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): void {
  if (!request.agent?.is_admin) {
    reply.status(403).send({
      error: 'Forbidden',
      message: 'Admin access required',
    });
  }
}
