/**
 * CoordinationChatAdapter
 *
 * A ChatChannelAdapter for swarm-to-swarm coordination messaging.
 * Wraps the OpenHive /coordination/messages API.
 *
 * Usage:
 *   import { createCoordinationChatAdapter } from '../adapters/coordination-chat-adapter';
 *
 *   const adapter = createCoordinationChatAdapter({ fromSwarmId: 'my-swarm' });
 *   <AgentChat agentId={targetSwarmId} channelConfig={{ adapters: [adapter] }} />
 */

import type { SwarmMessage } from '../lib/api';

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
// SwarmMessage → ChatMessage normalization
// ---------------------------------------------------------------------------

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

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface CoordinationChatAdapterOptions {
  /** The swarm sending messages (viewer perspective) */
  fromSwarmId: string;
  /** Poll interval in ms (default: 5000) */
  pollIntervalMs?: number;
}

export function createCoordinationChatAdapter(
  options: CoordinationChatAdapterOptions,
): ChatChannelAdapter {
  const { fromSwarmId, pollIntervalMs = 5000 } = options;

  return {
    mode: 'mail', // bidirectional async messaging (send + receive)
    pollIntervalMs,

    isAvailable: async (_targetSwarmId: string) => {
      // Coordination is always available between swarms
      return true;
    },

    connect: async (targetSwarmId: string) => {
      // Fetch messages between the two swarms
      const data = await apiFetch<{ data: SwarmMessage[]; total: number }>(
        `/coordination/messages?swarm_id=${fromSwarmId}&limit=50`,
      );
      // Filter to messages between these two specific swarms
      const relevant = (data.data || []).filter(
        (m) =>
          (m.from_swarm_id === fromSwarmId && m.to_swarm_id === targetSwarmId) ||
          (m.from_swarm_id === targetSwarmId && m.to_swarm_id === fromSwarmId),
      );
      return relevant.map((m) => swarmMessageToChat(m, fromSwarmId));
    },

    send: async (targetSwarmId: string, text: string) => {
      await apiFetch('/coordination/messages', {
        method: 'POST',
        body: JSON.stringify({
          from_swarm_id: fromSwarmId,
          to_swarm_id: targetSwarmId,
          content_type: 'text',
          content: text,
        }),
      });
    },

    getMessages: async (targetSwarmId: string) => {
      const data = await apiFetch<{ data: SwarmMessage[]; total: number }>(
        `/coordination/messages?swarm_id=${fromSwarmId}&limit=50`,
      );
      const relevant = (data.data || []).filter(
        (m) =>
          (m.from_swarm_id === fromSwarmId && m.to_swarm_id === targetSwarmId) ||
          (m.from_swarm_id === targetSwarmId && m.to_swarm_id === fromSwarmId),
      );
      return relevant.map((m) => swarmMessageToChat(m, fromSwarmId));
    },

    disconnect: () => {},
  };
}
