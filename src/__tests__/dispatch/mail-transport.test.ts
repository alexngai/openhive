/**
 * Tests for the dispatch mail transport (cascade: agent-inbox → MAP scope).
 *
 * Covers the per-agent capability cascade: mail-capable agents get a mail
 * conversation; messaging-only agents get a MAP JSON-RPC notification; the
 * rest get `recipient_unreachable`. Exercises both the send and receive
 * halves, plus cancellation's `x-dispatch/cancel` envelope.
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryStorage, MailJsonRpcServer, MessageRouter } from 'agent-inbox';
import {
  createOpenHiveMailTransport,
  DISPATCHER_PARTICIPANT_ID,
  DISPATCH_MAP_MESSAGE_METHOD,
} from '../../dispatch/mail-transport.js';
import {
  pushDispatchMapReply,
  _resetDispatchMapReply,
} from '../../dispatch/mail-ingress.js';
import {
  registerInbound,
  unregisterInbound,
  type RegisteredAgent,
} from '../../map/connection-registry.js';

function makeMailModule() {
  const storage = new InMemoryStorage();
  const events = new EventEmitter();
  const router = new MessageRouter(storage, events, 'default');
  const jsonRpc = new MailJsonRpcServer(storage, router, events);
  return { storage, events, jsonRpc };
}

function mockAgent(
  id: string,
  capabilities: Record<string, unknown>,
): RegisteredAgent {
  return {
    id,
    name: id,
    role: 'worker',
    state: 'active',
    scopes: [],
    capabilities,
  };
}

function registerSwarm(swarmId: string, agents: RegisteredAgent[]) {
  const registered = new Map<string, RegisteredAgent>();
  for (const a of agents) registered.set(a.id, a);
  // Minimal fake inbound WS (never used by cap checks).
  const fakeWs = { readyState: 1, send() {}, close() {} } as unknown as import('ws').WebSocket;
  registerInbound(swarmId, {
    ws: fakeWs,
    agentId: agents[0]?.id ?? 'primary',
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: registered,
  });
}

describe('mail-transport cascade', () => {
  let mail: ReturnType<typeof makeMailModule>;
  let sends: Array<{ swarmId: string; message: object }>;
  let sendSuccess: boolean;

  beforeEach(() => {
    mail = makeMailModule();
    sends = [];
    sendSuccess = true;
    _resetDispatchMapReply();
  });

  afterEach(() => {
    unregisterInbound('swarm-a');
    unregisterInbound('swarm-b');
    unregisterInbound('swarm-c');
  });

  function makeTransport() {
    return createOpenHiveMailTransport({
      getMailJsonRpc: () => mail.jsonRpc,
      getMailStorage: () => mail.storage,
      getMailEvents: () => mail.events,
      sendToSwarm: (swarmId, message) => {
        sends.push({ swarmId, message });
        return sendSuccess;
      },
    });
  }

  it('routes to mail when the target agent declares mail.canJoin', async () => {
    registerSwarm('swarm-a', [mockAgent('agent-mail', { mail: { canJoin: true } })]);
    const transport = makeTransport();

    const result = await transport.sendToAgent('swarm-a', 'agent-mail', {
      type: 'x-dispatch/work',
      body: { taskId: 'd-1', prompt: 'do the thing', role: 'worker' },
    });

    expect(result.delivered).toBe(true);
    const conversations = mail.storage.listConversations('swarm-dispatch');
    expect(conversations).toHaveLength(1);
    expect(conversations[0].metadata).toMatchObject({
      source: 'swarm-dispatch',
      swarm_id: 'swarm-a',
      agent_id: 'agent-mail',
    });
    const turns = mail.storage.getTurns(conversations[0].id);
    expect(turns).toHaveLength(1);
    expect(turns[0].participant_id).toBe(DISPATCHER_PARTICIPANT_ID);
    const envelope = JSON.parse(turns[0].content as unknown as string);
    expect(envelope.body.taskId).toBe('d-1');
  });

  it('reuses the same conversation for subsequent sends to the same agent', async () => {
    registerSwarm('swarm-a', [mockAgent('agent-mail', { mail: { canJoin: true } })]);
    const transport = makeTransport();

    await transport.sendToAgent('swarm-a', 'agent-mail', {
      type: 'x-dispatch/work',
      body: { taskId: 'd-1' },
    });
    await transport.sendToAgent('swarm-a', 'agent-mail', {
      type: 'x-dispatch/work',
      body: { taskId: 'd-2' },
    });

    const conversations = mail.storage.listConversations('swarm-dispatch');
    expect(conversations).toHaveLength(1);
    expect(mail.storage.getTurns(conversations[0].id)).toHaveLength(2);
  });

  it('routes to MAP scope when the agent only declares messaging.canReceive', async () => {
    registerSwarm('swarm-b', [
      mockAgent('agent-map', { messaging: { canReceive: true } }),
    ]);
    const transport = makeTransport();

    const result = await transport.sendToAgent('swarm-b', 'agent-map', {
      type: 'x-dispatch/cancel',
      body: { correlationId: 'd-9', reason: 'cancelled' },
    });

    expect(result.delivered).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].swarmId).toBe('swarm-b');
    const msg = sends[0].message as {
      method: string;
      params: { to_agent_id: string; envelope: { type: string; body: unknown } };
    };
    expect(msg.method).toBe(DISPATCH_MAP_MESSAGE_METHOD);
    expect(msg.params.to_agent_id).toBe('agent-map');
    expect(msg.params.envelope.type).toBe('x-dispatch/cancel');
  });

  it('returns recipient_unreachable when agent lacks both capabilities', async () => {
    registerSwarm('swarm-c', [mockAgent('agent-silent', {})]);
    const transport = makeTransport();

    const result = await transport.sendToAgent('swarm-c', 'agent-silent', {
      type: 'x-dispatch/work',
      body: { taskId: 'd-x' },
    });

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('no_mail_transport');
    expect(sends).toHaveLength(0);
    expect(mail.storage.listConversations('swarm-dispatch')).toHaveLength(0);
  });

  it('returns recipient_unreachable when the agent is not registered', async () => {
    const transport = makeTransport();

    const result = await transport.sendToAgent('swarm-missing', 'ghost', {
      type: 'x-dispatch/work',
      body: { taskId: 'd-x' },
    });

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('recipient_unreachable');
  });

  it('demuxes inbound mail turns on dispatch conversations to onMessage', async () => {
    registerSwarm('swarm-a', [mockAgent('agent-mail', { mail: { canJoin: true } })]);
    const transport = makeTransport();

    const received: Array<{ from: { swarmId: string; agentId: string }; message: unknown }> = [];
    transport.onMessage((from, message) => received.push({ from, message }));

    // Send first so the conversation exists.
    await transport.sendToAgent('swarm-a', 'agent-mail', {
      type: 'x-dispatch/work',
      body: { taskId: 'd-42' },
    });

    // Simulate agent reply — a turn on the same conversation from the agent.
    const conv = mail.storage.listConversations('swarm-dispatch')[0];
    await mail.jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: 'r-1',
      method: 'mail/turn',
      params: {
        conversationId: conv.id,
        participantId: 'agent-mail',
        contentType: 'application/json',
        content: JSON.stringify({
          type: 'x-dispatch/result',
          body: { taskId: 'd-42', status: 'completed' },
        }),
      },
    } as Parameters<MailJsonRpcServer['handleRequest']>[0]);

    expect(received).toHaveLength(1);
    expect(received[0].from).toEqual({ swarmId: 'swarm-a', agentId: 'agent-mail' });
    expect((received[0].message as { type: string }).type).toBe('x-dispatch/result');
  });

  it('drops mail turns from participants other than the conversation target', async () => {
    registerSwarm('swarm-a', [mockAgent('agent-mail', { mail: { canJoin: true } })]);
    const transport = makeTransport();
    const received: unknown[] = [];
    transport.onMessage((from, message) => received.push({ from, message }));

    // Create the dispatch conversation by sending.
    await transport.sendToAgent('swarm-a', 'agent-mail', {
      type: 'x-dispatch/work',
      body: { taskId: 'd-42' },
    });
    const conv = mail.storage.listConversations('swarm-dispatch')[0];

    // A third party posts on the same conversation — must be ignored.
    await mail.jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: 'r-imposter',
      method: 'mail/turn',
      params: {
        conversationId: conv.id,
        participantId: 'agent-imposter',
        contentType: 'application/json',
        content: JSON.stringify({
          type: 'x-dispatch/result',
          body: { taskId: 'd-42' },
        }),
      },
    } as Parameters<MailJsonRpcServer['handleRequest']>[0]);

    expect(received).toHaveLength(0);
  });

  it('ignores mail turns on non-dispatch conversations', async () => {
    const transport = makeTransport();
    const received: unknown[] = [];
    transport.onMessage((from, message) => received.push({ from, message }));

    // Create a conversation outside the dispatch scope.
    const convResp = (await mail.jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: 'c-1',
      method: 'mail/create',
      params: { scope: 'random', subject: 'unrelated' },
    } as Parameters<MailJsonRpcServer['handleRequest']>[0])) as { result: { id: string } };

    await mail.jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: 'r-1',
      method: 'mail/turn',
      params: {
        conversationId: convResp.result.id,
        participantId: 'alice',
        content: 'hi',
      },
    } as Parameters<MailJsonRpcServer['handleRequest']>[0]);

    expect(received).toHaveLength(0);
  });

  it('fans MAP dispatch replies to onMessage listeners', () => {
    const transport = makeTransport();
    const received: Array<{ from: { swarmId: string; agentId: string }; message: unknown }> = [];
    transport.onMessage((from, message) => received.push({ from, message }));

    pushDispatchMapReply({
      swarmId: 'swarm-b',
      fromAgentId: 'agent-map',
      message: { type: 'x-dispatch/result', body: { taskId: 'd-7' } },
    });

    expect(received).toHaveLength(1);
    expect(received[0].from).toEqual({ swarmId: 'swarm-b', agentId: 'agent-map' });
  });

  it('reports MAP send failure as recipient_unreachable', async () => {
    registerSwarm('swarm-b', [
      mockAgent('agent-map', { messaging: { canReceive: true } }),
    ]);
    sendSuccess = false;
    const transport = makeTransport();

    const result = await transport.sendToAgent('swarm-b', 'agent-map', {
      type: 'x-dispatch/work',
      body: { taskId: 'd-1' },
    });

    expect(result.delivered).toBe(false);
    expect(result.reason).toBe('recipient_unreachable');
  });
});
