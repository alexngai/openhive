/**
 * Cross-Instance E2E Test
 *
 * Verifies the critical path: events recorded on "instance A" can be
 * materialized on "instance B". Uses two separate SQLite databases to
 * simulate two independent OpenHive instances.
 *
 * Since initDatabase() is a singleton, we swap databases between phases:
 *   Phase 1 — set up instance A, construct events
 *   Phase 2 — set up instance B, materialize the events from A
 *   Verification — assert replicated data on instance B
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { nanoid } from 'nanoid';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as mapDAL from '../../db/dal/map.js';
import * as coordinationDal from '../../db/dal/coordination.js';
import { materializeEvent } from '../../sync/materializer.js';
import { signEvent, generateSigningKeyPair } from '../../sync/crypto.js';
import type { HiveEvent } from '../../sync/types.js';
import type {
  ResourcePublishedPayload,
  ResourceSyncedPayload,
  CoordinationTaskOfferedPayload,
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

/** IDs from instance A (used in event payloads) */
let agentA_id: string;
let agentA_name: string;

/** Stable IDs we embed directly in manually-constructed events */
const originResourceId = `res_origin_${nanoid()}`;
const originTaskId = `ct_origin_${nanoid()}`;
const originMessageId = `sm_origin_${nanoid()}`;

/** IDs from instance B (set up in Phase 2) */
let hiveB_id: string;
const hiveB_name = 'cross-test-hive';
let swarmB1_id: string;
let swarmB2_id: string;

/** Events constructed in Phase 1, materialized in Phase 2 */
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
    origin_ts: Date.now() - (100 - seq) * 1000, // monotonically increasing
    payload: payloadStr,
    signature: signEvent(payloadStr, keypair.privateKey),
    received_at: new Date().toISOString(),
    is_local: 0,
  };
}

// ════════════════════════════════════════════════════════════════════
// Test Suite
// ════════════════════════════════════════════════════════════════════

describe('Cross-Instance Event Materialization', () => {

  // ── Phase 1: Construct events that "originated on instance A" ────
  beforeAll(async () => {
    // We only need instance A's database to create an agent whose ID
    // we embed in event payloads. We could skip the DB entirely and
    // use synthetic IDs, but using a real agent validates the snapshot
    // format matches what hooks would produce.
    initDatabase(DB_A);

    const { agent } = await agentsDAL.createAgent({
      name: 'agent-on-A',
      description: 'Origin agent on instance A',
    });
    agentA_id = agent.id;
    agentA_name = agent.name;

    closeDatabase();

    // ── Phase 2: Set up instance B and materialize ──────────────

    initDatabase(DB_B);

    // Insert a placeholder agent on B with the same ID as agent A.
    // The materializer's resolveAuthor() for remote events returns
    // authorId = snapshot.agent_id (the remote agent's ID). The
    // syncable_resources.owner_agent_id FK references agents(id),
    // so the remote agent ID must exist in B's agents table.
    const dbB = getDatabase();
    dbB.prepare(`
      INSERT INTO agents (id, name, api_key_hash, description)
      VALUES (?, ?, ?, ?)
    `).run(agentA_id, 'proxy-of-agent-A', 'placeholder', 'Remote agent placeholder on B');

    // The hive must exist on B for FK constraints (coordination_tasks.hive_id)
    const hive = hivesDAL.createHive({
      name: hiveB_name,
      description: 'Cross-instance test hive on B',
      owner_id: (await agentsDAL.createAgent({ name: 'hive-owner-B' })).agent.id,
    });
    hiveB_id = hive.id;

    // Create two MAP swarms on B — coordination FKs reference map_swarms
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

    // ── Construct events (as if recorded on instance A) ─────────

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

    // assigned_to_swarm_id must reference a real swarm on B because
    // the materializer passes `payload.assigned_to_swarm_id ?? ''` to
    // createTask — an empty string fails the FK check. Use a B swarm.
    const taskOfferedPayload: CoordinationTaskOfferedPayload = {
      task_id: originTaskId,
      title: 'Analyze cross-instance dataset',
      description: 'Task offered from instance A',
      priority: 'high',
      offered_by: snapshot,
      hive_id: hiveB_id, // must match hive on B for FK
      assigned_to_swarm_id: swarmB1_id,
      context: { dataset: 'cross-test-data' },
      deadline: null,
    };

    // from_swarm_id and to_swarm_id must reference swarms on B since
    // that is where materialisation runs and FK enforcement happens.
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
      makeEvent(3, 'coordination_task_offered', taskOfferedPayload as unknown as Record<string, unknown>),
      makeEvent(4, 'coordination_message', messagePayload as unknown as Record<string, unknown>),
    ];

    // ── Materialize all events on instance B ────────────────────
    for (const event of events) {
      materializeEvent(event, hiveB_id, hiveB_name, /* isLocal */ false);
    }
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ── Resource Replication ──────────────────────────────────────

  describe('Resource replication', () => {
    it('should materialize resource_published into syncable_resources on B', () => {
      const db = getDatabase();
      const row = db.prepare(
        'SELECT * FROM syncable_resources WHERE origin_instance_id = ? AND origin_resource_id = ?',
      ).get(ORIGIN_INSTANCE, originResourceId) as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(row!.name).toBe('cross-test-memory');
      expect(row!.resource_type).toBe('memory_bank');
      expect(row!.description).toBe('A memory bank published on instance A');
      expect(row!.git_remote_url).toBe('https://github.com/test/cross-memory.git');
      expect(row!.visibility).toBe('shared');
      expect(row!.origin_instance_id).toBe(ORIGIN_INSTANCE);
      expect(row!.origin_resource_id).toBe(originResourceId);
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

  // ── Coordination Task Replication ─────────────────────────────

  describe('Coordination task replication', () => {
    it('should materialize coordination_task_offered into coordination_tasks on B', () => {
      const db = getDatabase();
      // The materializer uses coordinationDal.findTaskById(payload.task_id)
      // for idempotency, but createTask generates a new ID. We search by title.
      const rows = db.prepare(
        'SELECT * FROM coordination_tasks WHERE title = ? AND hive_id = ?',
      ).all('Analyze cross-instance dataset', hiveB_id) as Record<string, unknown>[];

      expect(rows.length).toBe(1);
      const task = rows[0];
      expect(task.priority).toBe('high');
      expect(task.description).toBe('Task offered from instance A');
      expect(task.hive_id).toBe(hiveB_id);
      expect(task.status).toBe('pending');
    });

    it('should record assigned_by_agent_id from the agent snapshot', () => {
      const db = getDatabase();
      const row = db.prepare(
        'SELECT assigned_by_agent_id FROM coordination_tasks WHERE title = ?',
      ).get('Analyze cross-instance dataset') as { assigned_by_agent_id: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.assigned_by_agent_id).toBe(agentA_id);
    });
  });

  // ── Message Replication ───────────────────────────────────────

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

  // ── Origin Tracking ───────────────────────────────────────────

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

  // ── Idempotency Across Instances ──────────────────────────────

  describe('Idempotency', () => {
    it('should not create duplicate resources when materializing the same events again', () => {
      const db = getDatabase();

      // Resources use ON CONFLICT(origin_instance_id, origin_resource_id),
      // so re-materializing should be perfectly idempotent.
      const resourcesBefore = (db.prepare(
        'SELECT COUNT(*) as count FROM syncable_resources WHERE origin_instance_id = ?',
      ).get(ORIGIN_INSTANCE) as { count: number }).count;

      // Re-materialize resource events
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

    it('should not create duplicate tasks/messages when re-materializing the same events', () => {
      // Coordination tasks and messages now use origin-based dedup via
      // origin_instance_id + origin_task_id / origin_message_id columns,
      // matching the pattern used by resources.
      const db = getDatabase();

      const tasksBefore = (db.prepare(
        'SELECT COUNT(*) as count FROM coordination_tasks WHERE hive_id = ?',
      ).get(hiveB_id) as { count: number }).count;

      const messagesBefore = (db.prepare(
        'SELECT COUNT(*) as count FROM swarm_messages WHERE hive_id = ?',
      ).get(hiveB_id) as { count: number }).count;

      // Re-materialize coordination events
      for (const event of events.filter(e =>
        e.event_type === 'coordination_task_offered' || e.event_type === 'coordination_message',
      )) {
        materializeEvent(event, hiveB_id, hiveB_name, false);
      }

      const tasksAfter = (db.prepare(
        'SELECT COUNT(*) as count FROM coordination_tasks WHERE hive_id = ?',
      ).get(hiveB_id) as { count: number }).count;

      const messagesAfter = (db.prepare(
        'SELECT COUNT(*) as count FROM swarm_messages WHERE hive_id = ?',
      ).get(hiveB_id) as { count: number }).count;

      // No duplicates: origin-based dedup prevents re-creation
      expect(tasksAfter).toBe(tasksBefore);
      expect(messagesAfter).toBe(messagesBefore);
    });
  });
});
