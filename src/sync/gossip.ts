/**
 * Peer Gossip
 *
 * TTL-bounded peer exchange piggybacked on heartbeats.
 * Enables automatic mesh expansion from seed peers.
 */

import * as peerConfigsDAL from '../db/dal/sync-peer-configs.js';
import type { SyncPeer, GossipPeerInfo, SyncPeerConfig } from './types.js';

export interface GossipConfig {
  enabled: boolean;
  default_ttl: number;
  hub_peer_ttl: number;
  exchange_interval: number;
  max_gossip_peers: number;
  stale_timeout: number;
  max_failures: number;
}

/**
 * Build the gossip payload to share with a specific peer.
 * Only share peers that share hives with the target.
 * Decrement TTL on each hop.
 */
export function buildGossipPayload(
  targetPeer: SyncPeer,
  allPeers: SyncPeer[],
  config: GossipConfig
): GossipPeerInfo[] {
  if (!config.enabled) return [];

  const result: GossipPeerInfo[] = [];

  for (const peer of allPeers) {
    // Don't share the target peer with itself
    if (peer.sync_endpoint === targetPeer.sync_endpoint) continue;

    // Only share peers that share at least one hive with the target
    const overlappingHives = peer.shared_hives.filter(h => targetPeer.shared_hives.includes(h));
    if (overlappingHives.length === 0) continue;

    // Determine TTL based on source
    let ttl: number;
    if (peer.source === 'manual') {
      ttl = config.default_ttl;
    } else if (peer.source === 'hub') {
      ttl = config.hub_peer_ttl;
    } else {
      // Gossip-learned peers: use stored TTL, already decremented
      const peerConfig = peerConfigsDAL.findPeerConfigByEndpoint(peer.sync_endpoint);
      ttl = peerConfig?.gossip_ttl ?? 0;
    }

    // Don't propagate if TTL is 0 or less
    if (ttl <= 0) continue;

    result.push({
      sync_endpoint: peer.sync_endpoint,
      name: peer.name,
      shared_hives: overlappingHives,
      signing_key: peer.signing_key,
      ttl: ttl - 1, // Decrement TTL before sharing
    });

    if (result.length >= config.max_gossip_peers) break;
  }

  return result;
}

/**
 * Process incoming gossip peers from a heartbeat response.
 * Returns list of newly discovered peer endpoints (for auto-handshake).
 */
export function processGossipPeers(
  incomingPeers: GossipPeerInfo[],
  fromPeerEndpoint: string,
  config: GossipConfig
): string[] {
  if (!config.enabled) return [];

  const newPeers: string[] = [];

  for (const incoming of incomingPeers) {
    // Skip if TTL is expired
    if (incoming.ttl < 0) continue;

    // Check if we already know this peer
    const existing = peerConfigsDAL.findPeerConfigByEndpoint(incoming.sync_endpoint);

    if (existing) {
      // Don't overwrite manual or hub peers
      if (existing.source === 'manual' || existing.source === 'hub') continue;

      // Update gossip-sourced peer if needed
      peerConfigsDAL.upsertPeerConfig({
        name: incoming.name,
        sync_endpoint: incoming.sync_endpoint,
        shared_hives: incoming.shared_hives,
        signing_key: incoming.signing_key,
        is_manual: false,
        source: 'gossip',
        gossip_ttl: incoming.ttl,
        discovered_via: fromPeerEndpoint,
      });
    } else {
      // New peer discovered via gossip
      peerConfigsDAL.createPeerConfig({
        name: incoming.name,
        sync_endpoint: incoming.sync_endpoint,
        shared_hives: incoming.shared_hives,
        signing_key: incoming.signing_key,
        is_manual: false,
        source: 'gossip',
        gossip_ttl: incoming.ttl,
        discovered_via: fromPeerEndpoint,
      });

      newPeers.push(incoming.sync_endpoint);
    }
  }

  return newPeers;
}

/** Remove gossip-sourced peers that are unresponsive */
export function cleanupStaleGossipPeers(config: GossipConfig): number {
  return peerConfigsDAL.cleanupStaleGossipPeers(config.stale_timeout, config.max_failures);
}
