import { FastifyRequest, FastifyReply } from 'fastify';
import { findAgentByApiKey, updateAgentLastSeen } from '../../db/dal/agents.js';
import type { Agent } from '../../types.js';

// Extend FastifyRequest to include agent
declare module 'fastify' {
  interface FastifyRequest {
    agent?: Agent;
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
      message: 'Invalid Authorization header format. Use: Bearer <api_key>',
    });
  }

  const agent = await findAgentByApiKey(token);

  if (!agent) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid API key',
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

  const agent = await findAgentByApiKey(token);

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
