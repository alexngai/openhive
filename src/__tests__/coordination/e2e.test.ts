/**
 * Single-instance integration E2E test.
 *
 * Tests the full vertical stack within one instance for all cross-boundary
 * features: coordination lifecycle, resource replication, capability discovery,
 * and resource injection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as mapDAL from '../../db/dal/map.js';
import * as syncGroupsDAL from '../../db/dal/sync-groups.js';
import * as syncEventsDAL from '../../db/dal/sync-events.js';
import * as coordinationDal from '../../db/dal/coordination.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// ── Mocks ─────────────────────────────────────────────────────────
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

vi.mock('../../map/sync-listener.js', () => ({
  sendToSwarm: vi.fn(),
  handleSyncMessage: vi.fn(),
}));

import { broadcastToChannel } from '../../realtime/index.js';
import { sendToSwarm } from '../../map/sync-listener.js';

const mockBroadcast = vi.mocked(broadcastToChannel);
const mockSendToSwarm = vi.mocked(sendToSwarm);

// Coordination service (real, not mocked)
import { CoordinationService } from '../../coordination/service.js';
import { initCoordinationService, getCoordinationService } from '../../coordination/index.js';

// Sync hooks
import {
  onCoordinationTaskOffered,
  onCoordinationMessage,
} from '../../sync/coordination-hooks.js';
import { onResourcePublished } from '../../sync/resource-hooks.js';

// Materializer
import { materializeEvent } from '../../sync/materializer.js';
import { signEvent } from '../../sync/crypto.js';

// Capability discovery
import { discoverByCapability } from '../../map/service.js';

// Resource injection
import {
  findResourceById,
  subscribeToResource,
  getSubscription,
} from '../../db/dal/syncable-resources.js';

import type { HiveEvent } from '../../sync/types.js';
import type { Agent } from '../../types.js';

// ── Constants ─────────────────────────────────────────────────────

const TEST_ROOT = testRoot('coordination-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'coordination-e2e.db');
const INSTANCE_ID = 'inst_e2e_test';

// ── Shared state ──────────────────────────────────────────────────

let agent1: Agent;
let agent2: Agent;
let hiveId: string;
let swarmId1: string;
let swarmId2: string;
let syncGroupId: string;
let syncGroupPrivateKey: string;
let nodeAId: string;
let nodeBId: string;
let nodeCId: string;
let nodeDId: string;
let resourceId1: string;
let resourceId2: string;

let service: CoordinationService;

// ── Helpers ───────────────────────────────────────────────────────

function makeEvent(overrides: Partial<HiveEvent> & { event_type: string; payload: string }): HiveEvent {
  const payload = overrides.payload;
  return {
    id: overrides.id ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sync_group_id: overrides.sync_group_id ?? syncGroupId,
    seq: overrides.seq ?? 100,
    event_type: overrides.event_type as HiveEvent['event_type'],
    origin_instance_id: overrides.origin_instance_id ?? 'inst_remote_e2e',
    origin_ts: overrides.origin_ts ?? Date.now(),
    payload,
    signature: overrides.signature ?? signEvent(payload, syncGroupPrivateKey),
    received_at: overrides.received_at ?? new Date().toISOString(),
    is_local: overrides.is_local ?? 0,
  };
}

// ── Setup / Teardown ──────────────────────────────────────────────

describe('Coordination E2E — Single Instance Integration', () => {
  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    // Ensure origin columns exist for resource materializer tests
    const db = getDatabase();
    try {
      db.exec(`
        ALTER TABLE syncable_resources ADD COLUMN origin_instance_id TEXT;
        ALTER TABLE syncable_resources ADD COLUMN origin_resource_id TEXT;
        ALTER TABLE syncable_resources ADD COLUMN sync_event_id TEXT;
      `);
    } catch {
      // Columns may already exist
    }
    try {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_origin
          ON syncable_resources(origin_instance_id, origin_resource_id);
      `);
    } catch {
      // Index may already exist
    }

    // 1. Create 2 agents
    const { agent: a1 } = await agentsDAL.createAgent({
      name: 'e2e-agent-1',
      description: 'First agent for e2e tests',
    });
    agent1 = a1;

    const { agent: a2 } = await agentsDAL.createAgent({
      name: 'e2e-agent-2',
      description: 'Second agent for e2e tests',
    });
    agent2 = a2;

    // 2. Create 1 hive
    const hive = hivesDAL.createHive({
      name: 'e2e-test-hive',
      description: 'Hive for e2e integration tests',
      owner_id: agent1.id,
    });
    hiveId = hive.id;

    // 3. Create 2 MAP swarms (needed for FK constraints)
    const swarm1 = mapDAL.createSwarm(agent1.id, {
      name: 'e2e-swarm-1',
      map_endpoint: 'ws://localhost:10001/map',
      map_transport: 'websocket',
    });
    swarmId1 = swarm1.id;

    const swarm2 = mapDAL.createSwarm(agent2.id, {
      name: 'e2e-swarm-2',
      map_endpoint: 'ws://localhost:10002/map',
      map_transport: 'websocket',
    });
    swarmId2 = swarm2.id;

    // Join both swarms to the hive (needed for capability discovery)
    mapDAL.joinHive(swarmId1, hiveId);
    mapDAL.joinHive(swarmId2, hiveId);

    // 4. Create a sync group (needed for sync hooks)
    const syncGroup = syncGroupsDAL.createSyncGroup(hiveId, 'sync:e2e-test', INSTANCE_ID);
    syncGroupId = syncGroup.id;
    syncGroupPrivateKey = syncGroup.instance_signing_key_private;

    // 5. Register MAP nodes with coordination capabilities
    const nodeA = mapDAL.createNode({
      swarm_id: swarmId1,
      map_agent_id: 'agent-a',
      name: 'Node A',
      role: 'coordinator',
      capabilities: {
        coordination: {
          accepts_tasks: true,
          task_types: ['code_review', 'testing'],
          accepts_messages: true,
        },
      },
    });
    nodeAId = nodeA.id;

    const nodeB = mapDAL.createNode({
      swarm_id: swarmId1,
      map_agent_id: 'agent-b',
      name: 'Node B',
      role: 'deployer',
      capabilities: {
        coordination: {
          accepts_tasks: true,
          task_types: ['deployment'],
          accepts_messages: false,
        },
      },
    });
    nodeBId = nodeB.id;

    const nodeC = mapDAL.createNode({
      swarm_id: swarmId2,
      map_agent_id: 'agent-c',
      name: 'Node C',
      role: 'messenger',
      capabilities: {
        coordination: {
          accepts_tasks: false,
          accepts_messages: true,
        },
      },
    });
    nodeCId = nodeC.id;

    const nodeD = mapDAL.createNode({
      swarm_id: swarmId2,
      map_agent_id: 'agent-d',
      name: 'Node D',
      role: 'worker',
      capabilities: {},
    });
    nodeDId = nodeD.id;

    // 6. Create 2 syncable resources
    const res1 = resourcesDAL.createResource({
      resource_type: 'memory_bank',
      name: 'e2e-memory-bank',
      description: 'Test memory bank for e2e',
      git_remote_url: 'https://github.com/test/e2e-memory-bank.git',
      visibility: 'shared',
      owner_agent_id: agent1.id,
      metadata: { env: 'test' },
    });
    resourceId1 = res1.id;

    const res2 = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'e2e-task-repo',
      description: 'Test task repo for e2e',
      git_remote_url: 'https://github.com/test/e2e-task-repo.git',
      visibility: 'public',
      owner_agent_id: agent2.id,
    });
    resourceId2 = res2.id;

    // 7. Initialize CoordinationService
    service = initCoordinationService();
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    mockBroadcast.mockClear();
    mockSendToSwarm.mockClear();
  });

  // ═══════════════════════════════════════════════════════════════
  // Section 1: Coordination Lifecycle E2E
  // ═══════════════════════════════════════════════════════════════

  describe('Coordination Lifecycle E2E', () => {
    let taskId: string;

    it('should assign a task, persist it, and deliver via WS + MAP', () => {
      const task = service.assignTask(hiveId, {
        title: 'Analyze codebase for security issues',
        description: 'Full security audit',
        priority: 'high',
        assigned_by_agent_id: agent1.id,
        assigned_to_swarm_id: swarmId2,
        context: { scope: 'src/' },
      }, agent1);

      taskId = task.id;

      // Persisted in DB
      const persisted = coordinationDal.findTaskById(taskId);
      expect(persisted).not.toBeNull();
      expect(persisted!.title).toBe('Analyze codebase for security issues');
      expect(persisted!.status).toBe('pending');
      expect(persisted!.hive_id).toBe(hiveId);

      // sendToSwarm called with JSON-RPC notification
      expect(mockSendToSwarm).toHaveBeenCalledWith(
        swarmId2,
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'x-openhive/task.assign',
          params: expect.objectContaining({
            task_id: taskId,
            title: 'Analyze codebase for security issues',
          }),
        }),
      );

      // broadcastToChannel called with task_assigned
      expect(mockBroadcast).toHaveBeenCalledWith(
        `coordination:${hiveId}`,
        expect.objectContaining({
          type: 'task_assigned',
          data: expect.objectContaining({ id: taskId }),
        }),
      );
    });

    it('should update task status and broadcast task_status_updated', () => {
      const updated = service.updateTaskStatus(taskId, {
        status: 'in_progress',
        progress: 50,
      });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('in_progress');
      expect(updated!.progress).toBe(50);
      expect(updated!.completed_at).toBeNull();

      // DB is consistent
      const fromDb = coordinationDal.findTaskById(taskId);
      expect(fromDb!.status).toBe('in_progress');
      expect(fromDb!.progress).toBe(50);

      // Broadcast emitted
      expect(mockBroadcast).toHaveBeenCalledWith(
        `coordination:${hiveId}`,
        expect.objectContaining({ type: 'task_status_updated' }),
      );
    });

    it('should complete a task, set completed_at and result', () => {
      const completed = service.updateTaskStatus(taskId, {
        status: 'completed',
        result: { output: 'done', findings: 3 },
      }, agent2);

      expect(completed).not.toBeNull();
      expect(completed!.status).toBe('completed');
      expect(completed!.completed_at).not.toBeNull();
      expect(completed!.result).toEqual({ output: 'done', findings: 3 });
    });

    it('should send a message, persist it, and deliver via MAP + WS', () => {
      const msg = service.sendMessage({
        hive_id: hiveId,
        from_swarm_id: swarmId1,
        to_swarm_id: swarmId2,
        content_type: 'text',
        content: 'Security audit complete',
        metadata: { thread: 'security' },
      });

      expect(msg.id).toMatch(/^sm_/);

      // Persisted
      const fromDb = coordinationDal.findMessageById(msg.id);
      expect(fromDb).not.toBeNull();
      expect(fromDb!.content).toBe('Security audit complete');

      // MAP delivery
      expect(mockSendToSwarm).toHaveBeenCalledWith(
        swarmId2,
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'x-openhive/message.send',
          params: expect.objectContaining({
            message_id: msg.id,
            content: 'Security audit complete',
          }),
        }),
      );

      // WS broadcast
      expect(mockBroadcast).toHaveBeenCalledWith(
        `coordination:${hiveId}`,
        expect.objectContaining({ type: 'swarm_message_received' }),
      );
    });

    it('should share context with TTL, compute expires_at, and deliver to each target', () => {
      const ctx = service.shareContext(hiveId, {
        source_swarm_id: swarmId1,
        context_type: 'environment',
        data: { runtime: 'node', version: '20.x' },
        target_swarm_ids: [swarmId2],
        ttl_seconds: 300,
      });

      expect(ctx.id).toMatch(/^sc_/);

      // expires_at should be set roughly 300 seconds in the future
      expect(ctx.expires_at).not.toBeNull();
      const expiresAt = new Date(ctx.expires_at!);
      const now = Date.now();
      expect(expiresAt.getTime()).toBeGreaterThan(now + 200 * 1000);
      expect(expiresAt.getTime()).toBeLessThan(now + 400 * 1000);

      // sendToSwarm called for the target swarm
      expect(mockSendToSwarm).toHaveBeenCalledWith(
        swarmId2,
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'x-openhive/context.share',
        }),
      );

      // WS broadcast
      expect(mockBroadcast).toHaveBeenCalledWith(
        `coordination:${hiveId}`,
        expect.objectContaining({ type: 'context_shared' }),
      );
    });

    it('should complete a full task lifecycle: assign -> accept -> in_progress -> completed', () => {
      // Assign
      const task = service.assignTask(hiveId, {
        title: 'Full lifecycle task',
        priority: 'medium',
        assigned_by_agent_id: agent1.id,
        assigned_to_swarm_id: swarmId2,
      }, agent1);

      expect(task.status).toBe('pending');

      // Accept
      const accepted = service.updateTaskStatus(task.id, { status: 'accepted' }, agent2);
      expect(accepted!.status).toBe('accepted');

      // In progress
      const inProgress = service.updateTaskStatus(task.id, {
        status: 'in_progress',
        progress: 60,
      });
      expect(inProgress!.status).toBe('in_progress');
      expect(inProgress!.progress).toBe(60);

      // Completed
      const completed = service.updateTaskStatus(task.id, {
        status: 'completed',
        progress: 100,
        result: { summary: 'All tests passed' },
      }, agent2);

      expect(completed!.status).toBe('completed');
      expect(completed!.progress).toBe(100);
      expect(completed!.result).toEqual({ summary: 'All tests passed' });
      expect(completed!.completed_at).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Section 2: Sync Hook -> Event Log Integration
  // ═══════════════════════════════════════════════════════════════

  describe('Sync Hook -> Event Log Integration', () => {
    it('should record a coordination_task_offered event via hook', () => {
      const seqBefore = syncGroupsDAL.getSeq(syncGroupId);

      const task = coordinationDal.createTask(hiveId, {
        title: 'Hook test task',
        priority: 'low',
        assigned_by_agent_id: agent1.id,
        assigned_to_swarm_id: swarmId2,
      });

      onCoordinationTaskOffered(task, agent1);

      const { events } = syncEventsDAL.getEventsSince(syncGroupId, seqBefore, 100);
      const taskEvent = events.find(e => e.event_type === 'coordination_task_offered');

      expect(taskEvent).toBeDefined();
      expect(taskEvent!.is_local).toBe(1);

      const payload = JSON.parse(taskEvent!.payload);
      expect(payload.task_id).toBe(task.id);
      expect(payload.title).toBe('Hook test task');
      expect(payload.offered_by.agent_id).toBe(agent1.id);
      expect(payload.hive_id).toBe(hiveId);
    });

    it('should record a coordination_message event via hook', () => {
      const seqBefore = syncGroupsDAL.getSeq(syncGroupId);

      const msg = coordinationDal.createMessage({
        from_swarm_id: swarmId1,
        to_swarm_id: swarmId2,
        hive_id: hiveId,
        content_type: 'text',
        content: 'Hook message test',
      });

      onCoordinationMessage(msg);

      const { events } = syncEventsDAL.getEventsSince(syncGroupId, seqBefore, 100);
      const msgEvent = events.find(e => e.event_type === 'coordination_message');

      expect(msgEvent).toBeDefined();
      expect(msgEvent!.is_local).toBe(1);

      const payload = JSON.parse(msgEvent!.payload);
      expect(payload.message_id).toBe(msg.id);
      expect(payload.from_swarm_id).toBe(swarmId1);
      expect(payload.content).toBe('Hook message test');
    });

    it('should record a resource_published event via hook', () => {
      const seqBefore = syncGroupsDAL.getSeq(syncGroupId);

      const resource = {
        id: 'res_hook_test',
        resource_type: 'memory_bank',
        name: 'hook-test-resource',
        description: 'Published via hook',
        git_remote_url: 'https://github.com/test/hook-resource.git',
        visibility: 'shared',
      };

      onResourcePublished(resource, ['test', 'hook'], { source: 'e2e' }, agent1);

      const { events } = syncEventsDAL.getEventsSince(syncGroupId, seqBefore, 100);
      const resEvent = events.find(e => e.event_type === 'resource_published');

      expect(resEvent).toBeDefined();
      expect(resEvent!.is_local).toBe(1);

      const payload = JSON.parse(resEvent!.payload);
      expect(payload.resource_id).toBe('res_hook_test');
      expect(payload.name).toBe('hook-test-resource');
      expect(payload.tags).toEqual(['test', 'hook']);
      expect(payload.metadata).toEqual({ source: 'e2e' });
      expect(payload.owner.agent_id).toBe(agent1.id);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Section 3: Materializer E2E (round-trip)
  // ═══════════════════════════════════════════════════════════════

  describe('Materializer E2E (round-trip)', () => {
    it('should round-trip: coordination task hook -> event log -> materializer', () => {
      const seqBefore = syncGroupsDAL.getSeq(syncGroupId);

      // Fire the hook with a unique task
      const task = coordinationDal.createTask(hiveId, {
        title: 'Materializer round-trip task',
        description: 'Testing materializer round-trip',
        priority: 'high',
        assigned_by_agent_id: agent1.id,
        assigned_to_swarm_id: swarmId2,
        context: { origin: 'e2e' },
      });

      onCoordinationTaskOffered(task, agent1);

      // Read the event from the log
      const { events } = syncEventsDAL.getEventsSince(syncGroupId, seqBefore, 100);
      const taskEvent = events.find(e => e.event_type === 'coordination_task_offered');
      expect(taskEvent).toBeDefined();

      // Delete the task so the materializer can re-create it (simulating remote arrival)
      const db = getDatabase();
      db.prepare('DELETE FROM coordination_tasks WHERE id = ?').run(task.id);
      expect(coordinationDal.findTaskById(task.id)).toBeNull();

      // Materialize the event as if it came from a remote instance
      materializeEvent(taskEvent!, hiveId, 'e2e-test-hive', false);

      // The materializer creates a NEW task (with a new ID via coordinationDal.createTask)
      // Verify a task with the same title exists in the DB
      const { data: tasks } = coordinationDal.listTasks({ hive_id: hiveId });
      const materialized = tasks.find(t => t.title === 'Materializer round-trip task');
      expect(materialized).toBeDefined();
      expect(materialized!.priority).toBe('high');
      expect(materialized!.assigned_by_agent_id).toBe(agent1.id);
    });

    it('should round-trip: resource published hook -> event log -> materializer', () => {
      const seqBefore = syncGroupsDAL.getSeq(syncGroupId);

      const resource = {
        id: 'res_mat_rt',
        resource_type: 'skill',
        name: 'materializer-roundtrip-skill',
        description: 'Skill for materializer round-trip',
        git_remote_url: 'https://github.com/test/mat-rt-skill.git',
        visibility: 'public',
      };

      onResourcePublished(resource, ['e2e'], null, agent2);

      // Read event from log
      const { events } = syncEventsDAL.getEventsSince(syncGroupId, seqBefore, 100);
      const resEvent = events.find(
        e => e.event_type === 'resource_published'
          && JSON.parse(e.payload).resource_id === 'res_mat_rt',
      );
      expect(resEvent).toBeDefined();

      // Materialize as remote (isLocal=false, different origin instance)
      const remoteEvent = makeEvent({
        ...resEvent!,
        origin_instance_id: 'inst_remote_mat',
        event_type: resEvent!.event_type,
        payload: resEvent!.payload,
      });

      materializeEvent(remoteEvent, hiveId, 'e2e-test-hive', false);

      // Verify resource was materialized — find by searching the DB directly
      const db = getDatabase();
      const row = db.prepare(
        "SELECT * FROM syncable_resources WHERE origin_instance_id = 'inst_remote_mat' AND origin_resource_id = 'res_mat_rt'",
      ).get() as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(row!.name).toBe('materializer-roundtrip-skill');
      expect(row!.resource_type).toBe('skill');
    });

    it('should round-trip: coordination message hook -> event log -> materializer', () => {
      const seqBefore = syncGroupsDAL.getSeq(syncGroupId);

      const msg = coordinationDal.createMessage({
        from_swarm_id: swarmId1,
        to_swarm_id: swarmId2,
        hive_id: hiveId,
        content_type: 'text',
        content: 'Materializer message round-trip',
      });

      onCoordinationMessage(msg);

      // Read event from log
      const { events } = syncEventsDAL.getEventsSince(syncGroupId, seqBefore, 100);
      const msgEvent = events.find(
        e => e.event_type === 'coordination_message'
          && JSON.parse(e.payload).message_id === msg.id,
      );
      expect(msgEvent).toBeDefined();

      // Delete original message so materializer can create a new one
      const db = getDatabase();
      db.prepare('DELETE FROM swarm_messages WHERE id = ?').run(msg.id);
      expect(coordinationDal.findMessageById(msg.id)).toBeNull();

      // Materialize as remote
      const remoteEvent = makeEvent({
        ...msgEvent!,
        origin_instance_id: 'inst_remote_msg',
        event_type: msgEvent!.event_type,
        payload: msgEvent!.payload,
      });

      materializeEvent(remoteEvent, hiveId, 'e2e-test-hive', false);

      // The materializer creates a new message (with a new generated ID)
      // Verify a message with the same content exists
      const { data: messages } = coordinationDal.listMessages({ to_swarm_id: swarmId2 });
      const materialized = messages.find(m => m.content === 'Materializer message round-trip');
      expect(materialized).toBeDefined();
      expect(materialized!.from_swarm_id).toBe(swarmId1);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Section 4: Capability-Based Discovery
  // ═══════════════════════════════════════════════════════════════

  describe('Capability-Based Discovery', () => {
    it('should discover nodes by task_type code_review (Node A only)', () => {
      const nodes = discoverByCapability(hiveId, { task_type: 'code_review' });
      expect(nodes.length).toBe(1);
      expect(nodes[0].id).toBe(nodeAId);
      expect(nodes[0].name).toBe('Node A');
    });

    it('should discover nodes by task_type deployment (Node B only)', () => {
      const nodes = discoverByCapability(hiveId, { task_type: 'deployment' });
      expect(nodes.length).toBe(1);
      expect(nodes[0].id).toBe(nodeBId);
      expect(nodes[0].name).toBe('Node B');
    });

    it('should discover nodes that accept messages (Nodes A and C)', () => {
      const nodes = discoverByCapability(hiveId, { accepts_messages: true });
      expect(nodes.length).toBe(2);
      const nodeIds = nodes.map(n => n.id);
      expect(nodeIds).toContain(nodeAId);
      expect(nodeIds).toContain(nodeCId);
    });

    it('should discover nodes that do not accept messages (Node B only)', () => {
      const nodes = discoverByCapability(hiveId, { accepts_messages: false });
      expect(nodes.length).toBe(1);
      expect(nodes[0].id).toBe(nodeBId);
    });

    it('should return empty array for unknown task_type', () => {
      const nodes = discoverByCapability(hiveId, { task_type: 'unknown' });
      expect(nodes).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Section 5: Resource Injection at Spawn
  // ═══════════════════════════════════════════════════════════════

  describe('Resource Injection at Spawn', () => {
    it('should look up resources by ID correctly', () => {
      const res1 = findResourceById(resourceId1);
      expect(res1).not.toBeNull();
      expect(res1!.name).toBe('e2e-memory-bank');
      expect(res1!.resource_type).toBe('memory_bank');

      const res2 = findResourceById(resourceId2);
      expect(res2).not.toBeNull();
      expect(res2!.name).toBe('e2e-task-repo');
      expect(res2!.resource_type).toBe('task');
    });

    it('should subscribe an agent to a resource and verify subscription', () => {
      const sub = subscribeToResource(agent2.id, resourceId1, 'read');
      expect(sub).not.toBeNull();
      expect(sub!.agent_id).toBe(agent2.id);
      expect(sub!.resource_id).toBe(resourceId1);
      expect(sub!.permission).toBe('read');

      // Verify via getSubscription
      const retrieved = getSubscription(agent2.id, resourceId1);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.permission).toBe('read');
    });

    it('should construct the correct bootstrap token shape from resources', () => {
      // Mimic SwarmManager's resource resolution
      const resourceIds = [resourceId1, resourceId2];
      const resources = resourceIds
        .map(id => findResourceById(id))
        .filter((r): r is NonNullable<typeof r> => r !== null)
        .map(r => ({
          id: r.id,
          resource_type: r.resource_type,
          name: r.name,
          git_remote_url: r.git_remote_url,
          metadata: r.metadata,
        }));

      expect(resources).toHaveLength(2);

      // Verify shape of each resource entry
      for (const r of resources) {
        expect(r).toHaveProperty('id');
        expect(r).toHaveProperty('resource_type');
        expect(r).toHaveProperty('name');
        expect(r).toHaveProperty('git_remote_url');
        expect(r).toHaveProperty('metadata');
      }

      // Verify specific values
      const mb = resources.find(r => r.resource_type === 'memory_bank');
      expect(mb).toBeDefined();
      expect(mb!.name).toBe('e2e-memory-bank');
      expect(mb!.git_remote_url).toBe('https://github.com/test/e2e-memory-bank.git');
      expect(mb!.metadata).toEqual({ env: 'test' });
    });

    it('should return null for a nonexistent resource ID', () => {
      const notFound = findResourceById('res_does_not_exist');
      expect(notFound).toBeNull();
    });
  });
});
