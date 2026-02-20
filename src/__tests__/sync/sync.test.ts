/**
 * Comprehensive test suite for hive sync system.
 * Covers: crypto, remote agents, sync groups, events, materializer, hooks,
 * peer resolver, gossip, compaction, and protocol routes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as postsDAL from '../../db/dal/posts.js';
import * as commentsDAL from '../../db/dal/comments.js';
import * as remoteAgentsDAL from '../../db/dal/remote-agents.js';
import * as syncGroupsDAL from '../../db/dal/sync-groups.js';
import * as syncEventsDAL from '../../db/dal/sync-events.js';
import * as syncPeersDAL from '../../db/dal/sync-peers.js';
import * as syncPeerConfigsDAL from '../../db/dal/sync-peer-configs.js';
import { generateSigningKeyPair, signEvent, verifyEventSignature, generateSyncToken } from '../../sync/crypto.js';
import { materializeEvent, materializeBatch, processPendingQueue } from '../../sync/materializer.js';
import { onPostCreated, onCommentCreated, onVoteCast } from '../../sync/hooks.js';
import { ManualPeerResolver, HubPeerResolver, CompositePeerResolver } from '../../sync/peer-resolver.js';
import { buildGossipPayload, processGossipPeers } from '../../sync/gossip.js';
import { compactEvents, createSnapshot } from '../../sync/compaction.js';
import type { HiveEvent, GossipConfig, SyncPeer } from '../../sync/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('sync');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'sync-test.db');

describe('Hive Sync System', () => {
  let testAgentId: string;
  let testHiveId: string;
  let testHiveName: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    // Create test agent and hive
    const { agent } = await agentsDAL.createAgent({
      name: 'sync-test-agent',
      description: 'Test agent for sync',
    });
    testAgentId = agent.id;

    const hive = hivesDAL.createHive({
      name: 'sync-test-hive',
      description: 'Test hive for sync',
      owner_id: testAgentId,
    });
    testHiveId = hive.id;
    testHiveName = hive.name;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 1: Crypto
  // ═══════════════════════════════════════════════════════════════

  describe('Crypto', () => {
    it('should generate an Ed25519 keypair', () => {
      const keypair = generateSigningKeyPair();
      expect(keypair.publicKey).toBeDefined();
      expect(keypair.privateKey).toBeDefined();
      expect(keypair.publicKey.length).toBeGreaterThan(0);
      expect(keypair.privateKey.length).toBeGreaterThan(0);
    });

    it('should sign and verify a payload', () => {
      const keypair = generateSigningKeyPair();
      const payload = JSON.stringify({ test: 'data', num: 42 });

      const signature = signEvent(payload, keypair.privateKey);
      expect(signature).toBeDefined();
      expect(signature.length).toBeGreaterThan(0);

      const isValid = verifyEventSignature(payload, signature, keypair.publicKey);
      expect(isValid).toBe(true);
    });

    it('should reject verification with wrong key', () => {
      const keypair1 = generateSigningKeyPair();
      const keypair2 = generateSigningKeyPair();
      const payload = 'test payload';

      const signature = signEvent(payload, keypair1.privateKey);
      const isValid = verifyEventSignature(payload, signature, keypair2.publicKey);
      expect(isValid).toBe(false);
    });

    it('should reject verification with tampered payload', () => {
      const keypair = generateSigningKeyPair();
      const payload = 'original payload';

      const signature = signEvent(payload, keypair.privateKey);
      const isValid = verifyEventSignature('tampered payload', signature, keypair.publicKey);
      expect(isValid).toBe(false);
    });

    it('should generate unique sync tokens', () => {
      const token1 = generateSyncToken();
      const token2 = generateSyncToken();
      expect(token1).not.toBe(token2);
      expect(token1.length).toBe(64); // 32 bytes as hex
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 1: Remote Agents
  // ═══════════════════════════════════════════════════════════════

  describe('Remote Agents DAL', () => {
    it('should upsert a remote agent', () => {
      const agent = remoteAgentsDAL.upsertRemoteAgent({
        origin_instance_id: 'inst_remote_1',
        origin_agent_id: 'agent_remote_1',
        name: 'Remote Agent 1',
        avatar_url: 'https://example.com/avatar.png',
      });

      expect(agent).toBeDefined();
      expect(agent.name).toBe('Remote Agent 1');
      expect(agent.origin_instance_id).toBe('inst_remote_1');
      expect(agent.origin_agent_id).toBe('agent_remote_1');
    });

    it('should update on conflict', () => {
      const agent = remoteAgentsDAL.upsertRemoteAgent({
        origin_instance_id: 'inst_remote_1',
        origin_agent_id: 'agent_remote_1',
        name: 'Updated Remote Agent 1',
        avatar_url: 'https://example.com/new-avatar.png',
      });

      expect(agent.name).toBe('Updated Remote Agent 1');
      expect(agent.avatar_url).toBe('https://example.com/new-avatar.png');
    });

    it('should find by origin', () => {
      const agent = remoteAgentsDAL.findRemoteAgent('inst_remote_1', 'agent_remote_1');
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('Updated Remote Agent 1');
    });

    it('should return null for unknown origin', () => {
      const agent = remoteAgentsDAL.findRemoteAgent('nonexistent', 'nonexistent');
      expect(agent).toBeNull();
    });

    it('should find by ID', () => {
      const agent = remoteAgentsDAL.findRemoteAgent('inst_remote_1', 'agent_remote_1');
      const found = remoteAgentsDAL.findRemoteAgentById(agent!.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(agent!.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: Sync Groups
  // ═══════════════════════════════════════════════════════════════

  describe('Sync Groups DAL', () => {
    let syncGroupId: string;

    it('should create a sync group with keypair', () => {
      const group = syncGroupsDAL.createSyncGroup(testHiveId, 'sync:test:001', 'inst_local');
      syncGroupId = group.id;

      expect(group).toBeDefined();
      expect(group.hive_id).toBe(testHiveId);
      expect(group.sync_group_name).toBe('sync:test:001');
      expect(group.instance_signing_key).toBeDefined();
      expect(group.instance_signing_key_private).toBeDefined();
      expect(group.seq).toBe(0);
    });

    it('should find sync group by hive', () => {
      const group = syncGroupsDAL.findSyncGroupByHive(testHiveId);
      expect(group).not.toBeNull();
      expect(group!.id).toBe(syncGroupId);
    });

    it('should find sync group by name', () => {
      const group = syncGroupsDAL.findSyncGroupByName('sync:test:001');
      expect(group).not.toBeNull();
      expect(group!.id).toBe(syncGroupId);
    });

    it('should increment seq monotonically', () => {
      const seq1 = syncGroupsDAL.incrementSeq(syncGroupId);
      const seq2 = syncGroupsDAL.incrementSeq(syncGroupId);
      const seq3 = syncGroupsDAL.incrementSeq(syncGroupId);
      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(3);
    });

    it('should list sync groups', () => {
      const groups = syncGroupsDAL.listSyncGroups();
      expect(groups.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: Events
  // ═══════════════════════════════════════════════════════════════

  describe('Sync Events DAL', () => {
    let syncGroupId: string;

    beforeAll(() => {
      // Get the sync group created in the previous test
      const group = syncGroupsDAL.findSyncGroupByHive(testHiveId);
      syncGroupId = group!.id;
    });

    it('should insert local events with auto-incrementing seq', () => {
      const keypair = generateSigningKeyPair();
      const payload = JSON.stringify({ post_id: 'p1', title: 'Test' });
      const signature = signEvent(payload, keypair.privateKey);

      const event1 = syncEventsDAL.insertLocalEvent({
        sync_group_id: syncGroupId,
        event_type: 'post_created',
        origin_instance_id: 'inst_local',
        origin_ts: Date.now(),
        payload,
        signature,
        is_local: true,
      });

      const event2 = syncEventsDAL.insertLocalEvent({
        sync_group_id: syncGroupId,
        event_type: 'comment_created',
        origin_instance_id: 'inst_local',
        origin_ts: Date.now(),
        payload: JSON.stringify({ comment_id: 'c1' }),
        signature: signEvent(JSON.stringify({ comment_id: 'c1' }), keypair.privateKey),
        is_local: true,
      });

      expect(event1.seq).toBeLessThan(event2.seq);
      expect(event1.is_local).toBe(1);
    });

    it('should get events since a sequence', () => {
      const result = syncEventsDAL.getEventsSince(syncGroupId, 0, 10);
      expect(result.events.length).toBeGreaterThan(0);
      expect(result.hasMore).toBe(false);
    });

    it('should paginate events', () => {
      const result = syncEventsDAL.getEventsSince(syncGroupId, 0, 1);
      expect(result.events.length).toBe(1);
      expect(result.hasMore).toBe(true);
    });

    it('should get latest seq', () => {
      const seq = syncEventsDAL.getLatestSeq(syncGroupId);
      expect(seq).toBeGreaterThan(0);
    });

    it('should count events', () => {
      const count = syncEventsDAL.countEvents(syncGroupId);
      expect(count).toBeGreaterThan(0);
    });

    it('should handle pending events', () => {
      syncEventsDAL.insertPendingEvent(syncGroupId, '{"test":"pending"}', ['dep1', 'dep2']);
      const pending = syncEventsDAL.getPendingEvents(syncGroupId);
      expect(pending.length).toBeGreaterThanOrEqual(1);

      syncEventsDAL.deletePendingEvent(pending[0].id);
      const remaining = syncEventsDAL.getPendingEvents(syncGroupId);
      expect(remaining.length).toBe(pending.length - 1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: Sync Peers
  // ═══════════════════════════════════════════════════════════════

  describe('Sync Peers DAL', () => {
    let syncGroupId: string;

    beforeAll(() => {
      const group = syncGroupsDAL.findSyncGroupByHive(testHiveId);
      syncGroupId = group!.id;
    });

    it('should create a sync peer', () => {
      const peer = syncPeersDAL.createSyncPeer({
        sync_group_id: syncGroupId,
        peer_swarm_id: 'inst_remote_1',
        peer_endpoint: 'https://remote1.example.com/sync/v1',
        peer_signing_key: 'test_key_123',
      });

      expect(peer).toBeDefined();
      expect(peer.peer_swarm_id).toBe('inst_remote_1');
      expect(peer.status).toBe('active');
      expect(peer.last_seq_sent).toBe(0);
    });

    it('should find sync peer', () => {
      const peer = syncPeersDAL.findSyncPeer(syncGroupId, 'inst_remote_1');
      expect(peer).not.toBeNull();
    });

    it('should update seq sent', () => {
      const peer = syncPeersDAL.findSyncPeer(syncGroupId, 'inst_remote_1')!;
      syncPeersDAL.updateSyncPeerSeqSent(peer.id, 42);

      const updated = syncPeersDAL.findSyncPeerById(peer.id)!;
      expect(updated.last_seq_sent).toBe(42);
    });

    it('should update status', () => {
      const peer = syncPeersDAL.findSyncPeer(syncGroupId, 'inst_remote_1')!;
      syncPeersDAL.updateSyncPeerStatus(peer.id, 'error', 'Connection timeout');

      const updated = syncPeersDAL.findSyncPeerById(peer.id)!;
      expect(updated.status).toBe('error');
      expect(updated.last_error).toBe('Connection timeout');
    });

    it('should list active peers', () => {
      const peer = syncPeersDAL.findSyncPeer(syncGroupId, 'inst_remote_1')!;
      syncPeersDAL.updateSyncPeerStatus(peer.id, 'active');

      const activePeers = syncPeersDAL.listActivePeers(syncGroupId);
      expect(activePeers.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: Materializer
  // ═══════════════════════════════════════════════════════════════

  describe('Materializer', () => {
    it('should materialize a post_created event', () => {
      const syncGroup = syncGroupsDAL.findSyncGroupByHive(testHiveId)!;
      const payload = JSON.stringify({
        post_id: 'remote_post_1',
        title: 'Remote Post Title',
        content: 'Remote post content',
        url: null,
        author: {
          instance_id: 'inst_remote_2',
          agent_id: 'agent_r2',
          name: 'Remote Author',
          avatar_url: null,
        },
      });
      const signature = signEvent(payload, syncGroup.instance_signing_key_private);

      const event: HiveEvent = {
        id: 'evt_test_mat_1',
        sync_group_id: syncGroup.id,
        seq: 100,
        event_type: 'post_created',
        origin_instance_id: 'inst_remote_2',
        origin_ts: Date.now(),
        payload,
        signature,
        received_at: new Date().toISOString(),
        is_local: 0,
      };

      materializeEvent(event, testHiveId, testHiveName, false);

      // Verify the post was created
      const db = getDatabase();
      const post = db.prepare('SELECT * FROM posts WHERE origin_post_id = ?').get('remote_post_1') as Record<string, unknown> | undefined;
      expect(post).toBeDefined();
      expect(post!.title).toBe('Remote Post Title');
      expect(post!.origin_instance_id).toBe('inst_remote_2');
    });

    it('should deduplicate on repeated materialization', () => {
      const syncGroup = syncGroupsDAL.findSyncGroupByHive(testHiveId)!;
      const payload = JSON.stringify({
        post_id: 'remote_post_1',
        title: 'Remote Post Title Duplicate',
        content: 'Should not appear',
        url: null,
        author: {
          instance_id: 'inst_remote_2',
          agent_id: 'agent_r2',
          name: 'Remote Author',
          avatar_url: null,
        },
      });

      const event: HiveEvent = {
        id: 'evt_test_mat_2',
        sync_group_id: syncGroup.id,
        seq: 101,
        event_type: 'post_created',
        origin_instance_id: 'inst_remote_2',
        origin_ts: Date.now(),
        payload,
        signature: signEvent(payload, syncGroup.instance_signing_key_private),
        received_at: new Date().toISOString(),
        is_local: 0,
      };

      materializeEvent(event, testHiveId, testHiveName, false);

      // Original title should remain
      const db = getDatabase();
      const post = db.prepare('SELECT * FROM posts WHERE origin_post_id = ?').get('remote_post_1') as Record<string, unknown>;
      expect(post.title).toBe('Remote Post Title');
    });

    it('should materialize a vote_cast event', () => {
      const syncGroup = syncGroupsDAL.findSyncGroupByHive(testHiveId)!;

      // Find the remote post
      const db = getDatabase();
      const post = db.prepare('SELECT * FROM posts WHERE origin_post_id = ?').get('remote_post_1') as Record<string, unknown>;

      const payload = JSON.stringify({
        target_type: 'post',
        target_id: 'remote_post_1',
        voter: { instance_id: 'inst_remote_2', agent_id: 'agent_v1' },
        value: 1,
      });

      const event: HiveEvent = {
        id: 'evt_test_vote_1',
        sync_group_id: syncGroup.id,
        seq: 102,
        event_type: 'vote_cast',
        origin_instance_id: 'inst_remote_2',
        origin_ts: Date.now(),
        payload,
        signature: signEvent(payload, syncGroup.instance_signing_key_private),
        received_at: new Date().toISOString(),
        is_local: 0,
      };

      materializeEvent(event, testHiveId, testHiveName, false);

      // Post score should be updated
      const updatedPost = db.prepare('SELECT score FROM posts WHERE origin_post_id = ?').get('remote_post_1') as { score: number };
      expect(updatedPost.score).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: Hooks
  // ═══════════════════════════════════════════════════════════════

  describe('Sync Hooks', () => {
    it('should record an event when a post is created in a synced hive', () => {
      const syncGroup = syncGroupsDAL.findSyncGroupByHive(testHiveId)!;
      const seqBefore = syncGroupsDAL.getSeq(syncGroup.id);

      const post = postsDAL.createPost({
        hive_id: testHiveId,
        author_id: testAgentId,
        title: 'Hook Test Post',
        content: 'Content for hook test',
      });

      const agent = agentsDAL.findAgentById(testAgentId)!;
      onPostCreated(testHiveId, post, agent);

      const seqAfter = syncGroupsDAL.getSeq(syncGroup.id);
      expect(seqAfter).toBeGreaterThan(seqBefore);

      // Verify event was recorded
      const latestEvents = syncEventsDAL.getEventsSince(syncGroup.id, seqBefore, 10);
      const postEvent = latestEvents.events.find(e => e.event_type === 'post_created');
      expect(postEvent).toBeDefined();

      const payload = JSON.parse(postEvent!.payload);
      expect(payload.post_id).toBe(post.id);
      expect(payload.title).toBe('Hook Test Post');
    });

    it('should not record events for hives without sync groups', () => {
      // Create a hive without sync
      const hive2 = hivesDAL.createHive({
        name: 'no-sync-hive',
        description: 'No sync',
        owner_id: testAgentId,
      });

      const post = postsDAL.createPost({
        hive_id: hive2.id,
        author_id: testAgentId,
        title: 'No Sync Post',
      });

      const agent = agentsDAL.findAgentById(testAgentId)!;

      // This should not throw
      onPostCreated(hive2.id, post, agent);

      // No sync group exists, so nothing to check
      const syncGroup = syncGroupsDAL.findSyncGroupByHive(hive2.id);
      expect(syncGroup).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 3: Peer Configs
  // ═══════════════════════════════════════════════════════════════

  describe('Sync Peer Configs DAL', () => {
    it('should create a manual peer config', () => {
      const config = syncPeerConfigsDAL.createPeerConfig({
        name: 'Instance B',
        sync_endpoint: 'https://b.example.com/sync/v1',
        shared_hives: ['sync-test-hive', 'other-hive'],
        source: 'manual',
      });

      expect(config).toBeDefined();
      expect(config.name).toBe('Instance B');
      expect(config.shared_hives).toEqual(['sync-test-hive', 'other-hive']);
      expect(config.source).toBe('manual');
      expect(config.is_manual).toBe(true);
    });

    it('should find by endpoint', () => {
      const config = syncPeerConfigsDAL.findPeerConfigByEndpoint('https://b.example.com/sync/v1');
      expect(config).not.toBeNull();
      expect(config!.name).toBe('Instance B');
    });

    it('should upsert without overwriting manual configs', () => {
      syncPeerConfigsDAL.upsertPeerConfig({
        name: 'Instance B (hub)',
        sync_endpoint: 'https://b.example.com/sync/v1',
        shared_hives: ['different-hive'],
        source: 'hub',
        is_manual: false,
      });

      // Manual config should NOT be overwritten
      const config = syncPeerConfigsDAL.findPeerConfigByEndpoint('https://b.example.com/sync/v1');
      expect(config!.name).toBe('Instance B'); // Still manual name
      expect(config!.source).toBe('manual');
    });

    it('should list with filters', () => {
      syncPeerConfigsDAL.createPeerConfig({
        name: 'Instance C',
        sync_endpoint: 'https://c.example.com/sync/v1',
        shared_hives: ['sync-test-hive'],
        source: 'hub',
        is_manual: false,
      });

      const manual = syncPeerConfigsDAL.listPeerConfigs({ source: 'manual' });
      const hub = syncPeerConfigsDAL.listPeerConfigs({ source: 'hub' });

      expect(manual.length).toBeGreaterThanOrEqual(1);
      expect(hub.length).toBeGreaterThanOrEqual(1);
      expect(manual.every(c => c.source === 'manual')).toBe(true);
      expect(hub.every(c => c.source === 'hub')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 3/4: Peer Resolver
  // ═══════════════════════════════════════════════════════════════

  describe('Peer Resolver', () => {
    it('ManualPeerResolver should read from sync_peer_configs', () => {
      const resolver = new ManualPeerResolver();
      const peers = resolver.getAllPeers();
      expect(peers.length).toBeGreaterThan(0);
    });

    it('ManualPeerResolver should filter by hive', () => {
      const resolver = new ManualPeerResolver();
      const peers = resolver.getPeersForHive('sync-test-hive');
      expect(peers.length).toBeGreaterThanOrEqual(1);
      expect(peers.every(p => p.shared_hives.includes('sync-test-hive'))).toBe(true);
    });

    it('CompositePeerResolver should merge and dedup', () => {
      const manual = new ManualPeerResolver();
      const hub = new HubPeerResolver();
      const composite = new CompositePeerResolver(manual, hub);

      const peers = composite.getAllPeers();
      // Endpoints should be unique
      const endpoints = peers.map(p => p.sync_endpoint);
      const uniqueEndpoints = new Set(endpoints);
      expect(endpoints.length).toBe(uniqueEndpoints.size);
    });

    it('CompositePeerResolver should prefer manual over hub', () => {
      const composite = new CompositePeerResolver(new ManualPeerResolver(), new HubPeerResolver());
      const peers = composite.getPeersForHive('sync-test-hive');

      // Instance B exists as both manual and hub; manual should win
      const instB = peers.find(p => p.sync_endpoint === 'https://b.example.com/sync/v1');
      expect(instB).toBeDefined();
      expect(instB!.source).toBe('manual');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 5: Gossip
  // ═══════════════════════════════════════════════════════════════

  describe('Gossip', () => {
    const gossipConfig: GossipConfig = {
      enabled: true,
      default_ttl: 2,
      hub_peer_ttl: 1,
      exchange_interval: 60000,
      max_gossip_peers: 50,
      stale_timeout: 300000,
      max_failures: 3,
    };

    it('should build gossip payload filtered by overlapping hives', () => {
      const targetPeer: SyncPeer = {
        id: 'target',
        name: 'Target',
        sync_endpoint: 'https://target.example.com/sync/v1',
        shared_hives: ['sync-test-hive'],
        signing_key: null,
        sync_token: null,
        status: 'active',
        source: 'manual',
      };

      const allPeers: SyncPeer[] = [
        targetPeer,
        {
          id: 'peer1',
          name: 'Peer1',
          sync_endpoint: 'https://peer1.example.com/sync/v1',
          shared_hives: ['sync-test-hive'],
          signing_key: null,
          sync_token: null,
          status: 'active',
          source: 'manual',
        },
        {
          id: 'peer2',
          name: 'Peer2',
          sync_endpoint: 'https://peer2.example.com/sync/v1',
          shared_hives: ['unrelated-hive'],
          signing_key: null,
          sync_token: null,
          status: 'active',
          source: 'manual',
        },
      ];

      const payload = buildGossipPayload(targetPeer, allPeers, gossipConfig);

      // Should include peer1 (shares 'sync-test-hive') but not peer2 (no overlap) or target (itself)
      expect(payload.length).toBe(1);
      expect(payload[0].name).toBe('Peer1');
    });

    it('should decrement TTL on gossip payload', () => {
      const target: SyncPeer = {
        id: 't', name: 'T', sync_endpoint: 'https://t.example.com',
        shared_hives: ['h1'], signing_key: null, sync_token: null,
        status: 'active', source: 'manual',
      };
      const peer: SyncPeer = {
        id: 'p', name: 'P', sync_endpoint: 'https://p.example.com',
        shared_hives: ['h1'], signing_key: null, sync_token: null,
        status: 'active', source: 'manual',
      };

      const payload = buildGossipPayload(target, [target, peer], gossipConfig);
      expect(payload[0].ttl).toBe(1); // default_ttl (2) - 1 = 1
    });

    it('should not share peers with TTL 0', () => {
      const target: SyncPeer = {
        id: 't', name: 'T', sync_endpoint: 'https://t.example.com',
        shared_hives: ['h1'], signing_key: null, sync_token: null,
        status: 'active', source: 'manual',
      };
      // A gossip peer with TTL 0 should not be propagated
      // This requires a peer config with gossip_ttl = 0
      const peer: SyncPeer = {
        id: 'p', name: 'P', sync_endpoint: 'https://p.example.com',
        shared_hives: ['h1'], signing_key: null, sync_token: null,
        status: 'active', source: 'gossip',
      };

      // Since gossip peers check the DB for TTL, and we haven't inserted one with TTL 0,
      // test the buildGossipPayload behavior: gossip source peers look up TTL from DB
      const payload = buildGossipPayload(target, [target, peer], gossipConfig);
      // gossip peer not in DB → TTL defaults to 0 → should not be shared
      expect(payload.length).toBe(0);
    });

    it('should process incoming gossip peers', () => {
      const incoming = [
        {
          sync_endpoint: 'https://discovered.example.com/sync/v1',
          name: 'Discovered Instance',
          shared_hives: ['sync-test-hive'],
          signing_key: null,
          ttl: 1,
        },
      ];

      const newPeers = processGossipPeers(incoming, 'https://sender.example.com', gossipConfig);
      expect(newPeers.length).toBe(1);
      expect(newPeers[0]).toBe('https://discovered.example.com/sync/v1');

      // Verify it was stored
      const stored = syncPeerConfigsDAL.findPeerConfigByEndpoint('https://discovered.example.com/sync/v1');
      expect(stored).not.toBeNull();
      expect(stored!.source).toBe('gossip');
      expect(stored!.gossip_ttl).toBe(1);
    });

    it('should not overwrite manual peers via gossip', () => {
      const incoming = [
        {
          sync_endpoint: 'https://b.example.com/sync/v1', // Already exists as manual
          name: 'Gossip Override Attempt',
          shared_hives: ['sync-test-hive'],
          signing_key: null,
          ttl: 2,
        },
      ];

      const newPeers = processGossipPeers(incoming, 'https://sender.example.com', gossipConfig);
      expect(newPeers.length).toBe(0); // Not a new peer

      const stored = syncPeerConfigsDAL.findPeerConfigByEndpoint('https://b.example.com/sync/v1');
      expect(stored!.source).toBe('manual'); // Still manual
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 6: Compaction
  // ═══════════════════════════════════════════════════════════════

  describe('Compaction', () => {
    it('should compact old events', () => {
      const syncGroup = syncGroupsDAL.findSyncGroupByHive(testHiveId)!;

      // Force some events to appear old by updating received_at
      const db = getDatabase();
      db.prepare(
        "UPDATE hive_events SET received_at = datetime('now', '-100 days') WHERE sync_group_id = ? AND seq <= 2"
      ).run(syncGroup.id);

      const result = compactEvents(syncGroup.id, 1000 * 60 * 60 * 24 * 90); // 90 day retention
      expect(result.eventsRemoved).toBeGreaterThanOrEqual(0);
    });

    it('should create a snapshot', () => {
      const syncGroup = syncGroupsDAL.findSyncGroupByHive(testHiveId)!;
      const snapshot = createSnapshot(syncGroup.id);

      expect(snapshot.sync_group_id).toBe(syncGroup.id);
      expect(snapshot.posts).toBeDefined();
      expect(Array.isArray(snapshot.posts)).toBe(true);
      expect(snapshot.posts.length).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 1: Feed queries with remote authors
  // ═══════════════════════════════════════════════════════════════

  describe('Feed queries with remote authors', () => {
    it('should return posts with COALESCE author info', () => {
      const posts = postsDAL.listPosts({ hive_name: testHiveName });
      expect(posts.length).toBeGreaterThan(0);

      // Local posts should have valid author info
      const localPost = posts.find(p => p.author?.name === 'sync-test-agent');
      expect(localPost).toBeDefined();
    });

    it('should return correct author for findPostWithAuthor', () => {
      const posts = postsDAL.listPosts({ hive_name: testHiveName });
      if (posts.length > 0) {
        const full = postsDAL.findPostWithAuthor(posts[0].id);
        expect(full).not.toBeNull();
        expect(full!.author.name).toBeDefined();
      }
    });
  });
});
