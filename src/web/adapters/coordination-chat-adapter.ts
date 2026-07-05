/**
 * CoordinationChatAdapter — swarm-to-swarm coordination messaging.
 *
 * Implements the target-based ChatAdapter contract. Treats a target swarm as
 * an AgentTarget (agentId = targetSwarmId). Backed by /coordination/messages.
 *
 * Usage:
 *   const adapter = createCoordinationChatAdapter({ fromSwarmId });
 *   const channel = useChatChannel({
 *     target: { kind: 'agent', agentId: targetSwarmId },
 *     adapters: [adapter],
 *     resolveCapabilities: () => ({ available: true, connected: true, mail: { canJoin: true, canCreate: true } }),
 *   });
 */

import type { ChatAdapter, ChatMessage } from 'swarmcraft/ui/embed';
import type { SwarmMessage } from '../lib/api';
import { restBase, authHeaders } from '../lib/hub';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${restBase()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      (err as { error?: string }).error
        ?? (err as { message?: string }).message
        ?? `Request failed: ${res.status}`,
    );
  }
  return res.json();
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

function swarmMessageToChat(msg: SwarmMessage, viewerSwarmId: string): ChatMessage {
  const isInbound = msg.to_swarm_id === viewerSwarmId;
  return {
    id: msg.id,
    role: isInbound ? 'agent' : 'user',
    sender: isInbound ? msg.from_swarm_id : viewerSwarmId,
    senderName: isInbound ? msg.from_swarm_id : 'You',
    content: msg.content,
    contentType: msg.content_type === 'json' ? 'data' : 'text',
    rawContent: msg.content_type === 'json' ? tryParseJson(msg.content) : undefined,
    timestamp: new Date(msg.created_at).getTime(),
    inReplyTo: msg.reply_to ?? undefined,
  };
}

async function fetchRelevantMessages(
  fromSwarmId: string,
  targetSwarmId: string,
): Promise<ChatMessage[]> {
  const data = await apiFetch<{ data: SwarmMessage[]; total: number }>(
    `/coordination/messages?swarm_id=${encodeURIComponent(fromSwarmId)}&limit=50`,
  );
  const relevant = (data.data ?? []).filter((m) =>
    (m.from_swarm_id === fromSwarmId && m.to_swarm_id === targetSwarmId)
    || (m.from_swarm_id === targetSwarmId && m.to_swarm_id === fromSwarmId),
  );
  return relevant.map((m) => swarmMessageToChat(m, fromSwarmId));
}

export interface CoordinationChatAdapterOptions {
  /** The swarm sending messages (viewer perspective) */
  fromSwarmId: string;
  /** Poll interval in ms (default: 5000) */
  pollIntervalMs?: number;
}

export function createCoordinationChatAdapter(
  options: CoordinationChatAdapterOptions,
): ChatAdapter {
  const { fromSwarmId, pollIntervalMs = 5000 } = options;

  return {
    mode: 'mail',
    pollIntervalMs,

    canHandle: (target) => target.kind === 'agent',

    connect: async (target) => {
      if (target.kind !== 'agent') {
        throw new Error('CoordinationChatAdapter: expected AgentTarget');
      }
      const messages = await fetchRelevantMessages(fromSwarmId, target.agentId);
      return { messages };
    },

    send: async (target, text) => {
      if (target.kind !== 'agent') {
        throw new Error('CoordinationChatAdapter: expected AgentTarget');
      }
      await apiFetch('/coordination/messages', {
        method: 'POST',
        body: JSON.stringify({
          from_swarm_id: fromSwarmId,
          to_swarm_id: target.agentId,
          content_type: 'text',
          content: text,
        }),
      });
    },

    getMessages: async (target) => {
      if (target.kind !== 'agent') return [];
      return fetchRelevantMessages(fromSwarmId, target.agentId);
    },
  };
}
