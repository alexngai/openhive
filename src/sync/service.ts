/**
 * Sync Service
 *
 * Core orchestrator for cross-instance hive synchronization.
 * Coordinates peer resolution, event push/pull, handshakes, and health monitoring.
 */

import { nanoid } from 'nanoid';
import * as syncGroupsDAL from '../db/dal/sync-groups.js';
import * as syncEventsDAL from '../db/dal/sync-events.js';
import * as syncPeersDAL from '../db/dal/sync-peers.js';
import * as syncPeerConfigsDAL from '../db/dal/sync-peer-configs.js';
import * as hivesDAL from '../db/dal/hives.js';
import { signEvent, verifyEventSignature, generateSyncToken } from './crypto.js';
import { materializeBatch } from './materializer.js';
import { buildGossipPayload, processGossipPeers, cleanupStaleGossipPeers } from './gossip.js';
import { CompositePeerResolver, ManualPeerResolver, HubPeerResolver } from './peer-resolver.js';
import type { Config } from '../config.js';
import type {
  SyncGroup,
  HiveEvent,
  HiveEventType,
  HandshakeRequest,
  HandshakeResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  PullEventsResponse,
  GossipPeerInfo,
} from './types.js';

const syncLogger = {
  info: (message: string, ctx?: Record<string, unknown>) => {
    console.info(`[Sync Service] ${message}`, ctx ? JSON.stringify(ctx) : '');
  },
  warn: (message: string, ctx?: Record<string, unknown>) => {
    console.warn(`[Sync Service] ${message}`, ctx ? JSON.stringify(ctx) : '');
  },
  error: (message: string, ctx?: Record<string, unknown>) => {
    console.error(`[Sync Service] ${message}`, ctx ? JSON.stringify(ctx) : '');
  },
};

export class SyncService {
  private peerResolver: CompositePeerResolver;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private gossipCleanupTimer: NodeJS.Timeout | null = null;
  private config: Config['sync'];
  private instanceId: string;
  private started = false;

  constructor(config: Config['sync']) {
    this.config = config;
    this.instanceId = config.instanceId || `inst_${nanoid(12)}`;

    const manualResolver = new ManualPeerResolver();
    const hubResolver = config.discovery !== 'manual' ? new HubPeerResolver() : null;
    this.peerResolver = new CompositePeerResolver(manualResolver, hubResolver);
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  getPeerResolver(): CompositePeerResolver {
    return this.peerResolver;
  }

  // ── Lifecycle ──────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;

    syncLogger.info('Starting sync service', { instanceId: this.instanceId });

    // Seed peers from config
    this.seedPeersFromConfig();

    // Start heartbeat loop
    if (this.config.heartbeat_interval > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.runHeartbeatLoop();
      }, this.config.heartbeat_interval);
    }

    // Start gossip cleanup
    if (this.config.gossip.enabled) {
      this.gossipCleanupTimer = setInterval(() => {
        cleanupStaleGossipPeers(this.config.gossip);
      }, this.config.gossip.stale_timeout);
    }

    syncLogger.info('Sync service started');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.gossipCleanupTimer) {
      clearInterval(this.gossipCleanupTimer);
      this.gossipCleanupTimer = null;
    }

    syncLogger.info('Sync service stopped');
  }

  // ── Sync Group Management ─────────────────────────────────────

  createSyncGroup(hiveId: string): SyncGroup {
    const hive = hivesDAL.findHiveById(hiveId);
    if (!hive) throw new Error(`Hive ${hiveId} not found`);

    const existing = syncGroupsDAL.findSyncGroupByHive(hiveId);
    if (existing) throw new Error(`Hive ${hiveId} already has a sync group`);

    const syncGroupName = `sync:${hive.name}:${nanoid(8)}`;
    const syncGroup = syncGroupsDAL.createSyncGroup(hiveId, syncGroupName, this.instanceId);

    syncLogger.info('Created sync group', { id: syncGroup.id, hive: hive.name });
    return syncGroup;
  }

  // ── Event Recording ────────────────────────────────────────────

  recordEvent(syncGroupId: string, eventType: HiveEventType, payload: unknown): HiveEvent {
    const syncGroup = syncGroupsDAL.findSyncGroupById(syncGroupId);
    if (!syncGroup) throw new Error(`Sync group ${syncGroupId} not found`);

    const payloadStr = JSON.stringify(payload);
    const signature = signEvent(payloadStr, syncGroup.instance_signing_key_private);

    const event = syncEventsDAL.insertLocalEvent({
      sync_group_id: syncGroupId,
      event_type: eventType,
      origin_instance_id: this.instanceId,
      origin_ts: Date.now(),
      payload: payloadStr,
      signature,
      is_local: true,
    });

    // Push to all active peers (fire and forget)
    this.pushToAllPeers(syncGroupId).catch(err => {
      syncLogger.error('Push to peers failed', { error: (err as Error).message });
    });

    return event;
  }

  // ── Inbound Handlers ──────────────────────────────────────────

  handleHandshake(input: HandshakeRequest): HandshakeResponse {
    // Find the sync group
    const syncGroup = syncGroupsDAL.findSyncGroupByName(input.sync_group_name);
    if (!syncGroup) {
      throw new Error(`Sync group ${input.sync_group_name} not found`);
    }

    // Check if peer already exists
    let peer = syncPeersDAL.findSyncPeer(syncGroup.id, input.instance_id);
    const token = generateSyncToken();

    if (peer) {
      // Update existing peer
      syncPeersDAL.updateSyncPeerSigningKey(peer.id, input.signing_key);
      syncPeersDAL.updateSyncPeerStatus(peer.id, 'active');
    } else {
      // Create new peer
      peer = syncPeersDAL.createSyncPeer({
        sync_group_id: syncGroup.id,
        peer_swarm_id: input.instance_id,
        peer_endpoint: input.sync_endpoint,
        peer_signing_key: input.signing_key,
      });
    }

    // Update peer config with token
    const existingConfig = syncPeerConfigsDAL.findPeerConfigByEndpoint(input.sync_endpoint);
    if (existingConfig) {
      syncPeerConfigsDAL.updatePeerConfig(existingConfig.id, {
        sync_token: token,
        signing_key: input.signing_key,
      });
      syncPeerConfigsDAL.updatePeerConfigStatus(existingConfig.id, 'active');
    }

    syncLogger.info('Handshake completed', {
      peer: input.instance_id,
      sync_group: syncGroup.sync_group_name,
    });

    return {
      sync_group_id: syncGroup.id,
      signing_key: syncGroup.instance_signing_key,
      current_seq: syncGroup.seq,
      sync_token: token,
    };
  }

  handleIncomingEvents(syncGroupId: string, events: Array<{
    id: string;
    event_type: string;
    origin_instance_id: string;
    origin_ts: number;
    payload: string;
    signature: string;
  }>): { received_seq: number } {
    const syncGroup = syncGroupsDAL.findSyncGroupById(syncGroupId);
    if (!syncGroup) {
      throw new Error(`Sync group ${syncGroupId} not found`);
    }

    const hive = hivesDAL.findHiveById(syncGroup.hive_id);
    if (!hive) {
      throw new Error(`Hive ${syncGroup.hive_id} not found`);
    }

    const insertedEvents: HiveEvent[] = [];

    for (const event of events) {
      // Insert remote event (assigns local seq)
      const inserted = syncEventsDAL.insertRemoteEvent({
        sync_group_id: syncGroupId,
        event_type: event.event_type as HiveEventType,
        origin_instance_id: event.origin_instance_id,
        origin_ts: event.origin_ts,
        payload: event.payload,
        signature: event.signature,
        is_local: false,
      });

      insertedEvents.push(inserted);
    }

    // Materialize all inserted events
    if (insertedEvents.length > 0) {
      materializeBatch(insertedEvents, syncGroup.hive_id, hive.name, this.instanceId);
    }

    return {
      received_seq: syncGroup.seq + insertedEvents.length,
    };
  }

  handleEventsPull(syncGroupId: string, since: number, limit: number): PullEventsResponse {
    const result = syncEventsDAL.getEventsSince(syncGroupId, since, limit);

    return {
      events: result.events,
      next_seq: result.nextSeq,
      has_more: result.hasMore,
    };
  }

  handleHeartbeat(input: HeartbeatRequest): HeartbeatResponse {
    // Build our seq state
    const syncGroups = syncGroupsDAL.listSyncGroups();
    const seqByHive: Record<string, number> = {};

    for (const sg of syncGroups) {
      const hive = hivesDAL.findHiveById(sg.hive_id);
      if (hive) {
        seqByHive[hive.name] = sg.seq;
      }
    }

    // Process incoming gossip peers
    let gossipResponse: GossipPeerInfo[] = [];
    if (input.known_peers && this.config.gossip.enabled) {
      const senderConfig = syncPeerConfigsDAL.listPeerConfigs()
        .find(c => c.shared_hives.length > 0);

      processGossipPeers(
        input.known_peers,
        `heartbeat:${input.instance_id}`,
        this.config.gossip,
      );

      // Build our gossip response
      if (senderConfig) {
        const allPeers = this.peerResolver.getAllPeers();
        const targetPeer = allPeers.find(p => p.name === input.instance_id) || allPeers[0];
        if (targetPeer) {
          gossipResponse = buildGossipPayload(targetPeer, allPeers, this.config.gossip);
        }
      }
    }

    // Update heartbeat timestamp for the sender
    const senderConfigs = syncPeerConfigsDAL.listPeerConfigs();
    for (const sc of senderConfigs) {
      // Best-effort match by name or instance_id
      if (sc.name === input.instance_id) {
        syncPeerConfigsDAL.updatePeerConfigHeartbeat(sc.id);
        break;
      }
    }

    return {
      instance_id: this.instanceId,
      seq_by_hive: seqByHive,
      known_peers: gossipResponse.length > 0 ? gossipResponse : undefined,
    };
  }

  // ── Sync Status ────────────────────────────────────────────────

  getSyncStatus(): Array<{
    group_name: string;
    hive_name: string;
    local_seq: number;
    peers: Array<{
      name: string;
      status: string;
      lag: number;
      last_sync: string | null;
    }>;
  }> {
    const syncGroups = syncGroupsDAL.listSyncGroups();
    return syncGroups.map(sg => {
      const hive = hivesDAL.findHiveById(sg.hive_id);
      const peers = syncPeersDAL.listSyncPeers(sg.id);

      return {
        group_name: sg.sync_group_name,
        hive_name: hive?.name || 'unknown',
        local_seq: sg.seq,
        peers: peers.map(p => ({
          name: p.peer_swarm_id,
          status: p.status,
          lag: sg.seq - p.last_seq_sent,
          last_sync: p.last_sync_at,
        })),
      };
    });
  }

  // ── Internal ──────────────────────────────────────────────────

  private async pushToAllPeers(syncGroupId: string): Promise<void> {
    const peers = syncPeersDAL.listActivePeers(syncGroupId);

    for (const peer of peers) {
      try {
        await this.pushToPeer(syncGroupId, peer.id);
      } catch (err) {
        syncLogger.error('Push to peer failed', {
          peer: peer.peer_swarm_id,
          error: (err as Error).message,
        });
        syncPeersDAL.updateSyncPeerStatus(peer.id, 'error', (err as Error).message);
      }
    }
  }

  private async pushToPeer(syncGroupId: string, peerId: string): Promise<void> {
    const peer = syncPeersDAL.findSyncPeerById(peerId);
    if (!peer) return;

    const { events, nextSeq, hasMore } = syncEventsDAL.getEventsSince(
      syncGroupId,
      peer.last_seq_sent,
      100
    );

    if (events.length === 0) return;

    const response = await fetch(`${peer.peer_endpoint}/groups/${syncGroupId}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${peer.peer_signing_key}`,
      },
      body: JSON.stringify({
        events: events.map(e => ({
          id: e.id,
          event_type: e.event_type,
          origin_instance_id: e.origin_instance_id,
          origin_ts: e.origin_ts,
          payload: e.payload,
          signature: e.signature,
        })),
        sender_seq: nextSeq,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      syncPeersDAL.updateSyncPeerSeqSent(peerId, nextSeq);
    } else {
      throw new Error(`Push failed: ${response.status} ${response.statusText}`);
    }
  }

  private runHeartbeatLoop(): void {
    const peers = this.peerResolver.getAllPeers();

    for (const peer of peers) {
      if (peer.status !== 'active') continue;

      // Build heartbeat request
      const syncGroups = syncGroupsDAL.listSyncGroups();
      const seqByHive: Record<string, number> = {};
      for (const sg of syncGroups) {
        const hive = hivesDAL.findHiveById(sg.hive_id);
        if (hive) seqByHive[hive.name] = sg.seq;
      }

      // Build gossip payload for this peer
      let gossipPayload: GossipPeerInfo[] = [];
      if (this.config.gossip.enabled) {
        const allPeers = this.peerResolver.getAllPeers();
        gossipPayload = buildGossipPayload(peer, allPeers, this.config.gossip);
      }

      const heartbeat: HeartbeatRequest = {
        instance_id: this.instanceId,
        seq_by_hive: seqByHive,
        known_peers: gossipPayload.length > 0 ? gossipPayload : undefined,
      };

      fetch(`${peer.sync_endpoint}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(heartbeat),
        signal: AbortSignal.timeout(5000),
      }).then(async res => {
        if (res.ok) {
          const response: HeartbeatResponse = await res.json();
          syncPeerConfigsDAL.updatePeerConfigHeartbeat(peer.id);

          // Process gossip from response
          if (response.known_peers && this.config.gossip.enabled) {
            processGossipPeers(response.known_peers, peer.sync_endpoint, this.config.gossip);
          }

          // Detect if peer is ahead — trigger pull
          for (const [hiveName, peerSeq] of Object.entries(response.seq_by_hive)) {
            const localSeq = seqByHive[hiveName] ?? 0;
            if (peerSeq > localSeq) {
              syncLogger.info('Peer is ahead, triggering pull', {
                peer: peer.name,
                hive: hiveName,
                peer_seq: peerSeq,
                local_seq: localSeq,
              });
            }
          }
        }
      }).catch(err => {
        syncLogger.warn('Heartbeat failed', {
          peer: peer.name,
          error: (err as Error).message,
        });
      });
    }
  }

  private seedPeersFromConfig(): void {
    for (const peer of this.config.peers) {
      syncPeerConfigsDAL.upsertPeerConfig({
        name: peer.name,
        sync_endpoint: peer.sync_endpoint,
        shared_hives: peer.shared_hives,
        is_manual: true,
        source: 'manual',
        gossip_ttl: this.config.gossip.default_ttl,
      });
    }

    if (this.config.peers.length > 0) {
      syncLogger.info('Seeded peers from config', { count: this.config.peers.length });
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────

let syncServiceInstance: SyncService | null = null;

export function initSyncService(config: Config['sync']): SyncService {
  if (syncServiceInstance) {
    syncServiceInstance.stop();
  }
  syncServiceInstance = new SyncService(config);
  return syncServiceInstance;
}

export function getSyncService(): SyncService | null {
  return syncServiceInstance;
}
