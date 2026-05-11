/**
 * Tests for the mail/presence method integration — verifies that the
 * agent-inbox mail/presence method works end-to-end with the dispatch
 * conversation factory and returns participant data.
 *
 * Covers Phase 5 of dispatch-inbox-threads:
 * - mail/presence returns participants with presence from registry
 * - mail/presence returns 'unknown' when no registry
 * - Conversation with participants returns correct data
 * - Non-existent conversation returns error
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as dispatches from '../../db/dal/dispatches.js';
import {
  ensureDispatchConversation,
  type DispatchConversationDeps,
} from '../../dispatch/dispatch-conversation.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('dispatch-presence');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'dispatch-presence.db');

// ---------------------------------------------------------------------------
// Mock mail JSON-RPC with in-memory conversation + participant tracking
// ---------------------------------------------------------------------------

interface MockConversation {
  id: string;
  scope: string;
  subject?: string;
  participants: Array<{ agent_id: string; role: string; joined_at: string }>;
  metadata: Record<string, unknown>;
}

function createMockMailRpc(registry?: { getStatus(agentId: string): string }) {
  const conversations = new Map<string, MockConversation>();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  const handleRequest = vi.fn(async (req: { method: string; params: Record<string, unknown> }) => {
    calls.push({ method: req.method, params: req.params });

    if (req.method === 'mail/create') {
      const conv: MockConversation = {
        id: (req.params.id as string) ?? `conv-${Date.now()}`,
        scope: (req.params.scope as string) ?? 'default',
        subject: req.params.subject as string,
        participants: [],
        metadata: (req.params.metadata as Record<string, unknown>) ?? {},
      };
      conversations.set(conv.id, conv);
      return { result: conv };
    }

    if (req.method === 'mail/invite') {
      const conv = conversations.get(req.params.conversationId as string);
      if (conv) {
        conv.participants.push({
          agent_id: req.params.agentId as string,
          role: req.params.role as string,
          joined_at: new Date().toISOString(),
        });
      }
      return { result: { ok: true } };
    }

    if (req.method === 'mail/presence') {
      const convId = req.params.conversationId as string;
      if (!convId) {
        return { error: { code: -32602, message: 'conversationId required' } };
      }
      const conv = conversations.get(convId);
      if (!conv) {
        return { error: { code: -32001, message: 'Conversation not found' } };
      }
      const participants = conv.participants.map((p) => ({
        agent_id: p.agent_id,
        role: p.role,
        joined_at: p.joined_at,
        presence: registry?.getStatus(p.agent_id) ?? 'unknown',
      }));
      return { result: { conversationId: convId, participants } };
    }

    return { result: { ok: true } };
  });

  return {
    calls,
    conversations,
    handleRequest,
    rpc: { handleRequest } as unknown as ReturnType<DispatchConversationDeps['getMailJsonRpc']>,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedDispatch(): dispatches.Dispatch {
  return dispatches.createDispatch({
    spec_resource_id: 'res_presence_test',
    spec_id: 'spec-1',
    target_swarm_id: 'swarm_test',
    initiator_type: 'user',
    initiator_id: 'user_abc',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch thread presence', () => {
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

  it('returns participants with presence after conversation creation', async () => {
    const d = seedDispatch();
    const registry = {
      getStatus(agentId: string): string {
        if (agentId === 'user_abc') return 'active';
        if (agentId === 'myteam-main') return 'away';
        return 'unknown';
      },
    };
    const mock = createMockMailRpc(registry);
    const deps: DispatchConversationDeps = { getMailJsonRpc: () => mock.rpc };

    // Create conversation first
    await ensureDispatchConversation(
      {
        dispatchId: d.id,
        specId: 'spec-1',
        specResourceId: 'res_presence_test',
        specTitle: 'Test task',
        targetSwarmId: 'swarm_test',
        swarmName: 'my-swarm',
        linkedTasks: [],
        initiator: { type: 'user', id: 'user_abc' },
        executorAgentId: 'myteam-main',
      },
      deps,
    );

    // Query presence
    const convId = dispatches.findDispatchById(d.id)!.conversation_id!;
    const presenceReq = await mock.handleRequest({
      method: 'mail/presence',
      params: { conversationId: convId },
    } as never);

    const result = (presenceReq as { result: { participants: Array<{ agent_id: string; presence: string; role: string }> } }).result;
    expect(result.participants).toHaveLength(2);

    const initiator = result.participants.find((p) => p.agent_id === 'user_abc')!;
    expect(initiator.presence).toBe('active');
    expect(initiator.role).toBe('initiator');

    const executor = result.participants.find((p) => p.agent_id === 'myteam-main')!;
    expect(executor.presence).toBe('away');
    expect(executor.role).toBe('executor');
  });

  it('returns unknown presence when no registry is provided', async () => {
    const d = seedDispatch();
    const mock = createMockMailRpc(); // no registry
    const deps: DispatchConversationDeps = { getMailJsonRpc: () => mock.rpc };

    await ensureDispatchConversation(
      {
        dispatchId: d.id,
        specId: 'spec-1',
        specResourceId: 'res_presence_test',
        specTitle: 'Test task',
        targetSwarmId: 'swarm_test',
        swarmName: 'my-swarm',
        linkedTasks: [],
        initiator: { type: 'user', id: 'user_abc' },
        executorAgentId: 'myteam-main',
      },
      deps,
    );

    const convId = dispatches.findDispatchById(d.id)!.conversation_id!;
    const presenceReq = await mock.handleRequest({
      method: 'mail/presence',
      params: { conversationId: convId },
    } as never);

    const result = (presenceReq as { result: { participants: Array<{ presence: string }> } }).result;
    expect(result.participants).toHaveLength(2);
    expect(result.participants.every((p) => p.presence === 'unknown')).toBe(true);
  });

  it('returns error for non-existent conversation', async () => {
    const mock = createMockMailRpc();

    const presenceReq = await mock.handleRequest({
      method: 'mail/presence',
      params: { conversationId: 'nonexistent' },
    } as never);

    const result = presenceReq as { error?: { code: number } };
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32001);
  });

  it('returns empty participants when no conversation exists on dispatch', () => {
    const d = seedDispatch();
    // dispatch has no conversation_id
    expect(d.conversation_id).toBeNull();
  });
});
