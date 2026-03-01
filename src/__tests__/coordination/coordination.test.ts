/**
 * Comprehensive test suite for coordination subsystem.
 * Covers: coordination DAL (tasks, messages, shared contexts),
 * coordination listener (type guard + dispatch), and coordination types.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as mapDAL from '../../db/dal/map.js';
import * as coordinationDAL from '../../db/dal/coordination.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock the coordination service for listener tests
vi.mock('../../coordination/index.js', () => ({
  getCoordinationService: vi.fn(),
}));

import { getCoordinationService } from '../../coordination/index.js';
const mockGetService = vi.mocked(getCoordinationService);

import { isCoordinationMessage, handleCoordinationMessage } from '../../coordination/listener.js';
import { createCoordinationNotification } from '../../coordination/types.js';
import type {
  MapCoordinationMessage,
  TaskAssignParams,
  TaskStatusParams,
  ContextShareParams,
  MessageSendParams,
} from '../../coordination/types.js';

const TEST_ROOT = testRoot('coordination');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'coordination-test.db');

describe('Coordination System', () => {
  let agentId: string;
  let agent2Id: string;
  let hiveId: string;
  let swarmId1: string;
  let swarmId2: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    // Create two agents
    const { agent } = await agentsDAL.createAgent({
      name: 'coord-test-agent-1',
      description: 'Agent 1 for coordination tests',
    });
    agentId = agent.id;

    const { agent: agent2 } = await agentsDAL.createAgent({
      name: 'coord-test-agent-2',
      description: 'Agent 2 for coordination tests',
    });
    agent2Id = agent2.id;

    // Create a hive
    const hive = hivesDAL.createHive({
      name: 'coord-test-hive',
      description: 'Test hive for coordination',
      owner_id: agentId,
    });
    hiveId = hive.id;

    // Create two MAP swarms (coordination_tasks references map_swarms via FK)
    const swarm1 = mapDAL.createSwarm(agentId, {
      name: 'coord-swarm-1',
      map_endpoint: 'ws://localhost:9001/map',
      map_transport: 'websocket',
    });
    swarmId1 = swarm1.id;

    const swarm2 = mapDAL.createSwarm(agent2Id, {
      name: 'coord-swarm-2',
      map_endpoint: 'ws://localhost:9002/map',
      map_transport: 'websocket',
    });
    swarmId2 = swarm2.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 1: Coordination Tasks DAL
  // ═══════════════════════════════════════════════════════════════

  describe('Tasks DAL', () => {
    let taskId: string;

    it('should create a task with defaults', () => {
      const task = coordinationDAL.createTask(hiveId, {
        title: 'Analyze dataset',
        assigned_by_agent_id: agentId,
        assigned_to_swarm_id: swarmId2,
      });

      taskId = task.id;

      expect(task.id).toMatch(/^ct_/);
      expect(task.hive_id).toBe(hiveId);
      expect(task.title).toBe('Analyze dataset');
      expect(task.description).toBeNull();
      expect(task.priority).toBe('medium');
      expect(task.status).toBe('pending');
      expect(task.assigned_by_agent_id).toBe(agentId);
      expect(task.assigned_by_swarm_id).toBeNull();
      expect(task.assigned_to_swarm_id).toBe(swarmId2);
      expect(task.context).toBeNull();
      expect(task.result).toBeNull();
      expect(task.error).toBeNull();
      expect(task.progress).toBe(0);
      expect(task.deadline).toBeNull();
      expect(task.completed_at).toBeNull();
      expect(task.created_at).toBeDefined();
      expect(task.updated_at).toBeDefined();
    });

    it('should create a task with all optional fields', () => {
      const deadline = new Date(Date.now() + 86400000).toISOString();
      const task = coordinationDAL.createTask(hiveId, {
        title: 'Full-featured task',
        description: 'This task has every field set',
        priority: 'critical',
        assigned_by_agent_id: agentId,
        assigned_by_swarm_id: swarmId1,
        assigned_to_swarm_id: swarmId2,
        context: { key: 'value', nested: { a: 1 } },
        deadline,
      });

      expect(task.priority).toBe('critical');
      expect(task.description).toBe('This task has every field set');
      expect(task.assigned_by_swarm_id).toBe(swarmId1);
      expect(task.context).toEqual({ key: 'value', nested: { a: 1 } });
      expect(task.deadline).toBe(deadline);
    });

    it('should create tasks with different priority levels', () => {
      const priorities = ['low', 'medium', 'high', 'critical'] as const;
      for (const priority of priorities) {
        const task = coordinationDAL.createTask(hiveId, {
          title: `Task with ${priority} priority`,
          priority,
          assigned_by_agent_id: agentId,
          assigned_to_swarm_id: swarmId2,
        });
        expect(task.priority).toBe(priority);
      }
    });

    it('should generate unique IDs for each task', () => {
      const task1 = coordinationDAL.createTask(hiveId, {
        title: 'Unique task 1',
        assigned_by_agent_id: agentId,
        assigned_to_swarm_id: swarmId2,
      });
      const task2 = coordinationDAL.createTask(hiveId, {
        title: 'Unique task 2',
        assigned_by_agent_id: agentId,
        assigned_to_swarm_id: swarmId2,
      });
      expect(task1.id).not.toBe(task2.id);
    });

    it('should find a task by ID', () => {
      const found = coordinationDAL.findTaskById(taskId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(taskId);
      expect(found!.title).toBe('Analyze dataset');
    });

    it('should return null for unknown task ID', () => {
      const found = coordinationDAL.findTaskById('ct_nonexistent');
      expect(found).toBeNull();
    });

    it('should update task status', () => {
      const updated = coordinationDAL.updateTask(taskId, {
        status: 'in_progress',
      });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('in_progress');
      expect(updated!.completed_at).toBeNull(); // Not completed yet
    });

    it('should update task progress', () => {
      const updated = coordinationDAL.updateTask(taskId, {
        progress: 50,
      });
      expect(updated).not.toBeNull();
      expect(updated!.progress).toBe(50);
    });

    it('should set completed_at when status is completed', () => {
      const updated = coordinationDAL.updateTask(taskId, {
        status: 'completed',
        result: { output: 'Analysis complete', rows_processed: 1000 },
      });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.completed_at).not.toBeNull();
      expect(updated!.result).toEqual({ output: 'Analysis complete', rows_processed: 1000 });
    });

    it('should set completed_at when status is failed', () => {
      const failTask = coordinationDAL.createTask(hiveId, {
        title: 'Task that will fail',
        assigned_by_agent_id: agentId,
        assigned_to_swarm_id: swarmId2,
      });

      const updated = coordinationDAL.updateTask(failTask.id, {
        status: 'failed',
        error: 'Out of memory',
      });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('failed');
      expect(updated!.completed_at).not.toBeNull();
      expect(updated!.error).toBe('Out of memory');
    });

    it('should return null when updating a non-existent task', () => {
      const updated = coordinationDAL.updateTask('ct_nonexistent', {
        status: 'completed',
      });
      // updateTask calls findTaskById after the UPDATE, which returns null for unknown IDs
      expect(updated).toBeNull();
    });

    it('should list tasks without filters', () => {
      const { data, total } = coordinationDAL.listTasks();
      expect(data.length).toBeGreaterThan(0);
      expect(total).toBeGreaterThan(0);
      expect(total).toBe(data.length); // No pagination limit hit
    });

    it('should list tasks filtered by hive_id', () => {
      const { data, total } = coordinationDAL.listTasks({ hive_id: hiveId });
      expect(data.length).toBeGreaterThan(0);
      expect(data.every(t => t.hive_id === hiveId)).toBe(true);
      expect(total).toBe(data.length);
    });

    it('should list tasks filtered by status', () => {
      const { data } = coordinationDAL.listTasks({ status: 'completed' });
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data.every(t => t.status === 'completed')).toBe(true);
    });

    it('should list tasks filtered by assigned_to_swarm_id', () => {
      const { data } = coordinationDAL.listTasks({
        assigned_to_swarm_id: swarmId2,
      });
      expect(data.length).toBeGreaterThan(0);
      expect(data.every(t => t.assigned_to_swarm_id === swarmId2)).toBe(true);
    });

    it('should return empty list for non-matching filters', () => {
      const { data, total } = coordinationDAL.listTasks({
        hive_id: 'nonexistent_hive',
      });
      expect(data).toEqual([]);
      expect(total).toBe(0);
    });

    it('should paginate task results', () => {
      const { data: allTasks, total: allTotal } = coordinationDAL.listTasks({ hive_id: hiveId });
      expect(allTotal).toBeGreaterThan(1); // We have multiple tasks

      // Fetch first page with limit 2
      const { data: page1, total: total1 } = coordinationDAL.listTasks({
        hive_id: hiveId,
        limit: 2,
        offset: 0,
      });
      expect(page1.length).toBe(2);
      expect(total1).toBe(allTotal);

      // Fetch second page
      const { data: page2 } = coordinationDAL.listTasks({
        hive_id: hiveId,
        limit: 2,
        offset: 2,
      });
      expect(page2.length).toBeGreaterThan(0);

      // Pages should not overlap
      const page1Ids = new Set(page1.map(t => t.id));
      const page2Ids = new Set(page2.map(t => t.id));
      for (const id of page2Ids) {
        expect(page1Ids.has(id)).toBe(false);
      }
    });

    it('should combine multiple filters', () => {
      const { data } = coordinationDAL.listTasks({
        hive_id: hiveId,
        status: 'pending',
        assigned_to_swarm_id: swarmId2,
      });
      expect(data.every(t =>
        t.hive_id === hiveId &&
        t.status === 'pending' &&
        t.assigned_to_swarm_id === swarmId2,
      )).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 2: Swarm Messages DAL
  // ═══════════════════════════════════════════════════════════════

  describe('Messages DAL', () => {
    let messageId: string;

    it('should create a message with defaults', () => {
      const msg = coordinationDAL.createMessage({
        from_swarm_id: swarmId1,
        to_swarm_id: swarmId2,
        content: 'Hello from swarm 1',
      });

      messageId = msg.id;

      expect(msg.id).toMatch(/^sm_/);
      expect(msg.hive_id).toBeNull();
      expect(msg.from_swarm_id).toBe(swarmId1);
      expect(msg.to_swarm_id).toBe(swarmId2);
      expect(msg.content_type).toBe('text');
      expect(msg.content).toBe('Hello from swarm 1');
      expect(msg.reply_to).toBeNull();
      expect(msg.metadata).toBeNull();
      expect(msg.read_at).toBeNull();
      expect(msg.created_at).toBeDefined();
    });

    it('should create a message with all optional fields', () => {
      const msg = coordinationDAL.createMessage({
        hive_id: hiveId,
        from_swarm_id: swarmId2,
        to_swarm_id: swarmId1,
        content_type: 'json',
        content: JSON.stringify({ action: 'status_report', data: [1, 2, 3] }),
        reply_to: messageId,
        metadata: { urgency: 'high', thread_id: 'thread-001' },
      });

      expect(msg.hive_id).toBe(hiveId);
      expect(msg.content_type).toBe('json');
      expect(msg.reply_to).toBe(messageId);
      expect(msg.metadata).toEqual({ urgency: 'high', thread_id: 'thread-001' });
    });

    it('should create a message with binary_ref content type', () => {
      const msg = coordinationDAL.createMessage({
        from_swarm_id: swarmId1,
        to_swarm_id: swarmId2,
        content_type: 'binary_ref',
        content: 's3://bucket/path/to/artifact.tar.gz',
      });

      expect(msg.content_type).toBe('binary_ref');
      expect(msg.content).toBe('s3://bucket/path/to/artifact.tar.gz');
    });

    it('should generate unique IDs for each message', () => {
      const msg1 = coordinationDAL.createMessage({
        from_swarm_id: swarmId1,
        to_swarm_id: swarmId2,
        content: 'Message A',
      });
      const msg2 = coordinationDAL.createMessage({
        from_swarm_id: swarmId1,
        to_swarm_id: swarmId2,
        content: 'Message B',
      });
      expect(msg1.id).not.toBe(msg2.id);
    });

    it('should find a message by ID', () => {
      const found = coordinationDAL.findMessageById(messageId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(messageId);
      expect(found!.content).toBe('Hello from swarm 1');
    });

    it('should return null for unknown message ID', () => {
      const found = coordinationDAL.findMessageById('sm_nonexistent');
      expect(found).toBeNull();
    });

    it('should mark a message as read', () => {
      coordinationDAL.markMessageRead(messageId);

      const found = coordinationDAL.findMessageById(messageId);
      expect(found).not.toBeNull();
      expect(found!.read_at).not.toBeNull();
    });

    it('should list messages without filters', () => {
      const { data, total } = coordinationDAL.listMessages();
      expect(data.length).toBeGreaterThan(0);
      expect(total).toBeGreaterThan(0);
    });

    it('should list messages filtered by to_swarm_id', () => {
      const { data } = coordinationDAL.listMessages({ to_swarm_id: swarmId2 });
      expect(data.length).toBeGreaterThan(0);
      expect(data.every(m => m.to_swarm_id === swarmId2)).toBe(true);
    });

    it('should list messages filtered by from_swarm_id', () => {
      const { data } = coordinationDAL.listMessages({ from_swarm_id: swarmId1 });
      expect(data.length).toBeGreaterThan(0);
      expect(data.every(m => m.from_swarm_id === swarmId1)).toBe(true);
    });

    it('should list messages filtered by hive_id', () => {
      const { data } = coordinationDAL.listMessages({ hive_id: hiveId });
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data.every(m => m.hive_id === hiveId)).toBe(true);
    });

    it('should list messages filtered by since timestamp', () => {
      // SQLite datetime('now') produces 'YYYY-MM-DD HH:MM:SS' (UTC, no T/Z).
      // The DAL compares with `created_at > ?`, so we must use the same format.
      const toSqliteDatetime = (d: Date) =>
        d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');

      // Use a timestamp in the past — all messages should appear
      const pastDate = toSqliteDatetime(new Date(Date.now() - 3600000));
      const { data: recent } = coordinationDAL.listMessages({ since: pastDate });
      expect(recent.length).toBeGreaterThan(0);

      // Use a future timestamp — no messages should appear
      const futureDate = toSqliteDatetime(new Date(Date.now() + 3600000));
      const { data: future } = coordinationDAL.listMessages({ since: futureDate });
      expect(future.length).toBe(0);
    });

    it('should return empty list for non-matching filters', () => {
      const { data, total } = coordinationDAL.listMessages({
        to_swarm_id: 'nonexistent_swarm',
      });
      expect(data).toEqual([]);
      expect(total).toBe(0);
    });

    it('should paginate message results', () => {
      const { data: all, total: allTotal } = coordinationDAL.listMessages();
      expect(allTotal).toBeGreaterThan(1);

      const { data: page1, total: total1 } = coordinationDAL.listMessages({
        limit: 2,
        offset: 0,
      });
      expect(page1.length).toBe(2);
      expect(total1).toBe(allTotal);

      const { data: page2 } = coordinationDAL.listMessages({
        limit: 2,
        offset: 2,
      });

      // Pages should not overlap
      const page1Ids = new Set(page1.map(m => m.id));
      for (const m of page2) {
        expect(page1Ids.has(m.id)).toBe(false);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 3: Shared Contexts DAL
  // ═══════════════════════════════════════════════════════════════

  describe('Shared Contexts DAL', () => {
    let contextId: string;

    it('should create a context without TTL', () => {
      const ctx = coordinationDAL.createContext(hiveId, {
        source_swarm_id: swarmId1,
        context_type: 'environment',
        data: { os: 'linux', cpu_count: 8, memory_gb: 32 },
      });

      contextId = ctx.id;

      expect(ctx.id).toMatch(/^sc_/);
      expect(ctx.hive_id).toBe(hiveId);
      expect(ctx.source_swarm_id).toBe(swarmId1);
      expect(ctx.context_type).toBe('environment');
      expect(ctx.data).toEqual({ os: 'linux', cpu_count: 8, memory_gb: 32 });
      expect(ctx.expires_at).toBeNull();
      expect(ctx.created_at).toBeDefined();
    });

    it('should create a context with TTL and compute expires_at', () => {
      const beforeCreate = new Date();
      const ctx = coordinationDAL.createContext(hiveId, {
        source_swarm_id: swarmId2,
        context_type: 'session_state',
        data: { step: 3, tokens_used: 500 },
        ttl_seconds: 3600, // 1 hour
      });

      expect(ctx.expires_at).not.toBeNull();
      const expiresAt = new Date(ctx.expires_at!);
      // expires_at should be roughly 1 hour from now
      const expectedMin = new Date(beforeCreate.getTime() + 3500 * 1000);
      const expectedMax = new Date(beforeCreate.getTime() + 3700 * 1000);
      expect(expiresAt.getTime()).toBeGreaterThan(expectedMin.getTime());
      expect(expiresAt.getTime()).toBeLessThan(expectedMax.getTime());
    });

    it('should create a context with target_swarm_ids in data', () => {
      const ctx = coordinationDAL.createContext(hiveId, {
        source_swarm_id: swarmId1,
        context_type: 'tool_results',
        data: { results: [{ tool: 'search', output: 'found 42 results' }] },
        target_swarm_ids: [swarmId2],
      });

      // target_swarm_ids is not stored in the DB row directly,
      // but the context should be created successfully
      expect(ctx.id).toMatch(/^sc_/);
      expect(ctx.context_type).toBe('tool_results');
    });

    it('should generate unique IDs for each context', () => {
      const ctx1 = coordinationDAL.createContext(hiveId, {
        source_swarm_id: swarmId1,
        context_type: 'test',
        data: { n: 1 },
      });
      const ctx2 = coordinationDAL.createContext(hiveId, {
        source_swarm_id: swarmId1,
        context_type: 'test',
        data: { n: 2 },
      });
      expect(ctx1.id).not.toBe(ctx2.id);
    });

    it('should find a context by ID', () => {
      const found = coordinationDAL.findContextById(contextId);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(contextId);
      expect(found!.context_type).toBe('environment');
    });

    it('should return null for unknown context ID', () => {
      const found = coordinationDAL.findContextById('sc_nonexistent');
      expect(found).toBeNull();
    });

    it('should list contexts without filters (excludes expired)', () => {
      const { data, total } = coordinationDAL.listContexts();
      expect(data.length).toBeGreaterThan(0);
      expect(total).toBeGreaterThan(0);
    });

    it('should list contexts filtered by hive_id', () => {
      const { data } = coordinationDAL.listContexts({ hive_id: hiveId });
      expect(data.length).toBeGreaterThan(0);
      expect(data.every(c => c.hive_id === hiveId)).toBe(true);
    });

    it('should list contexts filtered by context_type', () => {
      const { data } = coordinationDAL.listContexts({ context_type: 'environment' });
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data.every(c => c.context_type === 'environment')).toBe(true);
    });

    it('should list contexts filtered by source_swarm_id', () => {
      const { data } = coordinationDAL.listContexts({ source_swarm_id: swarmId1 });
      expect(data.length).toBeGreaterThan(0);
      expect(data.every(c => c.source_swarm_id === swarmId1)).toBe(true);
    });

    it('should return empty list for non-matching filters', () => {
      const { data, total } = coordinationDAL.listContexts({
        hive_id: 'nonexistent_hive',
      });
      expect(data).toEqual([]);
      expect(total).toBe(0);
    });

    it('should paginate context results', () => {
      const { total: allTotal } = coordinationDAL.listContexts({ hive_id: hiveId });
      expect(allTotal).toBeGreaterThan(1);

      const { data: page1, total: total1 } = coordinationDAL.listContexts({
        hive_id: hiveId,
        limit: 2,
        offset: 0,
      });
      expect(page1.length).toBe(2);
      expect(total1).toBe(allTotal);

      const { data: page2 } = coordinationDAL.listContexts({
        hive_id: hiveId,
        limit: 2,
        offset: 2,
      });

      const page1Ids = new Set(page1.map(c => c.id));
      for (const c of page2) {
        expect(page1Ids.has(c.id)).toBe(false);
      }
    });

    it('should exclude expired contexts from listing', () => {
      // Insert a context with an already-expired TTL by manipulating the DB directly
      const db = getDatabase();
      const expiredId = 'sc_expired_test';
      db.prepare(`
        INSERT INTO shared_contexts (id, hive_id, source_swarm_id, context_type, data, expires_at)
        VALUES (?, ?, ?, ?, ?, datetime('now', '-1 hour'))
      `).run(expiredId, hiveId, swarmId1, 'expired_type', JSON.stringify({ stale: true }));

      // The expired context should exist in the DB
      const raw = coordinationDAL.findContextById(expiredId);
      expect(raw).not.toBeNull();

      // But should NOT appear in listContexts
      const { data } = coordinationDAL.listContexts({ context_type: 'expired_type' });
      expect(data.find(c => c.id === expiredId)).toBeUndefined();
    });

    it('should delete expired contexts', () => {
      // We already have an expired context from the previous test
      const deleted = coordinationDAL.deleteExpiredContexts();
      expect(deleted).toBeGreaterThanOrEqual(1);

      // The expired context should now be gone entirely
      const raw = coordinationDAL.findContextById('sc_expired_test');
      expect(raw).toBeNull();
    });

    it('should return 0 when no expired contexts exist', () => {
      // All expired contexts were already deleted
      const deleted = coordinationDAL.deleteExpiredContexts();
      expect(deleted).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 4: Coordination Listener — isCoordinationMessage
  // ═══════════════════════════════════════════════════════════════

  describe('isCoordinationMessage', () => {
    it('should accept a valid task.assign message', () => {
      const msg = {
        jsonrpc: '2.0',
        method: 'x-openhive/task.assign',
        params: {
          task_id: 'ct_abc',
          title: 'Do stuff',
          description: 'Please do stuff',
          priority: 'medium',
          assigned_by: agentId,
          assigned_to_swarm: swarmId2,
          hive_id: hiveId,
        },
      };
      expect(isCoordinationMessage(msg)).toBe(true);
    });

    it('should accept a valid task.status message', () => {
      const msg = {
        jsonrpc: '2.0',
        method: 'x-openhive/task.status',
        params: {
          task_id: 'ct_abc',
          status: 'completed',
          progress: 100,
          result: { output: 'done' },
        },
      };
      expect(isCoordinationMessage(msg)).toBe(true);
    });

    it('should accept a valid context.share message', () => {
      const msg = {
        jsonrpc: '2.0',
        method: 'x-openhive/context.share',
        params: {
          context_id: 'sc_xyz',
          source_swarm_id: swarmId1,
          target_swarm_ids: [swarmId2],
          hive_id: hiveId,
          context_type: 'environment',
          data: { key: 'val' },
        },
      };
      expect(isCoordinationMessage(msg)).toBe(true);
    });

    it('should accept a valid message.send message', () => {
      const msg = {
        jsonrpc: '2.0',
        method: 'x-openhive/message.send',
        params: {
          message_id: 'sm_xyz',
          from_swarm_id: swarmId1,
          to_swarm_id: swarmId2,
          content_type: 'text',
          content: 'Hello',
        },
      };
      expect(isCoordinationMessage(msg)).toBe(true);
    });

    it('should reject null', () => {
      expect(isCoordinationMessage(null)).toBe(false);
    });

    it('should reject undefined', () => {
      expect(isCoordinationMessage(undefined)).toBe(false);
    });

    it('should reject a number', () => {
      expect(isCoordinationMessage(42)).toBe(false);
    });

    it('should reject a string', () => {
      expect(isCoordinationMessage('hello')).toBe(false);
    });

    it('should reject an array', () => {
      expect(isCoordinationMessage([1, 2, 3])).toBe(false);
    });

    it('should reject missing jsonrpc field', () => {
      const msg = {
        method: 'x-openhive/task.assign',
        params: { title: 'Test' },
      };
      expect(isCoordinationMessage(msg)).toBe(false);
    });

    it('should reject wrong jsonrpc version', () => {
      const msg = {
        jsonrpc: '1.0',
        method: 'x-openhive/task.assign',
        params: { title: 'Test' },
      };
      expect(isCoordinationMessage(msg)).toBe(false);
    });

    it('should reject invalid method name', () => {
      const msg = {
        jsonrpc: '2.0',
        method: 'x-openhive/unknown.method',
        params: { title: 'Test' },
      };
      expect(isCoordinationMessage(msg)).toBe(false);
    });

    it('should reject non-string method', () => {
      const msg = {
        jsonrpc: '2.0',
        method: 123,
        params: { title: 'Test' },
      };
      expect(isCoordinationMessage(msg)).toBe(false);
    });

    it('should reject missing params', () => {
      const msg = {
        jsonrpc: '2.0',
        method: 'x-openhive/task.assign',
      };
      expect(isCoordinationMessage(msg)).toBe(false);
    });

    it('should reject null params', () => {
      const msg = {
        jsonrpc: '2.0',
        method: 'x-openhive/task.assign',
        params: null,
      };
      expect(isCoordinationMessage(msg)).toBe(false);
    });

    it('should reject non-object params', () => {
      const msg = {
        jsonrpc: '2.0',
        method: 'x-openhive/task.assign',
        params: 'not an object',
      };
      expect(isCoordinationMessage(msg)).toBe(false);
    });

    it('should reject empty object (no jsonrpc, no method, no params)', () => {
      expect(isCoordinationMessage({})).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 5: Coordination Listener — handleCoordinationMessage
  // ═══════════════════════════════════════════════════════════════

  describe('handleCoordinationMessage', () => {
    const mockService = {
      assignTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      shareContext: vi.fn(),
      sendMessage: vi.fn(),
    };

    beforeEach(() => {
      vi.clearAllMocks();
      mockGetService.mockReturnValue(mockService as any);
    });

    it('should dispatch task.assign to service.assignTask', () => {
      const msg: MapCoordinationMessage = {
        jsonrpc: '2.0',
        method: 'x-openhive/task.assign',
        params: {
          task_id: 'ct_test',
          title: 'Delegated task',
          description: 'Do the thing',
          priority: 'high',
          assigned_by: agentId,
          assigned_to_swarm: swarmId2,
          hive_id: hiveId,
          context: { prompt: 'analyze this' },
          deadline: '2026-12-31T00:00:00Z',
        } as TaskAssignParams,
      };

      handleCoordinationMessage(msg, swarmId1);

      expect(mockService.assignTask).toHaveBeenCalledOnce();
      expect(mockService.assignTask).toHaveBeenCalledWith(hiveId, {
        title: 'Delegated task',
        description: 'Do the thing',
        priority: 'high',
        assigned_by_agent_id: agentId,
        assigned_by_swarm_id: swarmId1,
        assigned_to_swarm_id: swarmId2,
        context: { prompt: 'analyze this' },
        deadline: '2026-12-31T00:00:00Z',
      });
    });

    it('should dispatch task.status to service.updateTaskStatus', () => {
      const msg: MapCoordinationMessage = {
        jsonrpc: '2.0',
        method: 'x-openhive/task.status',
        params: {
          task_id: 'ct_abc123',
          status: 'completed',
          progress: 100,
          result: { summary: 'All done' },
        } as TaskStatusParams,
      };

      handleCoordinationMessage(msg, swarmId2);

      expect(mockService.updateTaskStatus).toHaveBeenCalledOnce();
      expect(mockService.updateTaskStatus).toHaveBeenCalledWith('ct_abc123', {
        status: 'completed',
        progress: 100,
        result: { summary: 'All done' },
        error: undefined,
      });
    });

    it('should dispatch task.status with error', () => {
      const msg: MapCoordinationMessage = {
        jsonrpc: '2.0',
        method: 'x-openhive/task.status',
        params: {
          task_id: 'ct_failing',
          status: 'failed',
          error: 'Connection timed out',
        } as TaskStatusParams,
      };

      handleCoordinationMessage(msg, swarmId2);

      expect(mockService.updateTaskStatus).toHaveBeenCalledOnce();
      expect(mockService.updateTaskStatus).toHaveBeenCalledWith('ct_failing', {
        status: 'failed',
        progress: undefined,
        result: undefined,
        error: 'Connection timed out',
      });
    });

    it('should dispatch context.share to service.shareContext', () => {
      const msg: MapCoordinationMessage = {
        jsonrpc: '2.0',
        method: 'x-openhive/context.share',
        params: {
          context_id: 'sc_ctx1',
          source_swarm_id: swarmId1,
          target_swarm_ids: [swarmId2],
          hive_id: hiveId,
          context_type: 'tool_output',
          data: { tool: 'web_search', results: ['a', 'b'] },
          ttl_seconds: 600,
        } as ContextShareParams,
      };

      handleCoordinationMessage(msg, swarmId1);

      expect(mockService.shareContext).toHaveBeenCalledOnce();
      expect(mockService.shareContext).toHaveBeenCalledWith(hiveId, {
        source_swarm_id: swarmId1,
        context_type: 'tool_output',
        data: { tool: 'web_search', results: ['a', 'b'] },
        target_swarm_ids: [swarmId2],
        ttl_seconds: 600,
      });
    });

    it('should dispatch message.send to service.sendMessage', () => {
      const msg: MapCoordinationMessage = {
        jsonrpc: '2.0',
        method: 'x-openhive/message.send',
        params: {
          message_id: 'sm_msg1',
          from_swarm_id: swarmId1,
          to_swarm_id: swarmId2,
          hive_id: hiveId,
          content_type: 'text',
          content: 'Hey, are you done yet?',
          reply_to: 'sm_prev',
          metadata: { thread: 'main' },
        } as MessageSendParams,
      };

      handleCoordinationMessage(msg, swarmId1);

      expect(mockService.sendMessage).toHaveBeenCalledOnce();
      expect(mockService.sendMessage).toHaveBeenCalledWith({
        hive_id: hiveId,
        from_swarm_id: swarmId1,
        to_swarm_id: swarmId2,
        content_type: 'text',
        content: 'Hey, are you done yet?',
        reply_to: 'sm_prev',
        metadata: { thread: 'main' },
      });
    });

    it('should stringify non-string content in message.send', () => {
      const msg: MapCoordinationMessage = {
        jsonrpc: '2.0',
        method: 'x-openhive/message.send',
        params: {
          message_id: 'sm_json',
          from_swarm_id: swarmId1,
          to_swarm_id: swarmId2,
          content_type: 'json',
          content: { nested: true, values: [1, 2] },
        } as MessageSendParams,
      };

      handleCoordinationMessage(msg, swarmId1);

      expect(mockService.sendMessage).toHaveBeenCalledOnce();
      const callArgs = mockService.sendMessage.mock.calls[0][0];
      expect(callArgs.content).toBe(JSON.stringify({ nested: true, values: [1, 2] }));
    });

    it('should use sourceSwarmId as assigned_by_swarm_id for task.assign', () => {
      const msg: MapCoordinationMessage = {
        jsonrpc: '2.0',
        method: 'x-openhive/task.assign',
        params: {
          task_id: 'ct_swarm_source',
          title: 'Verify source swarm mapping',
          description: '',
          priority: 'low',
          assigned_by: agentId,
          assigned_to_swarm: swarmId2,
          hive_id: hiveId,
        } as TaskAssignParams,
      };

      const sourceSwarm = 'swarm_custom_source';
      handleCoordinationMessage(msg, sourceSwarm);

      expect(mockService.assignTask).toHaveBeenCalledWith(
        hiveId,
        expect.objectContaining({
          assigned_by_swarm_id: sourceSwarm,
        }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Phase 6: Coordination Types — createCoordinationNotification
  // ═══════════════════════════════════════════════════════════════

  describe('createCoordinationNotification', () => {
    it('should create a well-formed JSON-RPC 2.0 notification', () => {
      const params: TaskAssignParams = {
        task_id: 'ct_notify',
        title: 'Notification test',
        description: 'Testing notification creation',
        priority: 'medium',
        assigned_by: agentId,
        assigned_to_swarm: swarmId2,
        hive_id: hiveId,
      };

      const notification = createCoordinationNotification('x-openhive/task.assign', params);

      expect(notification.jsonrpc).toBe('2.0');
      expect(notification.method).toBe('x-openhive/task.assign');
      expect(notification.params).toBe(params);
    });

    it('should create notifications for each method type', () => {
      const taskAssign = createCoordinationNotification('x-openhive/task.assign', {
        task_id: 'ct_1', title: 'T', description: 'D', priority: 'low',
        assigned_by: agentId, assigned_to_swarm: swarmId2, hive_id: hiveId,
      } as TaskAssignParams);
      expect(taskAssign.method).toBe('x-openhive/task.assign');

      const taskStatus = createCoordinationNotification('x-openhive/task.status', {
        task_id: 'ct_1', status: 'in_progress',
      } as TaskStatusParams);
      expect(taskStatus.method).toBe('x-openhive/task.status');

      const contextShare = createCoordinationNotification('x-openhive/context.share', {
        context_id: 'sc_1', source_swarm_id: swarmId1, target_swarm_ids: [],
        hive_id: hiveId, context_type: 'test', data: {},
      } as ContextShareParams);
      expect(contextShare.method).toBe('x-openhive/context.share');

      const messageSend = createCoordinationNotification('x-openhive/message.send', {
        message_id: 'sm_1', from_swarm_id: swarmId1, to_swarm_id: swarmId2,
        content_type: 'text', content: 'Hi',
      } as MessageSendParams);
      expect(messageSend.method).toBe('x-openhive/message.send');
    });

    it('should pass params by reference, not copy', () => {
      const params: TaskStatusParams = {
        task_id: 'ct_ref',
        status: 'accepted',
      };
      const notification = createCoordinationNotification('x-openhive/task.status', params);
      expect(notification.params).toBe(params); // Same reference
    });

    it('should produce output accepted by isCoordinationMessage', () => {
      const notification = createCoordinationNotification('x-openhive/message.send', {
        message_id: 'sm_roundtrip',
        from_swarm_id: swarmId1,
        to_swarm_id: swarmId2,
        content_type: 'text',
        content: 'roundtrip test',
      } as MessageSendParams);

      expect(isCoordinationMessage(notification)).toBe(true);
    });
  });
});
