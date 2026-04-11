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
    (request as unknown as Record<string, unknown>).syncPeerId = peerConfig.id;
    (request as unknown as Record<string, unknown>).syncPeerName = peerConfig.name;
    return;
  }

  // Also check hive_sync_peers for tokens set during handshake
  const syncPeer = db.prepare(
    "SELECT id, peer_swarm_id, status FROM hive_sync_peers WHERE sync_token = ? AND status IN ('active', 'backfilling')"
  ).get(token) as { id: string; peer_swarm_id: string; status: string } | undefined;

  if (syncPeer) {
    (request as unknown as Record<string, unknown>).syncPeerId = syncPeer.id;
    (request as unknown as Record<string, unknown>).syncPeerName = syncPeer.peer_swarm_id;
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

