/**
 * Cross-Instance E2E Test
 *
 * Verifies the critical path: events recorded on "instance A" can be
 * materialized on "instance B". Uses two separate SQLite databases to
 * simulate two independent OpenHive instances.
 *
 * Task coordination events are deprecated (tasks now route through OpenTasks).
 * This test covers resource replication and message replication only.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { nanoid } from 'nanoid';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as mapDAL from '../../db/dal/map.js';
import '../../db/dal/coordination.js';
import { materializeEvent } from '../../sync/materializer.js';
import { signEvent, generateSigningKeyPair } from '../../sync/crypto.js';
import type { HiveEvent, HiveEventType } from '../../sync/types.js';
import type {
  ResourcePublishedPayload,
  ResourceSyncedPayload,
  CoordinationMessagePayload,
  AgentSnapshot,
} from '../../sync/types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel — materializer fires WebSocket broadcasts we don't need
vi.mock('../../realtime/index.js', () => ({ broadcastToChannel: vi.fn() }));

// ── Constants ──────────────────────────────────────────────────────
const ORIGIN_INSTANCE = 'inst_A';
const TEST_ROOT = testRoot('cross-instance');
const DB_A = testDbPath(TEST_ROOT, 'instance-a.db');
const DB_B = testDbPath(TEST_ROOT, 'instance-b.db');

// ── Shared state populated across phases ───────────────────────────
const keypair = generateSigningKeyPair();

let agentA_id: string;
let agentA_name: string;

const originResourceId = `res_origin_${nanoid()}`;
const originMessageId = `sm_origin_${nanoid()}`;

let hiveB_id: string;
const hiveB_name = 'cross-test-hive';
let swarmB1_id: string;
let swarmB2_id: string;

let events: HiveEvent[];

// ── Helpers ────────────────────────────────────────────────────────

function makeAgentSnapshot(agentId: string, agentName: string): AgentSnapshot {
  return {
    instance_id: ORIGIN_INSTANCE,
    agent_id: agentId,
    name: agentName,
    avatar_url: null,
  };
}

function makeEvent(
  seq: number,
  eventType: HiveEvent['event_type'],
  payload: Record<string, unknown>,
): HiveEvent {
  const payloadStr = JSON.stringify(payload);
  return {
    id: `evt_${nanoid()}`,
    sync_group_id: `sg_cross_test`,
    seq,
    event_type: eventType,
    origin_instance_id: ORIGIN_INSTANCE,
    origin_ts: Date.now() - (100 - seq) * 1000,
    payload: payloadStr,
    signature: signEvent(payloadStr, keypair.privateKey),
    received_at: new Date().toISOString(),
    is_local: 0,
  };
}

describe('Cross-Instance Event Materialization', () => {

  beforeAll(async () => {
    initDatabase(DB_A);

    const { agent } = await agentsDAL.createAgent({
      name: 'agent-on-A',
      description: 'Origin agent on instance A',
    });
    agentA_id = agent.id;
    agentA_name = agent.name;

    closeDatabase();

    initDatabase(DB_B);

    const dbB = getDatabase();
    dbB.prepare(`
      INSERT INTO agents (id, name, api_key_hash, description)
      VALUES (?, ?, ?, ?)
    `).run(agentA_id, 'proxy-of-agent-A', 'placeholder', 'Remote agent placeholder on B');

    const hive = hivesDAL.createHive({
      name: hiveB_name,
      description: 'Cross-instance test hive on B',
      owner_id: (await agentsDAL.createAgent({ name: 'hive-owner-B' })).agent.id,
    });
    hiveB_id = hive.id;

    const ownerB = (await agentsDAL.createAgent({ name: 'swarm-owner-B' })).agent;
    const swarm1 = mapDAL.createSwarm(ownerB.id, {
      name: 'swarm-B-1',
      map_endpoint: 'ws://localhost:19001/map',
      map_transport: 'websocket',
    });
    swarmB1_id = swarm1.id;

    const swarm2 = mapDAL.createSwarm(ownerB.id, {
      name: 'swarm-B-2',
      map_endpoint: 'ws://localhost:19002/map',
      map_transport: 'websocket',
    });
    swarmB2_id = swarm2.id;

    const snapshot = makeAgentSnapshot(agentA_id, agentA_name);

    const resourcePublishedPayload: ResourcePublishedPayload = {
      resource_id: originResourceId,
      resource_type: 'memory_bank',
      name: 'cross-test-memory',
      description: 'A memory bank published on instance A',
      git_remote_url: 'https://github.com/test/cross-memory.git',
      visibility: 'shared',
      owner: snapshot,
      tags: ['tag1', 'cross-instance'],
      metadata: { source: 'test' },
    };

    const resourceSyncedPayload: ResourceSyncedPayload = {
      resource_id: originResourceId,
      commit_hash: 'commit_abc',
      commit_message: 'Initial commit',
      pusher_agent_id: agentA_id,
      files_added: 3,
      files_modified: 1,
      files_removed: 0,
    };

    const messagePayload: CoordinationMessagePayload = {
      message_id: originMessageId,
      from_swarm_id: swarmB1_id,
      to_swarm_id: swarmB2_id,
      hive_id: hiveB_id,
      content_type: 'text',
      content: 'Hello from instance A via cross-sync',
      reply_to: null,
      metadata: { thread: 'cross-instance-thread' },
    };

    events = [
      makeEvent(1, 'resource_published', resourcePublishedPayload as unknown as Record<string, unknown>),
      makeEvent(2, 'resource_synced', resourceSyncedPayload as unknown as Record<string, unknown>),
      makeEvent(3, 'coordination_message', messagePayload as unknown as Record<string, unknown>),
    ];

    for (const event of events) {
      materializeEvent(event, hiveB_id, hiveB_name, false);
    }
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('Resource replication', () => {
    it('should materialize resource_published into syncable_resources on B', () => {
      const db = getDatabase();
      const row = db.prepare(
        'SELECT * FROM syncable_resources WHERE origin_instance_id = ? AND origin_resource_id = ?',
      ).get(ORIGIN_INSTANCE, originResourceId) as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(row!.name).toBe('cross-test-memory');
      expect(row!.resource_type).toBe('memory_bank');
      expect(row!.visibility).toBe('shared');
      expect(row!.origin_instance_id).toBe(ORIGIN_INSTANCE);
    });

    it('should materialize resource_synced and update last_commit_hash', () => {
      const db = getDatabase();
      const row = db.prepare(
        'SELECT last_commit_hash FROM syncable_resources WHERE origin_instance_id = ? AND origin_resource_id = ?',
      ).get(ORIGIN_INSTANCE, originResourceId) as { last_commit_hash: string | null } | undefined;

      expect(row).toBeDefined();
      expect(row!.last_commit_hash).toBe('commit_abc');
    });
  });

  describe('Message replication', () => {
    it('should materialize coordination_message into swarm_messages on B', () => {
      const db = getDatabase();
      const rows = db.prepare(
        'SELECT * FROM swarm_messages WHERE content = ?',
      ).all('Hello from instance A via cross-sync') as Record<string, unknown>[];

      expect(rows.length).toBe(1);
      const msg = rows[0];
      expect(msg.from_swarm_id).toBe(swarmB1_id);
      expect(msg.to_swarm_id).toBe(swarmB2_id);
      expect(msg.content_type).toBe('text');
      expect(msg.hive_id).toBe(hiveB_id);
    });
  });

  describe('Origin tracking', () => {
    it('should set origin_instance_id on replicated resources to inst_A', () => {
      const db = getDatabase();
      const resources = db.prepare(
        'SELECT origin_instance_id FROM syncable_resources WHERE origin_instance_id = ?',
      ).all(ORIGIN_INSTANCE) as { origin_instance_id: string }[];

      expect(resources.length).toBeGreaterThanOrEqual(1);
      for (const r of resources) {
        expect(r.origin_instance_id).toBe(ORIGIN_INSTANCE);
      }
    });
  });

  describe('Deprecated task events', () => {
    it('should skip coordination_task_offered without error', () => {
      // Cast is intentional — 'coordination_task_offered' was removed from
      // the HiveEventType union in SCHEMA_VERSION 42. We still exercise the
      // materializer's deprecated-event skipping path for inbound events
      // from older peers.
      const taskEvent = makeEvent(10, 'coordination_task_offered' as HiveEventType, {
        task_id: `ct_${nanoid()}`,
        title: 'Deprecated task',
        priority: 'medium',
        offered_by: makeAgentSnapshot(agentA_id, agentA_name),
        hive_id: hiveB_id,
      });

      // Should not throw — just logs and skips
      expect(() => materializeEvent(taskEvent, hiveB_id, hiveB_name, false)).not.toThrow();
    });
  });

  describe('Idempotency', () => {
    it('should not create duplicate resources when materializing the same events again', () => {
      const db = getDatabase();

      const resourcesBefore = (db.prepare(
        'SELECT COUNT(*) as count FROM syncable_resources WHERE origin_instance_id = ?',
      ).get(ORIGIN_INSTANCE) as { count: number }).count;

      for (const event of events.filter(e =>
        e.event_type === 'resource_published' || e.event_type === 'resource_synced',
      )) {
        materializeEvent(event, hiveB_id, hiveB_name, false);
      }

      const resourcesAfter = (db.prepare(
        'SELECT COUNT(*) as count FROM syncable_resources WHERE origin_instance_id = ?',
      ).get(ORIGIN_INSTANCE) as { count: number }).count;

      expect(resourcesAfter).toBe(resourcesBefore);
    });

    it('should not create duplicate messages when re-materializing', () => {
      const db = getDatabase();

      const messagesBefore = (db.prepare(
        'SELECT COUNT(*) as count FROM swarm_messages WHERE hive_id = ?',
      ).get(hiveB_id) as { count: number }).count;

      for (const event of events.filter(e => e.event_type === 'coordination_message')) {
        materializeEvent(event, hiveB_id, hiveB_name, false);
      }

      const messagesAfter = (db.prepare(
        'SELECT COUNT(*) as count FROM swarm_messages WHERE hive_id = ?',
      ).get(hiveB_id) as { count: number }).count;

      expect(messagesAfter).toBe(messagesBefore);
    });
  });
});
