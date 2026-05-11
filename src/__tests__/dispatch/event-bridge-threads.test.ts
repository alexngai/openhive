/**
 * Tests for dispatch event bridge thread integration — verifies that
 * orchestrator lifecycle events (retrying, dispatched) correctly interact
 * with dispatch inbox threads.
 *
 * Covers Phase 4 of dispatch-inbox-threads:
 * - `retrying` event posts a system turn to the existing conversation
 * - `dispatched` event on attempt > 1 invites the new agent
 * - No thread action when conversation_id is null
 *
 * These tests simulate the event-handler logic from setup.ts using the
 * same DAL calls + mock mail RPC, following the pattern from
 * event-bridge.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as dispatches from '../../db/dal/dispatches.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('event-bridge-threads');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'event-bridge-threads.db');

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
    return { result: { ok: true } };
  });

  return {
    calls,
    handleRequest,
    rpc: { handleRequest } as unknown,
  };
}

// ---------------------------------------------------------------------------
// Simulate event bridge handlers from setup.ts
// ---------------------------------------------------------------------------

/**
 * Mirror of setup.ts retrying handler's thread logic (lines 266-284).
 * Uses the same field names as production: `participantId` (not `agentId`)
 * and includes `importance: 'normal'`.
 */
async function handleRetryingThread(
  taskId: string,
  attempt: number,
  error: string | undefined,
  getMailJsonRpc: (() => { handleRequest: (req: unknown) => Promise<unknown> }) | undefined,
): Promise<void> {
  const current = dispatches.findDispatchById(taskId);
  if (current?.conversation_id && getMailJsonRpc) {
    const mailRpc = getMailJsonRpc();
    await mailRpc.handleRequest({
      jsonrpc: '2.0',
      id: `sys-retry-test`,
      method: 'mail/turn',
      params: {
        conversationId: current.conversation_id,
        participantId: 'system:dispatch-orchestrator',
        content: `Retry attempt ${attempt}: previous attempt failed${error ? ` with: ${error}` : '.'}`,
        contentType: 'text',
        importance: 'normal',
        metadata: { system: true, attempt },
      },
    });
  }
}

/**
 * Mirror of setup.ts dispatched handler's thread logic (lines 166-185).
 * Uses `resolveInboxAgentId` to transform the raw MAP agent id, matching
 * production behavior.
 */
async function handleDispatchedThread(
  taskId: string,
  attempt: number,
  agentId: string | undefined,
  getMailJsonRpc: (() => { handleRequest: (req: unknown) => Promise<unknown> }) | undefined,
  resolveInboxAgentIdFn: (swarmId: string, agentId: string) => string = (_s, a) => a,
): Promise<void> {
  if (attempt > 1 && getMailJsonRpc && agentId) {
    const dispatch = dispatches.findDispatchById(taskId);
    if (dispatch?.conversation_id) {
      const inboxId = resolveInboxAgentIdFn(dispatch.target_swarm_id, agentId);
      const mailRpc = getMailJsonRpc();
      await mailRpc.handleRequest({
        jsonrpc: '2.0',
        id: `invite-retry-test`,
        method: 'mail/invite',
        params: {
          conversationId: dispatch.conversation_id,
          agentId: inboxId,
          role: 'executor',
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedDispatchWithConversation(): dispatches.Dispatch {
  const d = dispatches.createDispatch({
    spec_resource_id: 'res_test',
    spec_id: 'spec-1',
    target_swarm_id: 'swarm_test',
    initiator_type: 'user',
    initiator_id: 'user_test',
  });
  dispatches.claimDispatch(d.id, 'orch-1');
  dispatches.setDispatchConversationId(d.id, `dispatch-conv-${d.id}`);
  return dispatches.findDispatchById(d.id)!;
}

function seedDispatchWithoutConversation(): dispatches.Dispatch {
  const d = dispatches.createDispatch({
    spec_resource_id: 'res_test',
    spec_id: 'spec-2',
    target_swarm_id: 'swarm_test',
    initiator_type: 'user',
    initiator_id: 'user_test',
  });
  dispatches.claimDispatch(d.id, 'orch-1');
  return dispatches.findDispatchById(d.id)!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('event bridge thread integration', () => {
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

  // ==========================================================================
  // retrying event → system turn
  // ==========================================================================

  describe('retrying event → system turn', () => {
    it('posts a system turn to the dispatch thread on retry', async () => {
      const d = seedDispatchWithConversation();
      const mock = createMockMailRpc();

      await handleRetryingThread(d.id, 2, 'timeout', () => mock.rpc as never);

      const turnCall = mock.calls.find((c) => c.method === 'mail/turn');
      expect(turnCall).toBeDefined();
      expect(turnCall!.params.conversationId).toBe(`dispatch-conv-${d.id}`);
      expect(turnCall!.params.participantId).toBe('system:dispatch-orchestrator');
      expect(turnCall!.params.content).toContain('Retry attempt 2');
      expect(turnCall!.params.content).toContain('timeout');
      expect(turnCall!.params.importance).toBe('normal');
      expect(turnCall!.params.metadata).toMatchObject({ system: true, attempt: 2 });
    });

    it('includes generic message when no error provided', async () => {
      const d = seedDispatchWithConversation();
      const mock = createMockMailRpc();

      await handleRetryingThread(d.id, 3, undefined, () => mock.rpc as never);

      const turnCall = mock.calls.find((c) => c.method === 'mail/turn');
      expect(turnCall).toBeDefined();
      expect(turnCall!.params.content).toContain('Retry attempt 3');
      expect(turnCall!.params.content).toContain('failed.');
      expect(turnCall!.params.importance).toBe('normal');
    });

    it('no-ops when conversation_id is null', async () => {
      const d = seedDispatchWithoutConversation();
      const mock = createMockMailRpc();

      await handleRetryingThread(d.id, 2, 'error', () => mock.rpc as never);

      expect(mock.calls).toHaveLength(0);
    });

    it('no-ops when getMailJsonRpc is not provided', async () => {
      const d = seedDispatchWithConversation();

      // Should not throw
      await handleRetryingThread(d.id, 2, 'error', undefined);
    });
  });

  // ==========================================================================
  // dispatched event → new agent invite
  // ==========================================================================

  describe('dispatched event → new agent invite', () => {
    it('invites new agent on retry attempt (attempt > 1)', async () => {
      const d = seedDispatchWithConversation();
      const mock = createMockMailRpc();

      await handleDispatchedThread(d.id, 2, 'agent-retry-1', () => mock.rpc as never);

      const inviteCall = mock.calls.find((c) => c.method === 'mail/invite');
      expect(inviteCall).toBeDefined();
      expect(inviteCall!.params.conversationId).toBe(`dispatch-conv-${d.id}`);
      expect(inviteCall!.params.agentId).toBe('agent-retry-1');
      expect(inviteCall!.params.role).toBe('executor');
    });

    it('does not invite on first attempt', async () => {
      const d = seedDispatchWithConversation();
      const mock = createMockMailRpc();

      await handleDispatchedThread(d.id, 1, 'agent-first', () => mock.rpc as never);

      expect(mock.calls).toHaveLength(0);
    });

    it('no-ops when conversation_id is null', async () => {
      const d = seedDispatchWithoutConversation();
      const mock = createMockMailRpc();

      await handleDispatchedThread(d.id, 2, 'agent-retry-1', () => mock.rpc as never);

      expect(mock.calls).toHaveLength(0);
    });

    it('no-ops when agentId is undefined', async () => {
      const d = seedDispatchWithConversation();
      const mock = createMockMailRpc();

      await handleDispatchedThread(d.id, 2, undefined, () => mock.rpc as never);

      expect(mock.calls).toHaveLength(0);
    });

    it('applies resolveInboxAgentIdFn to transform the agent id', async () => {
      const d = seedDispatchWithConversation();
      const mock = createMockMailRpc();

      const resolver = (swarmId: string, agentId: string) => `inbox-${swarmId}-${agentId}`;
      await handleDispatchedThread(d.id, 2, 'agent-raw', () => mock.rpc as never, resolver);

      const inviteCall = mock.calls.find((c) => c.method === 'mail/invite');
      expect(inviteCall).toBeDefined();
      expect(inviteCall!.params.agentId).toBe(`inbox-${d.target_swarm_id}-agent-raw`);
    });
  });
});
