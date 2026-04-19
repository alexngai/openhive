import { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { findAgentById, findAgentByApiKey, updateAgentLastSeen } from '../../db/dal/agents.js';
import { validateSwarmHubToken, isJwksInitialized } from '../../auth/jwks.js';
import { findOrCreateSwarmHubAgent } from '../../db/dal/agents.js';
import { validateIngestKey } from '../../db/dal/ingest-keys.js';
import type { Agent, IngestKeyScope } from '../../types.js';

/**
 * Constant-time compare for the admin-key header.
 *
 * Headers arrive as `string | string[] | undefined` off Fastify — normalize
 * to a single string before comparing, reject arrays (suspicious), and
 * short-circuit on length mismatch so `timingSafeEqual` doesn't throw.
 */
function adminKeyMatches(
  header: string | string[] | undefined,
  configured: string | undefined,
): boolean {
  if (!configured) return false;
  if (typeof header !== 'string') return false;
  if (header.length !== configured.length) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(configured);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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
    role: payload.role,
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

/**
 * Config surface `createAdminAuth` reads. Keeping the shape explicit (instead
 * of accepting `Config` wholesale) documents exactly what the middleware cares
 * about.
 */
interface AdminAuthConfig {
  admin: { key?: string; trustLocalMode?: boolean };
  auth: { mode: string };
}

/**
 * Create an auth preHandler that accepts either:
 *   1. An `X-Admin-Key` header matching `config.admin.key` (constant-time), OR
 *   2. An explicit Bearer token from an admin agent.
 *
 * IMPORTANT: unlike `authMiddleware`, this does NOT fall through to the
 * local-auth auto-agent when no credentials are present. Admin routes
 * must always require an explicit credential, even in `auth: 'local'`
 * mode — otherwise a headless hub exposed on any network is effectively
 * open to admin operations.
 *
 * **Escape hatch**: setting `config.admin.trustLocalMode = true` reverts
 * this to the pre-hardening behavior IN LOCAL AUTH MODE ONLY — the
 * auto-authenticated admin local agent is treated as a valid credential.
 * Intended for localhost-bound single-operator hubs where typing the admin
 * key on every CLI call is friction. Loud warning logged at boot.
 *
 * Use in place of `[authMiddleware, requireAdmin]` on routes that should
 * be reachable from headless operator CLIs.
 */
export function createAdminAuth(config: AdminAuthConfig) {
  // Flag is gated on `auth: 'local'`. In token/swarmhub mode there's no
  // auto-auth agent to trust, so the flag becomes a no-op — evaluated once
  // at factory time to avoid re-checking per request.
  const trustLocal = !!config.admin.trustLocalMode && config.auth.mode === 'local';

  return async function adminAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (adminKeyMatches(request.headers['x-admin-key'], config.admin.key)) {
      return;
    }

    // Trusted-local-mode bypass: when enabled, allow no-credential requests
    // through the standard `authMiddleware` path so the local admin agent
    // satisfies `requireAdmin`. The gate is still `requireAdmin`, so a
    // non-admin local agent wouldn't pass — but in practice the init
    // wizard stamps the local agent as admin.
    if (trustLocal) {
      await authMiddleware(request, reply);
      if (reply.sent) return;
      requireAdmin(request, reply);
      return;
    }

    // Require an explicit Bearer token. Don't let local-mode auto-auth
    // silently upgrade an unauthenticated request to admin.
    if (!request.headers.authorization) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Admin key or Bearer token required',
      });
    }

    await authMiddleware(request, reply);
    if (reply.sent) return;
    requireAdmin(request, reply);
  };
}

/**
 * Like `authMiddleware` but additionally accepts a valid `X-Admin-Key` as a
 * skip-auth escape hatch for headless operator tooling. When the admin key
 * matches, the handler runs without `request.agent` being populated —
 * callers that rely on `request.agent` for anything other than admin-gating
 * should use `createAdminAuth` instead.
 *
 * Unlike `createAdminAuth`, this DOES fall through to local-auth auto-agent
 * when no credentials are provided, preserving the "any authenticated agent
 * can read" semantics of routes like `GET /sync/peers` and `GET /dispatches`.
 */
export function createAuthOrAdminKey(config: { admin: { key?: string } }) {
  return async function authOrAdminKey(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (adminKeyMatches(request.headers['x-admin-key'], config.admin.key)) {
      return;
    }
    await authMiddleware(request, reply);
    if (reply.sent) return;
  };
}
