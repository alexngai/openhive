/**
 * Mail API Routes
 *
 * REST proxy to the embedded agent-inbox mail module.
 * Provides human-facing observability into all MAP mail conversations
 * flowing through the hub, plus the ability to inject turns as a supervisor.
 *
 * Routes:
 *   GET  /mail/conversations              - List all conversations
 *   GET  /mail/conversations/:id           - Get conversation with turns & threads
 *   GET  /mail/conversations/:id/turns     - List turns in a conversation
 *   GET  /mail/conversations/:id/threads   - List threads in a conversation
 *   POST /mail/conversations/:id/join      - Join a conversation as supervisor
 *   POST /mail/conversations/:id/turns     - Send a turn into a conversation
 */

import { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.js';
import { getMailStorage, getMailJsonRpc } from '../../mail/index.js';
import type { Config } from '../../config.js';

export async function mailRoutes(
  fastify: FastifyInstance,
  _opts: { config: Config },
): Promise<void> {

  // GET /mail/conversations — List all conversations
  fastify.get<{
    Querystring: { scope?: string; status?: string };
  }>('/mail/conversations', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const storage = getMailStorage();
    const { scope, status } = request.query;

    let conversations = storage.listConversations(scope || undefined);

    // Filter by status if requested
    if (status) {
      conversations = conversations.filter((c) => c.status === status);
    }

    // Sort by updated_at descending (most recent first)
    conversations.sort((a, b) =>
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );

    return reply.send({ conversations });
  });

  // GET /mail/conversations/:id — Get conversation details with turns and threads
  fastify.get<{
    Params: { id: string };
  }>('/mail/conversations/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const storage = getMailStorage();
    const conv = storage.getConversation(request.params.id);

    if (!conv) {
      return reply.status(404).send({
        error: 'NOT_FOUND',
        message: `Conversation ${request.params.id} not found`,
      });
    }

    const turns = storage.getTurns(conv.id);
    const threads = storage.getThreadsByConversation(conv.id);

    return reply.send({
      conversation: conv,
      turns,
      threads,
      turn_count: turns.length,
    });
  });

  // GET /mail/conversations/:id/turns — List turns in a conversation
  fastify.get<{
    Params: { id: string };
    Querystring: { thread_id?: string; content_type?: string };
  }>('/mail/conversations/:id/turns', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const storage = getMailStorage();
    const conv = storage.getConversation(request.params.id);

    if (!conv) {
      return reply.status(404).send({
        error: 'NOT_FOUND',
        message: `Conversation ${request.params.id} not found`,
      });
    }

    let turns = storage.getTurns(conv.id);
    const { thread_id, content_type } = request.query;

    if (thread_id) {
      turns = turns.filter((t) => t.thread_id === thread_id);
    }
    if (content_type) {
      turns = turns.filter((t) => t.content_type === content_type);
    }

    return reply.send({ turns });
  });

  // GET /mail/conversations/:id/threads — List threads in a conversation
  fastify.get<{
    Params: { id: string };
  }>('/mail/conversations/:id/threads', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const storage = getMailStorage();
    const conv = storage.getConversation(request.params.id);

    if (!conv) {
      return reply.status(404).send({
        error: 'NOT_FOUND',
        message: `Conversation ${request.params.id} not found`,
      });
    }

    const threads = storage.getThreadsByConversation(conv.id);
    return reply.send({ threads });
  });

  // POST /mail/conversations/:id/join — Join conversation as supervisor
  fastify.post<{
    Params: { id: string };
    Body: { role?: string };
  }>('/mail/conversations/:id/join', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const jsonRpc = getMailJsonRpc();
    const agent = (request as any).agent;

    const response = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: 'join-' + Date.now(),
      method: 'mail/join',
      params: {
        conversationId: request.params.id,
        agentId: agent.id,
        role: request.body?.role ?? 'supervisor',
      },
    });

    if (response.error) {
      const status = response.error.code === -32001 ? 404 : 400;
      return reply.status(status).send({
        error: response.error.message,
      });
    }

    return reply.send(response.result);
  });

  // POST /mail/conversations/:id/turns — Send a turn as supervisor
  fastify.post<{
    Params: { id: string };
    Body: {
      content: unknown;
      content_type?: string;
      thread_id?: string;
      in_reply_to?: string;
    };
  }>('/mail/conversations/:id/turns', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const jsonRpc = getMailJsonRpc();
    const agent = (request as any).agent;
    const { content, content_type, thread_id, in_reply_to } = request.body;

    // Auto-join the conversation if not already a participant
    const storage = getMailStorage();
    const conv = storage.getConversation(request.params.id);
    if (!conv) {
      return reply.status(404).send({
        error: 'NOT_FOUND',
        message: `Conversation ${request.params.id} not found`,
      });
    }

    if (!conv.participants.some((p) => p.agent_id === agent.id)) {
      await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: 'autojoin-' + Date.now(),
        method: 'mail/join',
        params: {
          conversationId: request.params.id,
          agentId: agent.id,
          role: 'supervisor',
        },
      });
    }

    // Send the turn
    const response = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: 'turn-' + Date.now(),
      method: 'mail/turn',
      params: {
        conversationId: request.params.id,
        participantId: agent.id,
        contentType: content_type ?? 'text',
        content,
        threadId: thread_id,
        inReplyTo: in_reply_to,
      },
    });

    if (response.error) {
      return reply.status(400).send({
        error: response.error.message,
      });
    }

    return reply.status(201).send(response.result);
  });
}
