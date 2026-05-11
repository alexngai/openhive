/**
 * Tests for dispatch conversation factory — verifies lazy creation,
 * idempotency, and DAL integration for dispatch inbox threads.
 *
 * Uses a mock MailJsonRpcServer since the factory's mail interactions are
 * thin RPC calls. The DAL layer (conversation_id persistence) is tested
 * against a real SQLite database.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as dispatches from '../../db/dal/dispatches.js';
import {
  ensureDispatchConversation,
  DISPATCH_THREAD_SCOPE,
  type DispatchConversationOpts,
  type DispatchConversationDeps,
} from '../../dispatch/dispatch-conversation.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('dispatch-conversation');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'dispatch-conversation.db');

// ---------------------------------------------------------------------------
// Mock mail JSON-RPC
// ---------------------------------------------------------------------------

interface MailCall {
  method: string;
  params: Record<string, unknown>;
}

function createMockMailRpc() {
  const calls: MailCall[] = [];

  const handleRequest = vi.fn(async (req: { method: string; params: Record<string, unknown> }) => {
    calls.push({ method: req.method, params: req.params });
    return { result: { id: req.params.id ?? `mock-conv-${Date.now()}`, ok: true } };
  });

  return {
    calls,
    handleRequest,
    rpc: { handleRequest } as unknown as ReturnType<DispatchConversationDeps['getMailJsonRpc']>,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedDispatch(): dispatches.Dispatch {
  return dispatches.createDispatch({
    spec_resource_id: 'res_conv_test',
    spec_id: 'spec-1',
    target_swarm_id: 'swarm_test',
    initiator_type: 'user',
    initiator_id: 'user_abc',
  });
}

function defaultOpts(dispatchId: string): DispatchConversationOpts {
  return {
    dispatchId,
    specId: 'spec-1',
    specResourceId: 'res_conv_test',
    specTitle: 'Build the API',
    targetSwarmId: 'swarm_test',
    swarmName: 'my-swarm',
    linkedTasks: [{ resource_id: 'task-res-1', node_id: 'node-1' }],
    initiator: { type: 'user', id: 'user_abc' },
    executorAgentId: 'myteam-main',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch conversation factory', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM dispatches').run();
  });

  it('creates a conversation on first call and writes conversation_id to dispatch row', async () => {
    const d = seedDispatch();
    const mock = createMockMailRpc();
    const deps: DispatchConversationDeps = { getMailJsonRpc: () => mock.rpc };

    const convId = await ensureDispatchConversation(defaultOpts(d.id), deps);

    // Deterministic ID
    expect(convId).toBe(`dispatch-conv-${d.id}`);

    // conversation_id written to dispatch row
    const updated = dispatches.findDispatchById(d.id)!;
    expect(updated.conversation_id).toBe(convId);

    // mail/create called with correct scope and metadata
    const createCall = mock.calls.find((c) => c.method === 'mail/create');
    expect(createCall).toBeDefined();
    expect(createCall!.params.scope).toBe(DISPATCH_THREAD_SCOPE);
    expect(createCall!.params.metadata).toMatchObject({
      dispatch_id: d.id,
      spec_id: 'spec-1',
    });

    // Two mail/invite calls (initiator + executor)
    const inviteCalls = mock.calls.filter((c) => c.method === 'mail/invite');
    expect(inviteCalls).toHaveLength(2);
    expect(inviteCalls[0].params.agentId).toBe('user_abc');
    expect(inviteCalls[0].params.role).toBe('initiator');
    expect(inviteCalls[1].params.agentId).toBe('myteam-main');
    expect(inviteCalls[1].params.role).toBe('executor');
  });

  it('returns existing conversation_id on second call without calling mail RPC', async () => {
    const d = seedDispatch();
    const mock = createMockMailRpc();
    const deps: DispatchConversationDeps = { getMailJsonRpc: () => mock.rpc };

    const first = await ensureDispatchConversation(defaultOpts(d.id), deps);
    mock.calls.length = 0; // reset

    const second = await ensureDispatchConversation(defaultOpts(d.id), deps);

    expect(second).toBe(first);
    // No additional mail RPC calls
    expect(mock.calls).toHaveLength(0);
  });

  it('returns existing conversation_id when dispatch already has one (pre-set)', async () => {
    const d = seedDispatch();
    dispatches.setDispatchConversationId(d.id, 'existing-conv-123');

    const mock = createMockMailRpc();
    const deps: DispatchConversationDeps = { getMailJsonRpc: () => mock.rpc };

    const convId = await ensureDispatchConversation(defaultOpts(d.id), deps);

    expect(convId).toBe('existing-conv-123');
    expect(mock.calls).toHaveLength(0);
  });

  it('concurrent calls share a single creation (no duplicate conversations)', async () => {
    const d = seedDispatch();
    const mock = createMockMailRpc();
    const deps: DispatchConversationDeps = { getMailJsonRpc: () => mock.rpc };

    const opts = defaultOpts(d.id);
    const [a, b, c] = await Promise.all([
      ensureDispatchConversation(opts, deps),
      ensureDispatchConversation(opts, deps),
      ensureDispatchConversation(opts, deps),
    ]);

    expect(a).toBe(b);
    expect(b).toBe(c);

    // Only one mail/create call despite three concurrent callers
    const createCalls = mock.calls.filter((c) => c.method === 'mail/create');
    expect(createCalls).toHaveLength(1);
  });

  it('conversation subject includes spec title and swarm name', async () => {
    const d = seedDispatch();
    const mock = createMockMailRpc();
    const deps: DispatchConversationDeps = { getMailJsonRpc: () => mock.rpc };

    await ensureDispatchConversation(
      { ...defaultOpts(d.id), specTitle: 'Fix the bug', swarmName: 'alpha-swarm' },
      deps,
    );

    const createCall = mock.calls.find((c) => c.method === 'mail/create');
    expect(createCall!.params.subject).toContain('Fix the bug');
    expect(createCall!.params.subject).toContain('alpha-swarm');
  });
});

describe('setDispatchConversationId', () => {
  beforeAll(() => {
    initDatabase(testDbPath(testRoot('dispatch-conv-dal'), 'dispatch-conv-dal.db'));
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(testRoot('dispatch-conv-dal'));
  });

  beforeEach(() => {
    getDatabase().prepare('DELETE FROM dispatches').run();
  });

  it('sets conversation_id when null', () => {
    const d = seedDispatch();
    expect(d.conversation_id).toBeNull();

    dispatches.setDispatchConversationId(d.id, 'conv-123');

    const updated = dispatches.findDispatchById(d.id)!;
    expect(updated.conversation_id).toBe('conv-123');
  });

  it('is idempotent — does not overwrite existing conversation_id', () => {
    const d = seedDispatch();
    dispatches.setDispatchConversationId(d.id, 'conv-first');
    dispatches.setDispatchConversationId(d.id, 'conv-second');

    const updated = dispatches.findDispatchById(d.id)!;
    expect(updated.conversation_id).toBe('conv-first');
  });

  it('no-ops for non-existent dispatch', () => {
    // Should not throw
    dispatches.setDispatchConversationId('disp_nonexistent', 'conv-123');
  });
});
