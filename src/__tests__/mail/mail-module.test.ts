/**
 * Mail Module Unit Tests
 *
 * Tests the mail module initialization and integration with agent-inbox.
 * Verifies that conversations, turns, and threads flow correctly through
 * the embedded agent-inbox instance.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { InMemoryStorage, MailJsonRpcServer, MessageRouter, TraceabilityLayer } from 'agent-inbox';
import type { Storage } from 'agent-inbox';

// Mock broadcastToChannel
vi.mock('../../realtime/index.js', () => ({ broadcastToChannel: vi.fn() }));

describe('Mail Module — agent-inbox integration', () => {
  let storage: Storage;
  let jsonRpc: MailJsonRpcServer;
  let events: EventEmitter;

  beforeEach(() => {
    events = new EventEmitter();
    storage = new InMemoryStorage();
    const router = new MessageRouter(storage, events, 'default');
    new TraceabilityLayer(storage, events);
    jsonRpc = new MailJsonRpcServer(storage, router, events);
  });

  // ── Conversation lifecycle ──

  describe('Conversation lifecycle', () => {
    it('creates a conversation', async () => {
      const res = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Test', scope: 'default' },
      });

      expect(res.error).toBeUndefined();
      const conv = res.result as any;
      expect(conv.id).toBeDefined();
      expect(conv.subject).toBe('Test');
      expect(conv.status).toBe('active');
      expect(conv.participants).toEqual([]);
    });

    it('closes a conversation', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'To close' },
      });
      const convId = (createRes.result as any).id;

      const closeRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/close',
        params: { id: convId },
      });

      expect(closeRes.error).toBeUndefined();
      const conv = storage.getConversation(convId);
      expect(conv!.status).toBe('completed');
    });

    it('lists conversations', async () => {
      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Conv A' },
      });
      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/create',
        params: { subject: 'Conv B' },
      });

      const listRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/list',
        params: {},
      });

      const result = listRes.result as any;
      expect(result.conversations).toHaveLength(2);
    });

    it('gets conversation with turns and threads', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Detail' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'a1' },
      });
      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'text', content: { type: 'text', text: 'hi' },
        },
      });

      const getRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '4', method: 'mail/get',
        params: { id: convId },
      });

      const result = getRes.result as any;
      expect(result.conversation.subject).toBe('Detail');
      expect(result.turns).toHaveLength(1);
      expect(result.threads).toEqual([]);
    });

    it('returns error for non-existent conversation', async () => {
      const res = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/get',
        params: { id: 'nonexistent' },
      });

      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32001);
    });
  });

  // ── Participants ──

  describe('Participants', () => {
    it('joins a conversation', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Join test' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });

      const conv = storage.getConversation(convId);
      expect(conv!.participants).toHaveLength(1);
      expect(conv!.participants[0].agent_id).toBe('agent-1');
    });

    it('does not duplicate participants', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Dup test' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });
      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });

      const conv = storage.getConversation(convId);
      expect(conv!.participants).toHaveLength(1);
    });

    it('leaves a conversation', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Leave test' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });
      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/leave',
        params: { conversationId: convId, agentId: 'agent-1' },
      });

      const conv = storage.getConversation(convId);
      expect(conv!.participants).toHaveLength(0);
    });

    it('invites with a role', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Invite test' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/invite',
        params: { conversationId: convId, agentId: 'agent-1', role: 'analyst' },
      });

      const conv = storage.getConversation(convId);
      expect(conv!.participants[0].role).toBe('analyst');
    });
  });

  // ── Turns ──

  describe('Turns', () => {
    it('records a text turn', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Turn test' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });

      const turnRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId,
          participantId: 'agent-1',
          contentType: 'text',
          content: { type: 'text', text: 'Hello world' },
        },
      });

      expect(turnRes.error).toBeUndefined();
      const turn = turnRes.result as any;
      expect(turn.id).toBeDefined();
      expect(turn.content_type).toBe('text');
      expect(turn.content.text).toBe('Hello world');
    });

    it('records turns with different content types', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Content types' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'a1' },
      });

      // Text turn
      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'text', content: { type: 'text', text: 'Hi' },
        },
      });

      // Event turn
      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '4', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'event', content: { type: 'event', event: 'started' },
        },
      });

      // Data turn
      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '5', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'data', content: { type: 'data', data: { key: 'value' } },
        },
      });

      // Reference turn
      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '6', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'reference', content: { type: 'reference', uri: 'https://example.com' },
        },
      });

      const turns = storage.getTurns(convId);
      expect(turns).toHaveLength(4);
      expect(turns.map(t => t.content_type)).toEqual(['text', 'event', 'data', 'reference']);
    });

    it('lists turns for a conversation', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'List turns' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'a1' },
      });

      for (let i = 0; i < 3; i++) {
        await jsonRpc.handleRequest({
          jsonrpc: '2.0', id: `t${i}`, method: 'mail/turn',
          params: {
            conversationId: convId, participantId: 'a1',
            contentType: 'text', content: { type: 'text', text: `Turn ${i}` },
          },
        });
      }

      const listRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '99', method: 'mail/turns/list',
        params: { conversationId: convId },
      });

      const result = listRes.result as any;
      expect(result.turns).toHaveLength(3);
    });

    it('supports in_reply_to', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Reply test' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'a1' },
      });

      const t1 = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'text', content: { type: 'text', text: 'Original' },
        },
      });
      const turnId = (t1.result as any).id;

      const t2 = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '4', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'text', content: { type: 'text', text: 'Reply' },
          inReplyTo: turnId,
        },
      });

      expect((t2.result as any).in_reply_to).toBe(turnId);
    });

    it('updates conversation updated_at when turn is added', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Timestamp test' },
      });
      const convId = (createRes.result as any).id;
      const originalUpdatedAt = (createRes.result as any).updated_at;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'a1' },
      });

      await new Promise(r => setTimeout(r, 10));

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'text', content: { type: 'text', text: 'Update ts' },
        },
      });

      const conv = storage.getConversation(convId);
      expect(conv!.updated_at).not.toBe(originalUpdatedAt);
    });
  });

  // ── Threads ──

  describe('Threads', () => {
    it('creates a thread from a turn', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Thread test' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'a1' },
      });

      const turnRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'text', content: { type: 'text', text: 'Thread root' },
        },
      });
      const turnId = (turnRes.result as any).id;

      const threadRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '4', method: 'mail/thread/create',
        params: {
          conversationId: convId,
          rootTurnId: turnId,
          subject: 'Side discussion',
        },
      });

      expect(threadRes.error).toBeUndefined();
      const thread = threadRes.result as any;
      expect(thread.id).toBeDefined();
      expect(thread.root_turn_id).toBe(turnId);
      expect(thread.subject).toBe('Side discussion');
    });

    it('lists threads for a conversation', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'List threads' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'a1' },
      });

      // Create two turns and two threads
      for (let i = 0; i < 2; i++) {
        const turnRes = await jsonRpc.handleRequest({
          jsonrpc: '2.0', id: `t${i}`, method: 'mail/turn',
          params: {
            conversationId: convId, participantId: 'a1',
            contentType: 'text', content: { type: 'text', text: `Root ${i}` },
          },
        });
        await jsonRpc.handleRequest({
          jsonrpc: '2.0', id: `th${i}`, method: 'mail/thread/create',
          params: {
            conversationId: convId,
            rootTurnId: (turnRes.result as any).id,
          },
        });
      }

      const listRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '99', method: 'mail/thread/list',
        params: { conversationId: convId },
      });

      expect((listRes.result as any).threads).toHaveLength(2);
    });

    it('supports turns within a thread', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Thread turns' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'a1' },
      });

      const turnRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'text', content: { type: 'text', text: 'Root' },
        },
      });

      const threadRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '4', method: 'mail/thread/create',
        params: { conversationId: convId, rootTurnId: (turnRes.result as any).id },
      });
      const threadId = (threadRes.result as any).id;

      // Add a turn in the thread
      const threadTurnRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '5', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'text', content: { type: 'text', text: 'In thread' },
          threadId: threadId,
        },
      });

      expect((threadTurnRes.result as any).thread_id).toBe(threadId);
    });
  });

  // ── Events ──

  describe('Events', () => {
    it('emits mail.created event', async () => {
      const handler = vi.fn();
      events.on('mail.created', handler);

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Event test' },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].subject).toBe('Event test');
    });

    it('emits mail.turn.added event', async () => {
      const handler = vi.fn();
      events.on('mail.turn.added', handler);

      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Turn event' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'a1' },
      });

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '3', method: 'mail/turn',
        params: {
          conversationId: convId, participantId: 'a1',
          contentType: 'text', content: { type: 'text', text: 'Event!' },
        },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].content.text).toBe('Event!');
    });

    it('emits mail.participant.joined event', async () => {
      const handler = vi.fn();
      events.on('mail.participant.joined', handler);

      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Join event' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'agent-1' },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].agent_id).toBe('agent-1');
    });

    it('emits mail.closed event', async () => {
      const handler = vi.fn();
      events.on('mail.closed', handler);

      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Close event' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/close',
        params: { id: convId },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].conversation_id).toBe(convId);
    });
  });

  // ── Replay ──

  describe('Replay', () => {
    it('replays all turns and threads for a conversation', async () => {
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/create',
        params: { subject: 'Replay test' },
      });
      const convId = (createRes.result as any).id;

      await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '2', method: 'mail/join',
        params: { conversationId: convId, agentId: 'a1' },
      });

      for (let i = 0; i < 5; i++) {
        await jsonRpc.handleRequest({
          jsonrpc: '2.0', id: `t${i}`, method: 'mail/turn',
          params: {
            conversationId: convId, participantId: 'a1',
            contentType: 'text', content: { type: 'text', text: `Turn ${i}` },
          },
        });
      }

      const replayRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '99', method: 'mail/replay',
        params: { id: convId },
      });

      const result = replayRes.result as any;
      expect(result.conversation.subject).toBe('Replay test');
      expect(result.turns).toHaveLength(5);
      expect(result.threads).toEqual([]);
    });
  });

  // ── Error handling ──

  describe('Error handling', () => {
    it('returns error for unknown method', async () => {
      const res = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/unknown',
        params: {},
      });

      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32601);
    });

    it('returns error for invalid JSON-RPC version', async () => {
      const res = await jsonRpc.handleRequest({
        jsonrpc: '1.0' as any, id: '1', method: 'mail/list',
        params: {},
      });

      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32600);
    });

    it('returns error when adding turn to non-existent conversation', async () => {
      const res = await jsonRpc.handleRequest({
        jsonrpc: '2.0', id: '1', method: 'mail/turn',
        params: {
          conversationId: 'nonexistent', participantId: 'a1',
          contentType: 'text', content: { type: 'text', text: 'Fail' },
        },
      });

      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32001);
    });
  });
});
