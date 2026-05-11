/**
 * Mail-push bridge importance propagation test.
 *
 * Verifies the full chain:
 *   1. A turn with `importance` is posted via mail/turn JSON-RPC
 *   2. agent-inbox stores it and emits `mail.turn.added`
 *   3. `createMailPushBridge` fires → `buildMailTurnReceivedParams` includes importance
 *   4. The `sendNotification` callback receives params with `importance`
 *
 * This covers the gap identified in the inter-repo flow audit: the hub's
 * `startMailPushBridge` in `src/mail/index.ts` wires `buildMailTurnReceivedParams`
 * to `sendToSwarm`, but no test verified that importance survives the chain.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  InMemoryStorage,
  MailJsonRpcServer,
  MessageRouter,
  TraceabilityLayer,
  createMailPushBridge,
  MAIL_TURN_RECEIVED_METHOD,
  type MailPushSubscriber,
} from 'agent-inbox';
import type { Storage } from 'agent-inbox';

describe('Mail-push bridge importance propagation', () => {
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

  it('includes importance in notification params when turn has importance', async () => {
    // Track what sendNotification receives
    const sentNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];

    // Wire the push bridge with a spy subscriber
    createMailPushBridge({
      mailEvents: events,
      getSubscribers: () => [{ id: 'swarm-test' }],
      sendNotification: (_sub: MailPushSubscriber, method: string, params: unknown) => {
        sentNotifications.push({ method, params: params as Record<string, unknown> });
      },
    });

    // Create a conversation + join a participant
    const createRes = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '1',
      method: 'mail/create',
      params: { subject: 'Dispatch thread', scope: 'dispatch-thread' },
    });
    const convId = (createRes.result as Record<string, unknown>).id as string;

    await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '2',
      method: 'mail/join',
      params: { conversationId: convId, agentId: 'agent-1', role: 'executor' },
    });

    // Post a turn WITH importance
    await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '3',
      method: 'mail/turn',
      params: {
        conversationId: convId,
        participantId: 'agent-1',
        content: 'Please check the failing test',
        contentType: 'text',
        importance: 'high',
      },
    });

    // Verify the bridge fired and importance is in the params
    const turnNotification = sentNotifications.find(
      (n) => n.method === MAIL_TURN_RECEIVED_METHOD,
    );
    expect(turnNotification).toBeDefined();
    expect(turnNotification!.params.importance).toBe('high');
    expect(turnNotification!.params.content).toBe('Please check the failing test');
    expect(turnNotification!.params.conversation_id).toBe(convId);
  });

  it('omits importance from notification when turn has no importance', async () => {
    const sentNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];

    createMailPushBridge({
      mailEvents: events,
      getSubscribers: () => [{ id: 'swarm-test' }],
      sendNotification: (_sub: MailPushSubscriber, method: string, params: unknown) => {
        sentNotifications.push({ method, params: params as Record<string, unknown> });
      },
    });

    const createRes = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '1',
      method: 'mail/create',
      params: { subject: 'No importance' },
    });
    const convId = (createRes.result as Record<string, unknown>).id as string;

    await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '2',
      method: 'mail/join',
      params: { conversationId: convId, agentId: 'agent-2', role: 'member' },
    });

    // Post a turn WITHOUT importance
    await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '3',
      method: 'mail/turn',
      params: {
        conversationId: convId,
        participantId: 'agent-2',
        content: 'Just a normal message',
        contentType: 'text',
      },
    });

    const turnNotification = sentNotifications.find(
      (n) => n.method === MAIL_TURN_RECEIVED_METHOD,
    );
    expect(turnNotification).toBeDefined();
    expect(turnNotification!.params.importance).toBeUndefined();
  });

  it('preserves importance across different levels (low, normal, high, urgent)', async () => {
    const sentNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];

    createMailPushBridge({
      mailEvents: events,
      getSubscribers: () => [{ id: 'swarm-test' }],
      sendNotification: (_sub: MailPushSubscriber, method: string, params: unknown) => {
        sentNotifications.push({ method, params: params as Record<string, unknown> });
      },
    });

    const createRes = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '1',
      method: 'mail/create',
      params: { subject: 'Multi-importance' },
    });
    const convId = (createRes.result as Record<string, unknown>).id as string;

    await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: '2',
      method: 'mail/join',
      params: { conversationId: convId, agentId: 'agent-3', role: 'member' },
    });

    const levels = ['low', 'normal', 'high', 'urgent'] as const;
    for (let i = 0; i < levels.length; i++) {
      await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: `turn-${i}`,
        method: 'mail/turn',
        params: {
          conversationId: convId,
          participantId: 'agent-3',
          content: `Message with ${levels[i]} importance`,
          contentType: 'text',
          importance: levels[i],
        },
      });
    }

    const turnNotifications = sentNotifications.filter(
      (n) => n.method === MAIL_TURN_RECEIVED_METHOD,
    );
    expect(turnNotifications).toHaveLength(4);
    expect(turnNotifications[0].params.importance).toBe('low');
    expect(turnNotifications[1].params.importance).toBe('normal');
    expect(turnNotifications[2].params.importance).toBe('high');
    expect(turnNotifications[3].params.importance).toBe('urgent');
  });
});
