/**
 * Tests for Inbox Bridge — agent-inbox integration with OpenHive's database.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { initInboxBridge, stopInboxBridge, getInboxRouter, getInboxJsonRpc, getInboxStorage, getInboxEvents } from '../../map/inbox-bridge.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

// Mock broadcastToChannel (imported transitively by sync-listener)
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

vi.mock('../../sync/resource-hooks.js', () => ({
  onResourceSynced: vi.fn(),
}));

const TEST_ROOT = testRoot('inbox-bridge');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'inbox-bridge.db');

describe('Inbox Bridge', () => {
  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    await initInboxBridge();
  });

  afterAll(async () => {
    await stopInboxBridge();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('should create inbox_* tables in OpenHive database', () => {
    const db = getDatabase();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'inbox_%'"
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('inbox_agents');
    expect(names).toContain('inbox_messages');
    expect(names).toContain('inbox_recipients');
    expect(names).toContain('inbox_conversations');
    expect(names).toContain('inbox_participants');
    expect(names).toContain('inbox_turns');
    expect(names).toContain('inbox_threads');
  });

  it('should coexist with OpenHive tables', () => {
    const db = getDatabase();
    // OpenHive tables should still exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents', 'hives', 'posts')"
    ).all() as { name: string }[];
    expect(tables.length).toBeGreaterThanOrEqual(2); // agents and hives at minimum
  });

  it('should expose a working message router', async () => {
    const router = getInboxRouter();
    const storage = getInboxStorage();

    // Register an agent first
    storage.putAgent({
      agent_id: 'test-agent-1',
      scope: 'default',
      status: 'active',
      metadata: {},
      registered_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
    });

    const msg = await router.routeMessage({
      from: 'test-agent-1',
      to: 'test-agent-2',
      payload: 'Hello from inbox bridge test',
    });

    expect(msg.id).toBeDefined();
    expect(msg.sender_id).toBe('test-agent-1');
    expect(msg.recipients[0].agent_id).toBe('test-agent-2');

    // Verify message is stored
    const stored = storage.getMessage(msg.id);
    expect(stored).toBeDefined();
    expect(stored!.content).toEqual({ type: 'text', text: 'Hello from inbox bridge test' });
  });

  it('should handle mail/* methods via JSON-RPC', async () => {
    const jsonRpc = getInboxJsonRpc();

    // Create a conversation
    const createRes = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '1',
      method: 'mail/create',
      params: { subject: 'Test conversation', scope: 'default' },
    });

    expect(createRes.error).toBeUndefined();
    const conv = createRes.result as { id: string; subject: string };
    expect(conv.subject).toBe('Test conversation');

    // Add a turn
    const turnRes = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '2',
      method: 'mail/turn',
      params: {
        conversationId: conv.id,
        participantId: 'test-agent-1',
        content: { type: 'text', text: 'First message' },
      },
    });

    expect(turnRes.error).toBeUndefined();
    const turn = turnRes.result as { id: string; conversation_id: string };
    expect(turn.conversation_id).toBe(conv.id);

    // Get conversation with turns
    const getRes = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '3',
      method: 'mail/get',
      params: { id: conv.id },
    });

    expect(getRes.error).toBeUndefined();
    const result = getRes.result as { conversation: { id: string }; turns: unknown[] };
    expect(result.conversation.id).toBe(conv.id);
    expect(result.turns).toHaveLength(1);
  });

  it('should return error for unknown mail method', async () => {
    const jsonRpc = getInboxJsonRpc();

    const res = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '99',
      method: 'mail/nonexistent',
      params: {},
    });

    expect(res.error).toBeDefined();
    expect(res.error!.code).toBe(-32601);
  });

  it('should emit mail.created event when conversation is created via JSON-RPC', async () => {
    const events = getInboxEvents();
    const listener = vi.fn();
    events.on('mail.created', listener);

    try {
      const jsonRpc = getInboxJsonRpc();
      await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: 'evt-1',
        method: 'mail/create',
        params: { subject: 'Event test', scope: 'default' },
      });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toMatchObject({ subject: 'Event test' });
    } finally {
      events.removeListener('mail.created', listener);
    }
  });

  it('should emit mail.turn.added event when turn is added via JSON-RPC', async () => {
    const events = getInboxEvents();
    const listener = vi.fn();
    events.on('mail.turn.added', listener);

    try {
      const jsonRpc = getInboxJsonRpc();
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: 'evt-2a',
        method: 'mail/create',
        params: { subject: 'Turn event test' },
      });
      const convId = (createRes.result as { id: string }).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: 'evt-2b',
        method: 'mail/turn',
        params: { conversationId: convId, participantId: 'agent-a', content: { type: 'text', text: 'hello' } },
      });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toMatchObject({ conversation_id: convId });
    } finally {
      events.removeListener('mail.turn.added', listener);
    }
  });

  it('should emit mail.participant.joined for both join and invite', async () => {
    const events = getInboxEvents();
    const listener = vi.fn();
    events.on('mail.participant.joined', listener);

    try {
      const jsonRpc = getInboxJsonRpc();
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: 'evt-3a',
        method: 'mail/create',
        params: { subject: 'Join event test' },
      });
      const convId = (createRes.result as { id: string }).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: 'evt-3b',
        method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-join' },
      });

      await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: 'evt-3c',
        method: 'mail/invite',
        params: { conversationId: convId, agentId: 'agent-invite', role: 'observer' },
      });

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls[0][0]).toEqual({ conversation_id: convId, agent_id: 'agent-join' });
      expect(listener.mock.calls[1][0]).toEqual({ conversation_id: convId, agent_id: 'agent-invite' });
    } finally {
      events.removeListener('mail.participant.joined', listener);
    }
  });

  it('should emit mail.closed on mail/close', async () => {
    const events = getInboxEvents();
    const listener = vi.fn();
    events.on('mail.closed', listener);

    try {
      const jsonRpc = getInboxJsonRpc();
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: 'evt-4a',
        method: 'mail/create',
        params: { subject: 'Close event test' },
      });
      const convId = (createRes.result as { id: string }).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: 'evt-4b',
        method: 'mail/close',
        params: { id: convId },
      });

      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0][0]).toEqual({ conversation_id: convId, status: 'completed' });
    } finally {
      events.removeListener('mail.closed', listener);
    }
  });

  it('should not close the shared database on stopInboxBridge', async () => {
    const db = getDatabase();

    // Stop and reinitialize
    await stopInboxBridge();

    // DB should still be usable
    const result = db.prepare('SELECT 1 as val').get() as { val: number };
    expect(result.val).toBe(1);

    // Reinitialize for remaining tests
    await initInboxBridge();
  });
});
