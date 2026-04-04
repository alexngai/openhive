/**
 * MailChatAdapter
 *
 * A ChatChannelAdapter that bridges OpenHive's mail API (agent-inbox)
 * to the unified AgentChat component.
 *
 * Usage:
 *   import { createMailChatAdapter } from '../adapters/mail-chat-adapter';
 *
 *   // For a known conversation:
 *   const adapter = createMailChatAdapter({ conversationId: 'conv-123' });
 *
 *   // For an agent (finds their most recent conversation):
 *   const adapter = createMailChatAdapter();
 *
 *   <AgentChat agentId={agentId} channelConfig={{ adapters: [adapter] }} />
 */

import type { MailConversation, MailTurn, MessageContent } from '../lib/api';

// Import chat types via the swarmcraft embed alias
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

// ---------------------------------------------------------------------------
// Mail turn → ChatMessage normalization
// ---------------------------------------------------------------------------

function mailTurnToChat(turn: MailTurn): ChatMessage {
  const isEvent = turn.content_type === 'event';
  const isSupervisor = turn.participant_id?.includes('human') || turn.content_type === 'supervisor';

  let content = '';
  const mc = turn.content as MessageContent;
  if (mc && 'text' in mc && mc.text) {
    content = mc.text;
  } else if (typeof mc === 'string') {
    content = mc;
  } else {
    content = JSON.stringify(mc);
  }

  return {
    id: turn.id,
    role: isSupervisor ? 'supervisor' : 'agent',
    sender: turn.participant_id,
    senderName: turn.participant_id,
    content,
    contentType: isEvent ? 'event'
      : (mc as any)?.type === 'reference' ? 'reference'
      : (mc as any)?.type === 'data' ? 'data'
      : 'text',
    rawContent: mc,
    timestamp: new Date(turn.created_at).getTime(),
    threadId: turn.thread_id,
    inReplyTo: turn.in_reply_to,
  };
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface MailChatAdapterOptions {
  /** If known, the specific conversation ID to use */
  conversationId?: string;
  /** Poll interval in ms (default: 5000) */
  pollIntervalMs?: number;
}

export function createMailChatAdapter(options?: MailChatAdapterOptions): ChatChannelAdapter {
  let resolvedConvId: string | null = options?.conversationId ?? null;

  return {
    mode: 'mail',
    pollIntervalMs: options?.pollIntervalMs ?? 5000,

    isAvailable: async (agentId: string) => {
      // If we already have a conversationId, it's available
      if (resolvedConvId) return true;

      // Check if there are any mail conversations for this agent
      try {
        const data = await apiFetch<{ conversations: MailConversation[] }>('/mail/conversations');
        const match = data.conversations.find((c) =>
          c.participants.some((p) => p.agent_id === agentId)
        );
        if (match) {
          resolvedConvId = match.id;
          return true;
        }
      } catch {
        // Mail API unavailable
      }
      return false;
    },

    connect: async (agentId: string) => {
      // Resolve conversation ID if not already set
      if (!resolvedConvId) {
        const data = await apiFetch<{ conversations: MailConversation[] }>('/mail/conversations');
        const convs = data.conversations
          .filter((c) => c.participants.some((p) => p.agent_id === agentId))
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
        if (convs.length === 0) return [];
        resolvedConvId = convs[0].id;
      }

      const data = await apiFetch<{ turns: MailTurn[] }>(
        `/mail/conversations/${resolvedConvId}/turns`,
      );
      return (data.turns || []).map(mailTurnToChat);
    },

    send: async (_agentId: string, text: string) => {
      if (!resolvedConvId) throw new Error('No mail conversation');
      await apiFetch(`/mail/conversations/${resolvedConvId}/turns`, {
        method: 'POST',
        body: JSON.stringify({
          content: { type: 'text', text },
          content_type: 'text',
        }),
      });
    },

    getMessages: async (_agentId: string) => {
      if (!resolvedConvId) return [];
      const data = await apiFetch<{ turns: MailTurn[] }>(
        `/mail/conversations/${resolvedConvId}/turns`,
      );
      return (data.turns || []).map(mailTurnToChat);
    },

    disconnect: () => {
      // No persistent connection to clean up
    },
  };
}
