/**
 * Context Formatter — converts context items into markdown chat messages.
 *
 * The registry (`context-registry.ts`) is the authoritative formatter for
 * every type used by the app. This module wraps the registry's output with
 * a human-readable one-liner prefix (`📄 **Shared context — …**`) so chat
 * history is readable without unwrapping the fenced block.
 *
 * The legacy per-type switch was removed in step 9 once every consumer
 * type was registered. A `safeHarborFormat()` remains for the (unreachable
 * under normal operation) case where a runtime item refers to a type the
 * registry doesn't know — it dumps `item.data` as key-value pairs so the
 * agent at least sees the payload rather than an empty body.
 */

import type { ChatFabContextItem } from './chat-fab-item';
import { getContextType } from './context-registry';

const TYPE_EMOJI: Record<string, string> = {
  spec: '📄',
  tasks: '📋',
  dispatch: '🚀',
  swarm: '⚡',
  session: '💬',
  task: '☑️',
  context: '📎',
  custom: '📎',
};

function safeHarborFormat(item: ChatFabContextItem): string {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(item.data)) {
    if (val !== null && val !== undefined) {
      lines.push(
        `- **${key}**: ${typeof val === 'string' ? val : JSON.stringify(val)}`,
      );
    }
  }
  return lines.length > 0 ? lines.join('\n') : '_no payload_';
}

export function formatContextItem(
  item: ChatFabContextItem,
  flags?: { stale?: boolean },
): string {
  const emoji = TYPE_EMOJI[item.type] ?? '📎';
  const prefix = `${emoji} **Shared context — ${item.label}**`;

  const spec = getContextType(item.type);
  const body = spec ? spec.format(item.data, flags) : safeHarborFormat(item);

  return `${prefix}\n\n${body}`;
}
