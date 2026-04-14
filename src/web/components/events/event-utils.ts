/**
 * event-utils — Pure utility functions for event stream rendering.
 *
 * Handles event grouping (tool call runs, custom event badges),
 * author detection, and helper formatters. No React dependencies.
 */

import type { SessionEvent, SessionContentBlock } from '../../lib/api';
import type { ChatMessage } from 'swarmcraft/ui/embed';

// ── Types ──────────────────────────────────────────────────────────────────

export type ToolGroup = { _toolGroup: true; events: SessionEvent[] };
export type DisplayItem = (SessionEvent | ToolGroup) & { _customEvents?: SessionEvent[] };

// ── ChatMessage → SessionEvent conversion ──────────────────────────────────

/**
 * Convert a ChatMessage (from useChatChannel) into a SessionEvent so it can
 * be merged into the trajectory EventStream.
 *
 * Skipped contentTypes:
 *   - 'event' — tool calls / tool results; trajectory checkpoints render
 *     these with full input/output metadata, double-rendering would be worse.
 *   - 'data' / 'reference' — structured payloads that don't have a natural
 *     plain-text rendering in the trajectory view. The raw ChatMessage is
 *     still visible in non-trajectory surfaces (ChatMessageList); skipping
 *     here avoids dumping JSON into the assistant/user bubble pipeline.
 */
export function chatMessageToSessionEvent(m: ChatMessage, index: number): SessionEvent | null {
  if (m.contentType !== 'text') return null;
  const role = m.role === 'user' || m.role === 'supervisor' ? 'user_message' : 'assistant_message';
  return {
    id: `chat-${m.id}`,
    timestamp: new Date(m.timestamp).toISOString(),
    sequence: index,
    type: role as SessionEvent['type'],
    content: [{ type: 'text', text: m.content }],
    ...(m.isStreaming ? { _isStreaming: true } : {}),
  } as SessionEvent;
}

export function chatMessagesToSessionEvents(messages: ChatMessage[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (let i = 0; i < messages.length; i++) {
    const ev = chatMessageToSessionEvent(messages[i], i);
    if (ev) out.push(ev);
  }
  return out;
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function extractText(blocks: SessionContentBlock[] | undefined): string {
  if (!blocks) return '';
  return blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
}

/**
 * 32-bit FNV-1a hash — deterministic, fast, no crypto import. Good enough to
 * avoid false-positive dedupe collisions from agents that share boilerplate
 * prefaces across turns.
 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Deduplicate ACP streaming events against trajectory checkpoint events.
 * Fingerprint uses type + full-content hash (not just prefix) so two
 * assistant messages that start with the same boilerplate but diverge later
 * are correctly treated as distinct events.
 */
export function deduplicateStreamingEvents(
  streamingEvents: SessionEvent[],
  trajectoryEvents: SessionEvent[],
): SessionEvent[] {
  if (streamingEvents.length === 0) return [];
  if (trajectoryEvents.length === 0) return streamingEvents;

  const fingerprint = (e: SessionEvent) => {
    const text = e.content?.[0]?.text ?? '';
    return `${e.type}:${fnv1a(text)}`;
  };

  const trajectoryFingerprints = new Set<string>();
  for (const e of trajectoryEvents) trajectoryFingerprints.add(fingerprint(e));

  return streamingEvents.filter((e) => !trajectoryFingerprints.has(fingerprint(e)));
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

/** Determine the "author" for grouping consecutive events. */
export function getEventAuthor(event: SessionEvent): 'user' | 'assistant' | null {
  switch (event.type) {
    case 'user_message': return 'user';
    case 'assistant_message':
    case 'assistant_thinking':
    case 'tool_call':
    case 'tool_result': return 'assistant';
    default: return null; // system-level events don't group
  }
}

/** Check if an assistant_message is tool-use-only (has tool_call blocks, no meaningful text). */
export function isToolUseOnlyMessage(event: SessionEvent): boolean {
  if (event.type !== 'assistant_message') return false;
  const toolCalls = event.content?.filter((b) => b.type === 'tool_call') ?? [];
  if (toolCalls.length === 0) return false;
  const text = extractText(event.content);
  return !text || text.trim().length === 0;
}

/** Identifies events that belong to a tool run (consecutive groupable block). */
export function isToolRunEvent(event: SessionEvent): boolean {
  return (
    isToolUseOnlyMessage(event) ||
    event.type === 'tool_call' ||
    event.type === 'tool_result' ||
    event.type === 'assistant_thinking' ||
    event.type === 'custom'
  );
}

/** Count total tool_call blocks in a run of events. */
export function countToolCalls(run: SessionEvent[]): number {
  let count = 0;
  for (const e of run) {
    if (e.type === 'assistant_message') {
      count += (e.content?.filter((b) => b.type === 'tool_call') ?? []).length;
    } else if (e.type === 'tool_call') {
      count += 1;
    }
  }
  return count;
}

// ── Custom event filtering ─────────────────────────────────────────────────

/** Custom event types that are hidden from inline badges (noise). */
export const HIDDEN_CUSTOM_EVENTS = new Set(['system', 'file-history-snapshot', 'login', 'init']);

// ── Grouping pipeline ──────────────────────────────────────────────────────

/**
 * Group a chronological event array into DisplayItems for rendering.
 *
 * - Consecutive tool-use runs (tool-only assistant messages, tool_call, tool_result,
 *   thinking, custom) are grouped into collapsible ToolGroups when they contain >1
 *   tool calls.
 * - Custom events are collected and attached as `_customEvents` on the next
 *   non-custom display item so they render as inline badges.
 */
export function groupEventsForDisplay(chronologicalEvents: SessionEvent[]): DisplayItem[] {
  const displayEvents: DisplayItem[] = [];

  let toolRun: SessionEvent[] = [];
  let pendingCustom: SessionEvent[] = [];

  const attachPending = (item: DisplayItem) => {
    if (pendingCustom.length > 0) {
      item._customEvents = pendingCustom;
      pendingCustom = [];
    }
    displayEvents.push(item);
  };

  const flushToolRun = () => {
    if (toolRun.length === 0) return;
    if (countToolCalls(toolRun) > 1) {
      attachPending({ _toolGroup: true, events: toolRun } as ToolGroup & { _customEvents?: SessionEvent[] });
    } else {
      for (const e of toolRun) {
        if (e.type === 'custom') {
          pendingCustom.push(e);
        } else {
          attachPending(e);
        }
      }
    }
    toolRun = [];
  };

  for (const event of chronologicalEvents) {
    if (toolRun.length > 0 && isToolRunEvent(event)) {
      toolRun.push(event);
    } else if (isToolUseOnlyMessage(event) || event.type === 'tool_call') {
      toolRun.push(event);
    } else if (event.type === 'custom') {
      pendingCustom.push(event);
    } else {
      flushToolRun();
      attachPending(event);
    }
  }
  flushToolRun();

  // Any trailing custom events attach to last item
  if (pendingCustom.length > 0 && displayEvents.length > 0) {
    const last = displayEvents[displayEvents.length - 1];
    last._customEvents = [...(last._customEvents || []), ...pendingCustom];
  }

  return displayEvents;
}

/**
 * Group consecutive custom events into arrays for inline badge rendering.
 * (Preserved for backward compatibility with old EventBubble consumers.)
 */
export function groupConsecutiveCustomEvents(events: SessionEvent[]): (SessionEvent | SessionEvent[])[] {
  const result: (SessionEvent | SessionEvent[])[] = [];
  let currentGroup: SessionEvent[] = [];

  for (const event of events) {
    if (event.type === 'custom' || event.type === 'checkpoint' || event.type === 'mode_change' || event.type === 'plan_update') {
      currentGroup.push(event);
    } else {
      if (currentGroup.length > 0) {
        result.push(currentGroup.length === 1 ? currentGroup[0] : currentGroup);
        currentGroup = [];
      }
      result.push(event);
    }
  }
  if (currentGroup.length > 0) {
    result.push(currentGroup.length === 1 ? currentGroup[0] : currentGroup);
  }

  return result;
}
