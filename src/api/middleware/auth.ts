import { FastifyRequest, FastifyReply } from 'fastify';
import { findAgentById, findAgentByApiKey, updateAgentLastSeen } from '../../db/dal/agents.js';
import { validateSwarmHubToken, isJwksInitialized } from '../../auth/jwks.js';
import { findOrCreateSwarmHubAgent } from '../../db/dal/agents.js';
import { validateIngestKey } from '../../db/dal/ingest-keys.js';
import type { Agent, IngestKeyScope } from '../../types.js';

// Extend FastifyRequest to include agent
declare module 'fastify' {
  interface FastifyRequest {
    agent?: Agent;
    ingestKeyScopes?: IngestKeyScope[];
  }
}

// Local auth mode: when set, requests without auth headers are auto-authenticated
let localAgent: Agent | null = null;

export function setLocalAgent(agent: Agent | null): void {
  localAgent = agent;
}

// ============================================================================
// Scope enforcement
// ============================================================================

/**
 * Map a request URL path to the scope required to access it.
 * Returns null if the path doesn't require a specific scope (public routes).
 */
function getRequiredScope(url: string): IngestKeyScope | null {
  // Strip /api/v1/ prefix and get the first path segment
  const match = url.match(/^\/api\/v1\/([^/?]+)/);
  if (!match) return null;

  const segment = match[1];
  switch (segment) {
    case 'map':
    case 'coordination':
      return 'map';
    case 'sessions':
      return 'sessions';
    case 'resources':
    case 'resource-content':
    case 'memory-banks':
      return 'resources';
    case 'admin':
      return 'admin';
    default:
      // agents, hives, posts, comments, feed, search, auth, etc.
      // These require '*' scope for ingest keys
      return '*';
  }
}

/**
 * Check whether a set of scopes grants access to the required scope.
 */
function scopeAllows(scopes: IngestKeyScope[], required: IngestKeyScope | null): boolean {
  if (!required) return true;
  if (scopes.includes('*')) return true;
  if (required === '*') return false; // Only wildcard grants access to unscoped routes
  return scopes.includes(required);
}

// ============================================================================
// Auth middleware
// ============================================================================

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

  // 0. Try ingest key authentication (SHA-256, O(1) lookup)
  if (token.startsWith('ohk_')) {
    const ingestKey = validateIngestKey(token);
    if (ingestKey) {
      const agent = findAgentById(ingestKey.agent_id);
      if (agent) {
        // Check scope before granting access
        const required = getRequiredScope(request.url);
        if (!scopeAllows(ingestKey.scopes, required)) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: `Ingest key does not have the '${required}' scope required for this endpoint`,
          });
        }
        updateAgentLastSeen(agent.id);
        request.agent = agent;
        request.ingestKeyScopes = ingestKey.scopes;
        return;
      }
    }
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid or expired ingest key',
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

  // 0. Try ingest key authentication (SHA-256, O(1) lookup)
  if (token.startsWith('ohk_')) {
    const ingestKey = validateIngestKey(token);
    if (ingestKey) {
      const agent = findAgentById(ingestKey.agent_id);
      if (agent) {
        const required = getRequiredScope(request.url);
        if (scopeAllows(ingestKey.scopes, required)) {
          updateAgentLastSeen(agent.id);
          request.agent = agent;
          request.ingestKeyScopes = ingestKey.scopes;
        }
      }
    }
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
