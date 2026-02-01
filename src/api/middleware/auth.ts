import { FastifyRequest, FastifyReply } from 'fastify';
import { findAgentByApiKey, findAgentById, updateAgentLastSeen } from '../../db/dal/agents.js';
import type { Agent } from '../../types.js';

// Extend FastifyRequest to include agent
declare module 'fastify' {
  interface FastifyRequest {
    agent?: Agent;
  }
}

/**
 * Try to authenticate using JWT token
 * Returns the agent if successful, null otherwise
 */
async function tryJwtAuth(request: FastifyRequest): Promise<Agent | null> {
  try {
    // Check if JWT is registered
    if (typeof request.jwtVerify !== 'function') {
      return null;
    }

    await request.jwtVerify();
    const payload = request.user as { id: string } | undefined;

    if (!payload?.id) {
      return null;
    }

    const agent = findAgentById(payload.id);
    return agent;
  } catch {
    return null;
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
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

  // First try API key authentication (for agents)
  let agent = await findAgentByApiKey(token);

  // If API key fails, try JWT authentication (for humans)
  if (!agent) {
    agent = await tryJwtAuth(request);
  }

  if (!agent) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid authentication token',
    });
  }

  // Update last seen (fire and forget)
  updateAgentLastSeen(agent.id);

  // Attach agent to request
  request.agent = agent;
}

export async function optionalAuthMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    return;
  }

  const [scheme, token] = authHeader.split(' ');

  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return;
  }

  // First try API key authentication
  let agent = await findAgentByApiKey(token);

  // If API key fails, try JWT authentication
  if (!agent) {
    agent = await tryJwtAuth(request);
  }

  if (agent) {
    updateAgentLastSeen(agent.id);
    request.agent = agent;
  }
}

export function requireVerified(
  request: FastifyRequest,
  reply: FastifyReply
): void {
  if (!request.agent?.is_verified) {
    reply.status(403).send({
      error: 'Forbidden',
      message: 'This action requires a verified account',
    });
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
