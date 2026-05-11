/**
 * End-to-end integration test for dispatch inbox threads.
 *
 * Exercises the full flow across hub components:
 *   1. Dispatch → lazy conversation creation (Phase 1-2)
 *   2. Task backreference writes (Gap 1)
 *   3. Turn posting with importance derivation (Phase 8)
 *   4. WS broadcast for dispatch-thread turns (Gap 3)
 *   5. Nudge dispatch on turn (Phase 7)
 *   6. Thread close on task completion (Phase 9)
 *   7. Thread reopen on task reopen (Phase 9)
 *   8. Orphaned thread sweep (Phase 9)
 *
 * Uses real SQLite DB + real agent-inbox (in-memory storage) + mocked
 * MAP transport / WS broadcast.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures these are available when vi.mock factories run
// ---------------------------------------------------------------------------

const { mockBroadcast, mockSendToSwarm, mockMapHubEvents } = vi.hoisted(() => {
  const mockBroadcast = vi.fn();
  const mockSendToSwarm = vi.fn();
  const mockMapHubEvents = {
    _handlers: new Map<string, Set<Function>>(),
    on(event: string, handler: Function) {
      if (!this._handlers.has(event)) this._handlers.set(event, new Set());
      this._handlers.get(event)!.add(handler);
    },
    off(event: string, handler: Function) {
      this._handlers.get(event)?.delete(handler);
    },
    emit(event: string, ...args: unknown[]) {
      for (const h of this._handlers.get(event) ?? []) {
        h(...args);
      }
    },
  };
  return { mockBroadcast, mockSendToSwarm, mockMapHubEvents };
});

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (...args: unknown[]) => mockBroadcast(...args),
}));

vi.mock('../../map/sync-listener.js', () => ({
  sendToSwarm: (...args: unknown[]) => mockSendToSwarm(...args),
}));

vi.mock('../../map/service.js', () => ({
  mapHubEvents: mockMapHubEvents,
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { initMail, getMailJsonRpc, getMailStorage } from '../../mail/index.js';
import {
  ensureDispatchConversation,
  DISPATCH_THREAD_SCOPE,
} from '../../dispatch/dispatch-conversation.js';
import { sendDispatchNudge } from '../../dispatch/nudge.js';
import {
  handleTaskStatusChanged,
  sweepOrphanedThreads,
} from '../../dispatch/thread-lifecycle.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { MailJsonRpcServer } from 'agent-inbox';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const TEST_ROOT = testRoot('dispatch-inbox-threads-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'e2e.db');

let mailRpc: MailJsonRpcServer;
let testAgentId: string;

beforeAll(async () => {
  initDatabase(TEST_DB_PATH);
  // Seed an agent to satisfy FK constraints on syncable_resources.owner_agent_id
  const { agent } = await agentsDAL.createAgent({ name: 'e2e-test-agent' });
  testAgentId = agent.id;
  const mail = await initMail();
  mailRpc = mail.jsonRpc;
});

afterAll(() => {
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

beforeEach(() => {
  vi.clearAllMocks();
  getDatabase().prepare('DELETE FROM dispatches').run();
  getDatabase().prepare('DELETE FROM syncable_resources').run();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedDispatch(swarmId = 'swarm-test') {
  return dispatchesDAL.createDispatch({
    spec_resource_id: 'res_e2e',
    spec_id: 'spec-e2e',
    target_swarm_id: swarmId,
    initiator_type: 'user',
    initiator_id: 'user-e2e',
  });
}

function seedTaskResource(dispatchId: string, conversationId: string) {
  return resourcesDAL.createResource({
    resource_type: 'task',
    name: 'E2E Test Task',
    git_remote_url: 'local://test',
    owner_agent_id: testAgentId,
    metadata: {
      opentasks: true,
      dispatch_threads: [
        { dispatch_id: dispatchId, conversation_id: conversationId },
      ],
    },
  });
}

async function rpc(method: string, params: Record<string, unknown>) {
  return mailRpc.handleRequest({
    jsonrpc: '2.0',
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    method,
    params,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch inbox threads — end-to-end', () => {
  describe('Phase 1-2: conversation lifecycle', () => {
    it('creates dispatch conversation lazily on first call', async () => {
      const d = seedDispatch();

      const convId = await ensureDispatchConversation(
        {
          dispatchId: d.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Build API',
          targetSwarmId: 'swarm-test',
          swarmName: 'test-swarm',
          linkedTasks: [],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-agent',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      // Deterministic ID
      expect(convId).toBe(`dispatch-conv-${d.id}`);

      // conversation_id persisted on dispatch row
      const updated = dispatchesDAL.findDispatchById(d.id)!;
      expect(updated.conversation_id).toBe(convId);

      // Conversation exists in mail storage with correct scope
      const storage = getMailStorage();
      const conv = storage.getConversation(convId)!;
      expect(conv).toBeDefined();
      expect(conv.scope).toBe(DISPATCH_THREAD_SCOPE);
      expect((conv.metadata as Record<string, unknown>).dispatch_id).toBe(d.id);
    });

    it('is idempotent — second call returns same conversation', async () => {
      const d = seedDispatch();
      const deps = { getMailJsonRpc: () => mailRpc };
      const opts = {
        dispatchId: d.id,
        specId: 'spec-e2e',
        specResourceId: 'res_e2e',
        specTitle: 'Build API',
        targetSwarmId: 'swarm-test',
        swarmName: 'test-swarm',
        linkedTasks: [],
        initiator: { type: 'user', id: 'user-e2e' } as const,
        executorAgentId: 'executor-agent',
      };

      const first = await ensureDispatchConversation(opts, deps);
      const second = await ensureDispatchConversation(opts, deps);
      expect(second).toBe(first);
    });
  });

  describe('Gap 1: task backreference writes', () => {
    it('appends dispatch_threads to linked task resources', async () => {
      const d = seedDispatch();

      // Create a task resource first (without dispatch_threads)
      const taskRes = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'E2E Task',
        git_remote_url: 'local://test',
        owner_agent_id: testAgentId,
        metadata: { opentasks: true },
      });

      await ensureDispatchConversation(
        {
          dispatchId: d.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Build API',
          targetSwarmId: 'swarm-test',
          swarmName: 'test-swarm',
          linkedTasks: [{ resource_id: taskRes.id, node_id: 'node-1' }],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-agent',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      // Verify backreference was written
      const updatedTask = resourcesDAL.findResourceById(taskRes.id)!;
      const meta = updatedTask.metadata as Record<string, unknown>;
      const threads = meta.dispatch_threads as Array<{
        dispatch_id: string;
        conversation_id: string;
      }>;
      expect(threads).toHaveLength(1);
      expect(threads[0].dispatch_id).toBe(d.id);
      expect(threads[0].conversation_id).toBe(`dispatch-conv-${d.id}`);
    });
  });

  describe('Phase 8: importance on turns', () => {
    it('stores importance on mail/turn when provided', async () => {
      const d = seedDispatch();
      const convId = await ensureDispatchConversation(
        {
          dispatchId: d.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Build API',
          targetSwarmId: 'swarm-test',
          swarmName: 'test-swarm',
          linkedTasks: [],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-agent',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      // Post a turn with importance
      await rpc('mail/turn', {
        conversationId: convId,
        participantId: 'user-e2e',
        content: 'What is the status?',
        contentType: 'text',
        importance: 'high',
      });

      // Verify turn has importance stored
      const storage = getMailStorage();
      const turns = storage.getTurns(convId);
      expect(turns).toHaveLength(1);
      expect(turns[0].importance).toBe('high');
    });

    it('omits importance on turns when not provided (backward compat)', async () => {
      const d = seedDispatch();
      const convId = await ensureDispatchConversation(
        {
          dispatchId: d.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Build API',
          targetSwarmId: 'swarm-test',
          swarmName: 'test-swarm',
          linkedTasks: [],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-agent',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      await rpc('mail/turn', {
        conversationId: convId,
        participantId: 'user-e2e',
        content: 'Status update',
        contentType: 'text',
      });

      const storage = getMailStorage();
      const turns = storage.getTurns(convId);
      expect(turns).toHaveLength(1);
      expect(turns[0].importance).toBeUndefined();
    });
  });

  describe('Gap 3: WS broadcast for dispatch-thread turns', () => {
    it('broadcasts dispatch.thread.turn on map:dispatches when turn lands in dispatch thread', async () => {
      const d = seedDispatch();
      const convId = await ensureDispatchConversation(
        {
          dispatchId: d.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Build API',
          targetSwarmId: 'swarm-test',
          swarmName: 'test-swarm',
          linkedTasks: [],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-agent',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      // Post a turn — this should trigger the event forwarding
      await rpc('mail/turn', {
        conversationId: convId,
        participantId: 'user-e2e',
        content: 'Testing broadcast',
        contentType: 'text',
      });

      // Check that broadcastToChannel was called for dispatch thread
      const dispatchBroadcasts = mockBroadcast.mock.calls.filter(
        (args: unknown[]) => {
          const [channel, event] = args as [string, { type: string }];
          return channel === 'map:dispatches' && event.type === 'dispatch.thread.turn';
        },
      );
      expect(dispatchBroadcasts.length).toBeGreaterThanOrEqual(1);

      const [, event] = dispatchBroadcasts[0];
      expect(event.data.dispatch_id).toBe(d.id);
      expect(event.data.conversation_id).toBe(convId);
    });
  });

  describe('Phase 7: nudge on dispatch thread turn', () => {
    it('sends x-dispatch/nudge to target swarm when turn lands', () => {
      // Seed a dispatch with a known swarm
      const d = seedDispatch('swarm-nudge');

      // Call sendDispatchNudge directly (as the mail event handler does)
      sendDispatchNudge(d.id, `dispatch-conv-${d.id}`);

      expect(mockSendToSwarm).toHaveBeenCalledWith(
        'swarm-nudge',
        expect.objectContaining({
          jsonrpc: '2.0',
          method: 'x-dispatch/nudge',
          params: {
            dispatch_id: d.id,
            conversation_id: `dispatch-conv-${d.id}`,
          },
        }),
      );
    });

    it('no-ops when dispatch not found', () => {
      sendDispatchNudge('nonexistent', 'conv-x');
      expect(mockSendToSwarm).not.toHaveBeenCalled();
    });
  });

  describe('Phase 9: thread lifecycle on task status', () => {
    it('closes linked dispatch threads when task completes', async () => {
      const d = seedDispatch();
      const convId = await ensureDispatchConversation(
        {
          dispatchId: d.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Build API',
          targetSwarmId: 'swarm-test',
          swarmName: 'test-swarm',
          linkedTasks: [],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-agent',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      // Verify conversation is active
      const storage = getMailStorage();
      expect(storage.getConversation(convId)!.status).toBe('active');

      // Create a task resource linked to this dispatch thread
      const taskRes = seedTaskResource(d.id, convId);

      // Simulate task completion
      await handleTaskStatusChanged({
        task_id: 'task-1',
        status: 'completed',
        resource_id: taskRes.id,
      });

      // Thread should be closed
      expect(storage.getConversation(convId)!.status).toBe('completed');
    });

    it('reopens threads when task transitions from completed to open', async () => {
      const d = seedDispatch();
      const convId = await ensureDispatchConversation(
        {
          dispatchId: d.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Build API',
          targetSwarmId: 'swarm-test',
          swarmName: 'test-swarm',
          linkedTasks: [],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-agent',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      const storage = getMailStorage();
      const taskRes = seedTaskResource(d.id, convId);

      // Close the thread first
      await handleTaskStatusChanged({
        task_id: 'task-1',
        status: 'completed',
        resource_id: taskRes.id,
      });
      expect(storage.getConversation(convId)!.status).toBe('completed');

      // Reopen
      await handleTaskStatusChanged({
        task_id: 'task-1',
        status: 'open',
        previous: 'completed',
        resource_id: taskRes.id,
      });
      expect(storage.getConversation(convId)!.status).toBe('active');
    });

    it('handles multiple dispatch threads on a single task', async () => {
      const d1 = seedDispatch('swarm-1');
      const d2 = seedDispatch('swarm-2');

      const convId1 = await ensureDispatchConversation(
        {
          dispatchId: d1.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Build API',
          targetSwarmId: 'swarm-1',
          swarmName: 'swarm-1',
          linkedTasks: [],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-1',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      const convId2 = await ensureDispatchConversation(
        {
          dispatchId: d2.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Build API',
          targetSwarmId: 'swarm-2',
          swarmName: 'swarm-2',
          linkedTasks: [],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-2',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      // Create task with both dispatch threads
      const taskRes = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'Multi-dispatch task',
        git_remote_url: 'local://test',
        owner_agent_id: testAgentId,
        metadata: {
          dispatch_threads: [
            { dispatch_id: d1.id, conversation_id: convId1 },
            { dispatch_id: d2.id, conversation_id: convId2 },
          ],
        },
      });

      const storage = getMailStorage();
      expect(storage.getConversation(convId1)!.status).toBe('active');
      expect(storage.getConversation(convId2)!.status).toBe('active');

      // Complete task → both threads close
      await handleTaskStatusChanged({
        task_id: 'task-multi',
        status: 'completed',
        resource_id: taskRes.id,
      });

      expect(storage.getConversation(convId1)!.status).toBe('completed');
      expect(storage.getConversation(convId2)!.status).toBe('completed');
    });

    it('no-ops when task has no dispatch_threads', async () => {
      const taskRes = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'Plain task',
        git_remote_url: 'local://test',
        owner_agent_id: testAgentId,
        metadata: { opentasks: true },
      });

      // Should not throw
      await handleTaskStatusChanged({
        task_id: 'task-plain',
        status: 'completed',
        resource_id: taskRes.id,
      });
    });
  });

  describe('Phase 9: orphaned thread sweep', () => {
    it('closes stale threads with no running dispatch', async () => {
      const d = seedDispatch();
      const convId = await ensureDispatchConversation(
        {
          dispatchId: d.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Build API',
          targetSwarmId: 'swarm-test',
          swarmName: 'test-swarm',
          linkedTasks: [],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-agent',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      // Make the dispatch terminal
      dispatchesDAL.cancelDispatch(d.id);

      // Backdate the conversation's updated_at to simulate staleness
      const storage = getMailStorage();
      const conv = storage.getConversation(convId)!;
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      conv.updated_at = oldDate;
      storage.putConversation(conv);

      // Sweep with 30-day TTL
      const closed = await sweepOrphanedThreads(30 * 24 * 60 * 60 * 1000);
      expect(closed).toBe(1);
      expect(storage.getConversation(convId)!.status).toBe('completed');
    });

    it('preserves threads with running dispatches even if stale', async () => {
      const d = seedDispatch();
      // Claim the dispatch to make it 'running'
      dispatchesDAL.claimDispatch(d.id, 'test-claimant');

      const convId = await ensureDispatchConversation(
        {
          dispatchId: d.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Build API',
          targetSwarmId: 'swarm-test',
          swarmName: 'test-swarm',
          linkedTasks: [],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-agent',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      // Backdate
      const storage = getMailStorage();
      const conv = storage.getConversation(convId)!;
      conv.updated_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      storage.putConversation(conv);

      // Sweep should skip it because dispatch is running
      const closed = await sweepOrphanedThreads(30 * 24 * 60 * 60 * 1000);
      expect(closed).toBe(0);
      expect(storage.getConversation(convId)!.status).toBe('active');
    });
  });

  describe('full lifecycle: create → turn → complete → reopen', () => {
    it('exercises the complete dispatch thread lifecycle', async () => {
      // 1. Create dispatch and conversation
      const d = seedDispatch('swarm-full');
      const convId = await ensureDispatchConversation(
        {
          dispatchId: d.id,
          specId: 'spec-e2e',
          specResourceId: 'res_e2e',
          specTitle: 'Full lifecycle test',
          targetSwarmId: 'swarm-full',
          swarmName: 'full-swarm',
          linkedTasks: [],
          initiator: { type: 'user', id: 'user-e2e' },
          executorAgentId: 'executor-full',
        },
        { getMailJsonRpc: () => mailRpc },
      );

      const storage = getMailStorage();
      expect(storage.getConversation(convId)!.status).toBe('active');

      // 2. Post a high-importance turn (user asking a question)
      await rpc('mail/turn', {
        conversationId: convId,
        participantId: 'user-e2e',
        content: 'What is the deployment status?',
        contentType: 'text',
        importance: 'high',
      });

      const turns1 = storage.getTurns(convId);
      expect(turns1).toHaveLength(1);
      expect(turns1[0].importance).toBe('high');

      // 3. Post a normal-importance reply (agent status update)
      await rpc('mail/turn', {
        conversationId: convId,
        participantId: 'executor-full',
        content: 'Deployment is 80% complete.',
        contentType: 'text',
        importance: 'normal',
      });

      expect(storage.getTurns(convId)).toHaveLength(2);

      // 4. Nudge fires correctly
      sendDispatchNudge(d.id, convId);
      expect(mockSendToSwarm).toHaveBeenCalledWith(
        'swarm-full',
        expect.objectContaining({
          method: 'x-dispatch/nudge',
        }),
      );

      // 5. Task completes → thread closes
      const taskRes = seedTaskResource(d.id, convId);
      await handleTaskStatusChanged({
        task_id: 'task-full',
        status: 'completed',
        resource_id: taskRes.id,
      });
      expect(storage.getConversation(convId)!.status).toBe('completed');

      // 6. Task reopened → thread reopens
      await handleTaskStatusChanged({
        task_id: 'task-full',
        status: 'in_progress',
        previous: 'completed',
        resource_id: taskRes.id,
      });
      expect(storage.getConversation(convId)!.status).toBe('active');

      // 7. Post another turn after reopen
      await rpc('mail/turn', {
        conversationId: convId,
        participantId: 'user-e2e',
        content: 'Please fix the regression.',
        contentType: 'text',
        importance: 'urgent',
      });

      const allTurns = storage.getTurns(convId);
      expect(allTurns).toHaveLength(3);
      expect(allTurns[2].importance).toBe('urgent');

      // 8. Task fails → thread closes again
      await handleTaskStatusChanged({
        task_id: 'task-full',
        status: 'failed',
        previous: 'in_progress',
        resource_id: taskRes.id,
      });
      expect(storage.getConversation(convId)!.status).toBe('completed');
    });
  });
});
