/**
 * Sync Middleware
 *
 * Authentication and access control for sync protocol endpoints.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { getDatabase } from '../db/index.js';

/**
 * Verify sync token from Authorization header against known peers.
 * Used for peer-to-peer sync protocol endpoints.
 */
export async function syncAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Missing Authorization header. Provide a sync token.',
    });
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Invalid Authorization header format. Use: Bearer <sync_token>',
    });
  }

  const db = getDatabase();

  // Look up sync token in peer configs
  const peerConfig = db.prepare(
    "SELECT id, name, status FROM sync_peer_configs WHERE sync_token = ? AND status IN ('active', 'pending')"
  ).get(token) as { id: string; name: string; status: string } | undefined;

  if (peerConfig) {
    (request as Record<string, unknown>).syncPeerId = peerConfig.id;
    (request as Record<string, unknown>).syncPeerName = peerConfig.name;
    return;
  }

  // Also check hive_sync_peers for tokens set during handshake
  const syncPeer = db.prepare(
    "SELECT id, peer_swarm_id, status FROM hive_sync_peers WHERE sync_token = ? AND status IN ('active', 'backfilling')"
  ).get(token) as { id: string; peer_swarm_id: string; status: string } | undefined;

  if (syncPeer) {
    (request as Record<string, unknown>).syncPeerId = syncPeer.id;
    (request as Record<string, unknown>).syncPeerName = syncPeer.peer_swarm_id;
    return;
  }

  return reply.status(401).send({
    error: 'Unauthorized',
    message: 'Invalid or expired sync token',
  });
}

/**
 * Restrict sync endpoints to Tailscale IP range (100.64.0.0/10).
 * Configurable: can be disabled for hubless/internet mode.
 */
export async function meshOnlyMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const ip = request.ip;

  // Check if IP is in Tailscale CGNAT range (100.64.0.0/10)
  if (!isTailscaleIP(ip)) {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Sync endpoints are restricted to mesh network access only',
    });
  }
}

function isTailscaleIP(ip: string): boolean {
  // Tailscale uses 100.64.0.0/10 CGNAT range
  if (ip.startsWith('100.')) {
    const second = parseInt(ip.split('.')[1], 10);
    return second >= 64 && second <= 127;
  }
  // Also allow localhost for development
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** Per-peer rate limit state (GAP-7: periodic cleanup to prevent memory leak) */
const peerRequestCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 1000; // 1 second
const RATE_LIMIT_MAX = 100; // 100 events/second per peer
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000; // Clean up stale entries every 60s

// GAP-7: Periodically remove expired entries to prevent unbounded Map growth
let rateLimitCleanupTimer: NodeJS.Timeout | null = null;

function ensureRateLimitCleanup(): void {
  if (rateLimitCleanupTimer) return;
  rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of peerRequestCounts) {
      if (now > entry.resetAt) {
        peerRequestCounts.delete(key);
      }
    }
  }, RATE_LIMIT_CLEANUP_INTERVAL_MS);
  // Allow the process to exit even if this timer is running
  rateLimitCleanupTimer.unref();
}

export async function syncRateLimitMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  ensureRateLimitCleanup();

  // Use authenticated peer identity if available, fall back to IP
  const peerId = (request as Record<string, unknown>).syncPeerId as string || request.ip;
  const now = Date.now();

  let entry = peerRequestCounts.get(peerId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    peerRequestCounts.set(peerId, entry);
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return reply.status(429).send({
      error: 'Too Many Requests',
      message: 'Sync rate limit exceeded',
    });
  }
}
