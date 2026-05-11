/**
 * Tests for continuation thread message enrichment — verifies that the
 * dispatch source correctly counts pending thread messages and injects
 * the count into task metadata for the prompt builder.
 *
 * Covers Phase 4 of dispatch-inbox-threads:
 * - Continuation enrichment counts pending messages correctly
 * - Zero pending when no conversation exists
 * - Zero pending when executor has no unread messages
 * - Counts only messages after executor's last turn
 */

import { describe, it, expect, vi } from 'vitest';
import { countPendingThreadMessages } from '../../dispatch/openhive-source.js';

// ---------------------------------------------------------------------------
// Mock mail RPC that returns controlled turn data
// ---------------------------------------------------------------------------

function createMockMailRpc(turns: Array<{ agentId: string; created_at: string }>) {
  return {
    handleRequest: vi.fn(async () => ({
      result: { turns },
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('countPendingThreadMessages', () => {
  it('counts messages after executor last turn', async () => {
    const rpc = createMockMailRpc([
      { agentId: 'executor-1', created_at: '2026-05-08T10:00:00Z' },
      { agentId: 'user_abc', created_at: '2026-05-08T10:01:00Z' },
      { agentId: 'user_abc', created_at: '2026-05-08T10:02:00Z' },
    ]);

    const count = await countPendingThreadMessages('conv-1', 'executor-1', rpc);
    expect(count).toBe(2);
  });

  it('returns all turns when executor never posted', async () => {
    const rpc = createMockMailRpc([
      { agentId: 'user_abc', created_at: '2026-05-08T10:00:00Z' },
      { agentId: 'user_xyz', created_at: '2026-05-08T10:01:00Z' },
    ]);

    const count = await countPendingThreadMessages('conv-1', 'executor-1', rpc);
    expect(count).toBe(2);
  });

  it('returns 0 when executor posted last', async () => {
    const rpc = createMockMailRpc([
      { agentId: 'user_abc', created_at: '2026-05-08T10:00:00Z' },
      { agentId: 'executor-1', created_at: '2026-05-08T10:01:00Z' },
    ]);

    const count = await countPendingThreadMessages('conv-1', 'executor-1', rpc);
    expect(count).toBe(0);
  });

  it('returns all turns when executorAgentId is undefined', async () => {
    const rpc = createMockMailRpc([
      { agentId: 'user_abc', created_at: '2026-05-08T10:00:00Z' },
      { agentId: 'user_xyz', created_at: '2026-05-08T10:01:00Z' },
    ]);

    const count = await countPendingThreadMessages('conv-1', undefined, rpc);
    expect(count).toBe(2);
  });

  it('returns 0 when conversation has no turns', async () => {
    const rpc = createMockMailRpc([]);

    const count = await countPendingThreadMessages('conv-1', 'executor-1', rpc);
    expect(count).toBe(0);
  });

  it('returns 0 when mail RPC throws', async () => {
    const rpc = {
      handleRequest: vi.fn(async () => {
        throw new Error('mail unavailable');
      }),
    };

    const count = await countPendingThreadMessages('conv-1', 'executor-1', rpc);
    expect(count).toBe(0);
  });

  it('excludes executor own turns from pending count', async () => {
    const rpc = createMockMailRpc([
      { agentId: 'executor-1', created_at: '2026-05-08T10:00:00Z' },
      { agentId: 'user_abc', created_at: '2026-05-08T10:01:00Z' },
      { agentId: 'executor-1', created_at: '2026-05-08T10:02:00Z' },
      { agentId: 'user_abc', created_at: '2026-05-08T10:03:00Z' },
      { agentId: 'system:dispatch-orchestrator', created_at: '2026-05-08T10:04:00Z' },
    ]);

    // Only messages after executor's last turn (10:02:00Z) that aren't the executor's own
    const count = await countPendingThreadMessages('conv-1', 'executor-1', rpc);
    expect(count).toBe(2); // user_abc + system:dispatch-orchestrator
  });
});
