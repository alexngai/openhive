/**
 * Peer Resolver
 *
 * Abstracts peer discovery sources (manual, hub, gossip).
 */

import * as peerConfigsDAL from '../db/dal/sync-peer-configs.js';
import type { PeerResolver, SyncPeer, SyncPeerConfig, PeerSource } from './types.js';

type PeerStatusCallback = (peerId: string, status: string) => void;

// ── Manual Peer Resolver ────────────────────────────────────────

export class ManualPeerResolver implements PeerResolver {
  private callbacks: PeerStatusCallback[] = [];

  getPeersForHive(hiveName: string): SyncPeer[] {
    const configs = peerConfigsDAL.listPeerConfigs();
    return configs
      .filter(c => c.shared_hives.includes(hiveName))
      .map(configToSyncPeer);
  }

  getAllPeers(): SyncPeer[] {
    return peerConfigsDAL.listPeerConfigs().map(configToSyncPeer);
  }

  isPeerOnline(peerId: string): boolean {
    const config = peerConfigsDAL.findPeerConfigById(peerId);
    return config?.status === 'active';
  }

  onPeerStatusChange(cb: PeerStatusCallback): void {
    this.callbacks.push(cb);
  }

  notifyStatusChange(peerId: string, status: string): void {
    for (const cb of this.callbacks) {
      cb(peerId, status);
    }
  }
}

// ── Hub Peer Resolver ───────────────────────────────────────────

export class HubPeerResolver implements PeerResolver {
  private callbacks: PeerStatusCallback[] = [];

  getPeersForHive(hiveName: string): SyncPeer[] {
    // Hub resolver reads from cached hub peers in sync_peer_configs
    const configs = peerConfigsDAL.listPeerConfigs({ source: 'hub' });
    return configs
      .filter(c => c.shared_hives.includes(hiveName))
      .map(configToSyncPeer);
  }

  getAllPeers(): SyncPeer[] {
    return peerConfigsDAL.listPeerConfigs({ source: 'hub' }).map(configToSyncPeer);
  }

  isPeerOnline(peerId: string): boolean {
    const config = peerConfigsDAL.findPeerConfigById(peerId);
    return config?.status === 'active';
  }

  onPeerStatusChange(cb: PeerStatusCallback): void {
    this.callbacks.push(cb);
  }

  /** Cache hub-discovered peers into sync_peer_configs for hub-failure resilience */
  cachePeers(peers: Array<{ name: string; sync_endpoint: string; shared_hives: string[]; signing_key?: string | null }>): void {
    for (const peer of peers) {
      peerConfigsDAL.upsertPeerConfig({
        name: peer.name,
        sync_endpoint: peer.sync_endpoint,
        shared_hives: peer.shared_hives,
        signing_key: peer.signing_key,
        is_manual: false,
        source: 'hub',
      });
    }
  }
}

// ── Composite Peer Resolver ─────────────────────────────────────

export class CompositePeerResolver implements PeerResolver {
  private callbacks: PeerStatusCallback[] = [];
  private manualResolver: ManualPeerResolver;
  private hubResolver: HubPeerResolver | null;

  constructor(manualResolver: ManualPeerResolver, hubResolver: HubPeerResolver | null = null) {
    this.manualResolver = manualResolver;
    this.hubResolver = hubResolver;
  }

  /** Get peers from all sources, deduped by endpoint. Precedence: manual > hub > gossip */
  getPeersForHive(hiveName: string): SyncPeer[] {
    const allConfigs = peerConfigsDAL.listPeerConfigs();
    const forHive = allConfigs.filter(c => c.shared_hives.includes(hiveName));
    return dedupByEndpoint(forHive).map(configToSyncPeer);
  }

  getAllPeers(): SyncPeer[] {
    const allConfigs = peerConfigsDAL.listPeerConfigs();
    return dedupByEndpoint(allConfigs).map(configToSyncPeer);
  }

  isPeerOnline(peerId: string): boolean {
    const config = peerConfigsDAL.findPeerConfigById(peerId);
    return config?.status === 'active';
  }

  onPeerStatusChange(cb: PeerStatusCallback): void {
    this.callbacks.push(cb);
    this.manualResolver.onPeerStatusChange(cb);
    this.hubResolver?.onPeerStatusChange(cb);
  }

  getManualResolver(): ManualPeerResolver {
    return this.manualResolver;
  }

  getHubResolver(): HubPeerResolver | null {
    return this.hubResolver;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

function configToSyncPeer(config: SyncPeerConfig): SyncPeer {
  return {
    id: config.id,
    name: config.name,
    sync_endpoint: config.sync_endpoint,
    shared_hives: config.shared_hives,
    signing_key: config.signing_key,
    sync_token: config.sync_token,
    status: config.status,
    source: config.source,
  };
}

/** Dedup configs by endpoint. Manual wins over hub, hub wins over gossip. */
function dedupByEndpoint(configs: SyncPeerConfig[]): SyncPeerConfig[] {
  const precedence: Record<PeerSource, number> = { manual: 0, hub: 1, gossip: 2 };
  const byEndpoint = new Map<string, SyncPeerConfig>();

  for (const config of configs) {
    const existing = byEndpoint.get(config.sync_endpoint);
    if (!existing || precedence[config.source] < precedence[existing.source]) {
      byEndpoint.set(config.sync_endpoint, config);
    }
  }

  return Array.from(byEndpoint.values());
}
