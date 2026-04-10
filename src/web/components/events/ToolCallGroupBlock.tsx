/**
 * ToolCallGroupBlock — Collapsible group for consecutive tool-use runs.
 *
 * When an agent makes multiple tool calls in sequence, they are grouped into
 * a single collapsible block showing the count and unique tool names.
 */

import { useState } from 'react';
import { Wrench, ChevronDown, ChevronRight } from 'lucide-react';
import type { SessionEvent, SessionContentBlock } from '../../lib/api';
import { EventBubble } from './EventBubble';
import { CustomEventBadges } from './CustomEventBadges';

export function ToolCallGroupBlock({ events, customEvents }: { events: SessionEvent[]; customEvents?: SessionEvent[] }) {
  const [expanded, setExpanded] = useState(false);

  // Collect all tool_call content blocks from assistant_message events,
  // plus standalone tool_call events as fallback
  const allToolCalls: SessionContentBlock[] = [];
  for (const event of events) {
    if (event.type === 'assistant_message') {
      const tcs = event.content?.filter((b) => b.type === 'tool_call') ?? [];
      allToolCalls.push(...tcs);
    } else if (event.type === 'tool_call') {
      allToolCalls.push(event as unknown as SessionContentBlock);
    }
  }

  const uniqueNames = [...new Set(
    allToolCalls.map((tc) => (tc as SessionContentBlock & { toolName?: string }).toolName).filter(Boolean),
  )];

  return (
    <div className="pl-[34px]">
      <button
        className="flex items-center gap-1.5 cursor-pointer w-full"
        onClick={() => setExpanded(!expanded)}
      >
        <Wrench className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-2xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          {allToolCalls.length} tool {allToolCalls.length === 1 ? 'call' : 'calls'}
        </span>
        <span className="flex flex-wrap gap-1 flex-1 min-w-0">
          {uniqueNames.map((name) => (
            <span
              key={name}
              className="text-2xs font-mono px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
            >
              {name}
            </span>
          ))}
          <CustomEventBadges events={customEvents} />
        </span>
        {expanded
          ? <ChevronDown className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          : <ChevronRight className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
        }
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {events.map((event) => (
            <EventBubble key={event.id} event={event} showHeader={false} />
          ))}
        </div>
      )}
    </div>
  );
}
