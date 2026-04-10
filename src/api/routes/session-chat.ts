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
  content: z.string().min(1).max(100_000),
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
    const storage = getMailStorage();

    // Find or create linked conversation.
    // Re-read metadata inside the create path to handle races: if two requests
    // arrive simultaneously, both see no conversation_id. The first creates one
    // and stores it in metadata. The second re-reads metadata after creation
    // and discovers the first's conversation, avoiding a duplicate.
    let conversationId = getLinkedConversationId(sessionId);

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

      const newConvId = (createRes.result as any).id;

      // Re-read metadata to check if another request won the race
      const raceCheck = getLinkedConversationId(sessionId);
      if (raceCheck) {
        // Another request created a conversation first — use theirs
        conversationId = raceCheck;
      } else {
        conversationId = newConvId;
        // Store conversation ID in session metadata (atomic merge)
        const freshResource = resourcesDAL.findResourceById(sessionId);
        const freshMeta = (freshResource?.metadata as Record<string, unknown>) || {};
        resourcesDAL.updateResource(sessionId, {
          metadata: { ...freshMeta, mail_conversation_id: conversationId },
        });
      }
    }

    // Verify conversation still exists (may have been deleted externally)
    const conv = storage.getConversation(conversationId!);
    if (!conv) {
      // Conversation was deleted — clear stale reference and create a new one
      const freshResource = resourcesDAL.findResourceById(sessionId);
      const freshMeta = (freshResource?.metadata as Record<string, unknown>) || {};
      delete freshMeta.mail_conversation_id;
      resourcesDAL.updateResource(sessionId, { metadata: freshMeta });

      return reply.status(410).send({
        error: 'CONVERSATION_DELETED',
        message: 'Linked conversation was deleted. Retry to create a new one.',
      });
    }

    // Auto-join as supervisor if not already a participant
    if (!conv.participants.some((p: any) => p.agent_id === agent.id)) {
      const joinRes = await jsonRpc.handleRequest({
        jsonrpc: '2.0',
        id: `join-${Date.now()}`,
        method: 'mail/join',
        params: {
          conversationId,
          agentId: agent.id,
          role: 'supervisor',
        },
      });

      if (joinRes.error) {
        return reply.status(500).send({
          error: 'JOIN_FAILED',
          message: joinRes.error.message,
        });
      }
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
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Session not found' });
    }

    const conversationId = getLinkedConversationId(request.params.id);

    return reply.send({
      conversation_id: conversationId ?? null,
      chat_available: !!conversationId,
    });
  });
}

/** Read mail_conversation_id from session resource metadata. */
function getLinkedConversationId(sessionId: string): string | undefined {
  const resource = resourcesDAL.findResourceById(sessionId);
  if (!resource) return undefined;
  const metadata = (resource.metadata as Record<string, unknown>) || {};
  return metadata.mail_conversation_id as string | undefined;
}
