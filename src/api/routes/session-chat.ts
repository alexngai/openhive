/**
 * Session Chat Route
 *
 * POST /sessions/:id/chat — Send a message to a session's linked mail conversation.
 * Creates the conversation lazily on first send, then delivers the turn via agent-inbox.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { getMailJsonRpc, getMailStorage } from '../../mail/index.js';

const SendChatSchema = z.object({
  content: z.string().min(1),
  content_type: z.string().optional(),
  thread_id: z.string().optional(),
  in_reply_to: z.string().optional(),
});

export async function sessionChatRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{
    Params: { id: string };
    Body: z.infer<typeof SendChatSchema>;
  }>('/sessions/:id/chat', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const sessionId = request.params.id;
    const agent = (request as any).agent;

    // Parse and validate body
    const parsed = SendChatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        message: parsed.error.issues.map(i => i.message).join(', '),
      });
    }
    const { content, content_type, thread_id, in_reply_to } = parsed.data;

    // Validate session exists
    const resource = resourcesDAL.findResourceById(sessionId);
    if (!resource || resource.resource_type !== 'session') {
      return reply.status(404).send({
        error: 'NOT_FOUND',
        message: `Session ${sessionId} not found`,
      });
    }

    const jsonRpc = getMailJsonRpc();
    const metadata = (resource.metadata as Record<string, unknown>) || {};

    // Find or create linked conversation
    let conversationId = metadata.mail_conversation_id as string | undefined;

    if (!conversationId) {
      // Create conversation lazily on first send
      const createRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: `create-${Date.now()}`,
        method: 'mail/create',
        params: {
          subject: `Session: ${resource.name}`,
          scope: `session:${sessionId}`,
          metadata: { session_resource_id: sessionId },
        },
      });

      if (createRes.error) {
        return reply.status(500).send({
          error: 'CONVERSATION_CREATE_FAILED',
          message: createRes.error.message,
        });
      }

      conversationId = (createRes.result as any).id;

      // Store conversation ID in session metadata
      resourcesDAL.updateResource(sessionId, {
        metadata: {
          ...metadata,
          mail_conversation_id: conversationId,
        },
      });
    }

    // Auto-join as supervisor if not already a participant
    const storage = getMailStorage();
    const conv = storage.getConversation(conversationId!);
    if (conv && !conv.participants.some((p: any) => p.agent_id === agent.id)) {
      await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: `join-${Date.now()}`,
        method: 'mail/join',
        params: {
          conversationId,
          agentId: agent.id,
          role: 'supervisor',
        },
      });
    }

    // Send the turn
    const turnRes = await jsonRpc.handleRequest({
      jsonrpc: '2.0',
      id: `turn-${Date.now()}`,
      method: 'mail/turn',
      params: {
        conversationId,
        participantId: agent.id,
        contentType: content_type ?? 'supervisor',
        content: { type: 'text', text: content },
        threadId: thread_id,
        inReplyTo: in_reply_to,
      },
    });

    if (turnRes.error) {
      return reply.status(400).send({
        error: 'SEND_FAILED',
        message: turnRes.error.message,
      });
    }

    return reply.status(201).send({
      ok: true,
      conversation_id: conversationId,
      turn: turnRes.result,
    });
  });

  // GET /sessions/:id/chat — Get the linked conversation ID (if any)
  fastify.get<{ Params: { id: string } }>('/sessions/:id/chat', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const resource = resourcesDAL.findResourceById(request.params.id);
    if (!resource || resource.resource_type !== 'session') {
      return reply.status(404).send({ error: 'NOT_FOUND' });
    }

    const metadata = (resource.metadata as Record<string, unknown>) || {};
    const conversationId = metadata.mail_conversation_id as string | undefined;

    return reply.send({
      conversation_id: conversationId ?? null,
      chat_available: !!conversationId,
    });
  });
}
