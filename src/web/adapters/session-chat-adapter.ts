/**
 * SessionChatAdapter
 *
 * A ChatChannelAdapter for mail-based session chat. Routes messages through
 * the POST /sessions/:id/chat endpoint, which lazily creates a linked mail
 * conversation on first send.
 *
 * Usage:
 *   const adapter = createSessionChatAdapter({ sessionId: 'res-123' });
 *   <AgentChat agentId={swarmAgentId} channelConfig={{ adapters: [adapter] }} />
 */

import type { MailTurn, MessageContent } from '../lib/api';

type ChatMessage = import('swarmcraft/ui/embed').ChatMessage;
type ChatChannelAdapter = import('swarmcraft/ui/embed').ChatChannelAdapter;

const API_BASE = '/api/v1';

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('openhive_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || err.message || `Request failed: ${res.status}`);
  }
  return res.json();
}

function mailTurnToChat(turn: MailTurn): ChatMessage {
  const isSupervisor = turn.content_type === 'supervisor';

  let content = '';
  const mc = turn.content as MessageContent;
  if (typeof mc === 'string') {
    content = mc;
  } else if (mc && typeof mc === 'object' && 'text' in mc && mc.text) {
    content = mc.text;
  } else if (mc) {
    content = JSON.stringify(mc);
  }

  return {
    id: turn.id,
    role: isSupervisor ? 'supervisor' : 'agent',
    sender: turn.participant_id,
    senderName: isSupervisor ? 'You' : turn.participant_id,
    content,
    contentType: 'text',
    rawContent: mc,
    timestamp: new Date(turn.created_at).getTime(),
    threadId: turn.thread_id,
    inReplyTo: turn.in_reply_to,
  };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface SessionChatAdapterOptions {
  sessionId: string;
  pollIntervalMs?: number;
}

export function createSessionChatAdapter(options: SessionChatAdapterOptions): ChatChannelAdapter {
  const { sessionId } = options;
  let conversationId: string | null = null;

  return {
    mode: 'mail',
    pollIntervalMs: options.pollIntervalMs ?? 5000,

    isAvailable: async (_agentId: string) => {
      // Always available — conversation is created lazily on first send.
      // The chat input's enabled state is controlled by swarm connectivity,
      // not conversation existence.
      return true;
    },

    connect: async (_agentId: string) => {
      // Check if session already has a linked conversation
      try {
        const data = await apiFetch<{ conversation_id: string | null }>(
          `/sessions/${sessionId}/chat`,
        );
        conversationId = data.conversation_id;
      } catch {
        // Endpoint may not exist yet or session not found
        return [];
      }

      if (!conversationId) return [];

      // Fetch existing turns
      try {
        const data = await apiFetch<{ turns: MailTurn[] }>(
          `/mail/conversations/${conversationId}/turns`,
        );
        return (data.turns || []).map(mailTurnToChat);
      } catch {
        return [];
      }
    },

    send: async (_agentId: string, text: string) => {
      // POST to session chat endpoint — creates conversation lazily if needed
      const result = await apiFetch<{ ok: boolean; conversation_id: string }>(
        `/sessions/${sessionId}/chat`,
        {
          method: 'POST',
          body: JSON.stringify({ content: text }),
        },
      );
      // Cache the conversation ID for subsequent polls
      if (result.conversation_id) {
        conversationId = result.conversation_id;
      }
    },

    getMessages: async (_agentId: string) => {
      if (!conversationId) {
        // Try to resolve if it was created by another tab/session
        try {
          const data = await apiFetch<{ conversation_id: string | null }>(
            `/sessions/${sessionId}/chat`,
          );
          conversationId = data.conversation_id;
        } catch {
          return [];
        }
      }
      if (!conversationId) return [];

      try {
        const data = await apiFetch<{ turns: MailTurn[] }>(
          `/mail/conversations/${conversationId}/turns`,
        );
        return (data.turns || []).map(mailTurnToChat);
      } catch {
        return [];
      }
    },

    disconnect: () => {
      // No persistent connection to clean up
    },
  };
}
