/**
 * session-events — Lossless converter between OpenHive SessionEvent[] and
 * swarmcraft ChatMessage[].
 *
 * OpenHive's trajectory API returns SessionEvent (a discriminated union over
 * user/assistant/tool/token/custom events). Swarmcraft's ChatMessageList
 * consumes ChatMessage, a unified shape extended with optional trajectory
 * fields (thinking, tokenUsage, stopReason, errorInfo, customEvents,
 * agentIdentity). This module maps between them.
 *
 * Pairing: `tool_call` + `tool_result` events with matching `toolCallId` are
 * merged into a single assistant ChatMessage carrying an ACPToolCall with
 * populated `output` + `status`. If no matching result is seen, the tool
 * call is emitted with `status: 'running'`.
 */

import type { SessionEvent, AgentIdentity as OpenHiveAgentIdentity } from '../api';
import type { ChatMessage } from 'swarmcraft/ui/embed';
import type { ACPToolCall } from 'swarmcraft/ui/embed';

function extractText(blocks: SessionEvent['content']): string {
  if (!blocks) return '';
  return blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
}

function epochMs(ts: string): number {
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : Date.now();
}

function toIdentity(a?: OpenHiveAgentIdentity): ChatMessage['agentIdentity'] {
  if (!a) return undefined;
  return {
    id: a.id || undefined,
    name: a.name || undefined,
    avatar: a.avatarUrl ?? undefined,
  };
}

function toolResultText(ev: SessionEvent): string {
  return extractText(ev.content);
}

function toolCallFromEvent(ev: SessionEvent, result?: SessionEvent): ACPToolCall {
  const id = ev.toolCallId ?? `tc-${ev.id}`;
  const name = ev.toolName ?? 'tool';
  return {
    id,
    name,
    input: (ev.input ?? {}) as Record<string, unknown>,
    output: result ? toolResultText(result) : undefined,
    status: result ? (result.isError ? 'error' : 'completed') : 'running',
  };
}

function toolCallsFromAssistantBlocks(ev: SessionEvent): ACPToolCall[] {
  const blocks = ev.content ?? [];
  return blocks
    .filter((b) => b.type === 'tool_call')
    .map<ACPToolCall>((b) => ({
      id: b.toolCallId ?? `tc-${ev.id}-${b.toolName ?? 'x'}`,
      name: b.toolName ?? 'tool',
      input: (b.input ?? {}) as Record<string, unknown>,
      output: b.output,
      status: b.status === 'failed' ? 'error'
        : b.status === 'completed' ? 'completed'
        : 'running',
    }));
}

export interface ConvertOptions {
  /** Identity of the session's primary assistant agent — used to decorate assistant messages. */
  assistantIdentity?: OpenHiveAgentIdentity;
}

/**
 * Convert a chronological SessionEvent array into a ChatMessage array.
 *
 * Input is expected in chronological order (oldest-first). The SessionEvent
 * stream from the OpenHive API is usually newest-first — callers should
 * reverse it before passing in.
 */
export function sessionEventsToChatMessages(
  events: SessionEvent[],
  options: ConvertOptions = {},
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // Index tool_result events by toolCallId so we can pair them with tool_call
  // events. We look back and forward; tool_result typically arrives after,
  // but the stream can be interleaved.
  const resultByCallId = new Map<string, SessionEvent>();
  for (const ev of events) {
    if (ev.type === 'tool_result' && ev.toolCallId) {
      resultByCallId.set(ev.toolCallId, ev);
    }
  }

  const identity = toIdentity(options.assistantIdentity);

  for (const ev of events) {
    switch (ev.type) {
      case 'user_message': {
        messages.push({
          id: ev.id,
          role: 'user',
          sender: 'user',
          content: extractText(ev.content),
          contentType: 'text',
          timestamp: epochMs(ev.timestamp),
          sequence: ev.sequence,
        });
        break;
      }

      case 'assistant_message': {
        const text = extractText(ev.content);
        const embeddedCalls = toolCallsFromAssistantBlocks(ev);
        // Enrich with results where available
        const enrichedCalls = embeddedCalls.map((c) => {
          if (c.output != null) return c;
          const match = resultByCallId.get(c.id);
          if (!match) return c;
          return {
            ...c,
            output: toolResultText(match),
            status: match.isError ? 'error' as const : 'completed' as const,
          };
        });
        messages.push({
          id: ev.id,
          role: 'assistant',
          sender: options.assistantIdentity?.id ?? 'assistant',
          senderName: options.assistantIdentity?.name,
          agentIdentity: identity,
          content: text,
          contentType: 'text',
          timestamp: epochMs(ev.timestamp),
          sequence: ev.sequence,
          stopReason: ev.stopReason,
          toolCalls: enrichedCalls.length > 0 ? enrichedCalls : undefined,
          isStreaming: (ev as { _isStreaming?: boolean })._isStreaming === true,
        });
        break;
      }

      case 'assistant_thinking': {
        messages.push({
          id: ev.id,
          role: 'assistant',
          sender: options.assistantIdentity?.id ?? 'assistant',
          senderName: options.assistantIdentity?.name,
          agentIdentity: identity,
          content: ev.thinking ?? '',
          contentType: 'thinking',
          thinking: ev.thinking,
          timestamp: epochMs(ev.timestamp),
          sequence: ev.sequence,
        });
        break;
      }

      case 'tool_call': {
        // Standalone tool_call (not embedded in an assistant_message).
        const result = ev.toolCallId ? resultByCallId.get(ev.toolCallId) : undefined;
        const tc = toolCallFromEvent(ev, result);
        messages.push({
          id: ev.id,
          role: 'assistant',
          sender: options.assistantIdentity?.id ?? 'assistant',
          senderName: options.assistantIdentity?.name,
          agentIdentity: identity,
          content: '',
          contentType: 'text',
          timestamp: epochMs(ev.timestamp),
          sequence: ev.sequence,
          toolCalls: [tc],
        });
        break;
      }

      case 'tool_result': {
        // Swallow — results are merged into their matching tool_call above.
        // If a tool_result arrives without a known tool_call, render as a
        // standalone custom event for visibility.
        if (!ev.toolCallId) {
          messages.push({
            id: ev.id,
            role: 'assistant',
            sender: options.assistantIdentity?.id ?? 'assistant',
            agentIdentity: identity,
            content: toolResultText(ev),
            contentType: 'text',
            timestamp: epochMs(ev.timestamp),
            sequence: ev.sequence,
          });
        }
        break;
      }

      case 'token_usage': {
        messages.push({
          id: ev.id,
          role: 'system',
          sender: 'system',
          content: '',
          contentType: 'token_usage',
          timestamp: epochMs(ev.timestamp),
          sequence: ev.sequence,
          tokenUsage: {
            input: ev.inputTokens,
            output: ev.outputTokens,
            cacheRead: ev.cacheReadTokens,
          },
        });
        break;
      }

      case 'error': {
        messages.push({
          id: ev.id,
          role: 'system',
          sender: 'system',
          content: ev.message ?? 'Unknown error',
          contentType: 'error',
          timestamp: epochMs(ev.timestamp),
          sequence: ev.sequence,
          errorInfo: { code: ev.code, message: ev.message },
        });
        break;
      }

      case 'custom':
      case 'checkpoint':
      case 'mode_change':
      case 'plan_update': {
        messages.push({
          id: ev.id,
          role: 'system',
          sender: 'system',
          content: ev.eventType ?? ev.type,
          contentType: 'custom',
          timestamp: epochMs(ev.timestamp),
          sequence: ev.sequence,
          customEvents: [{
            id: ev.id,
            eventType: ev.eventType ?? ev.type,
            timestamp: epochMs(ev.timestamp),
            data: ev.data,
          }],
        });
        break;
      }
    }
  }

  return messages;
}
