/**
 * CustomEventBadges — Inline badges for non-noise custom events.
 * Renders aggregated counts for custom event types attached to display items.
 */

import type { SessionEvent } from '../../lib/api';
import { HIDDEN_CUSTOM_EVENTS } from './event-utils';

export function CustomEventBadges({ events }: { events?: SessionEvent[] }) {
  if (!events || events.length === 0) return null;

  const typeCounts = new Map<string, number>();
  for (const e of events) {
    const label = (e.eventType || e.type).replace(/^claude_/, '');
    if (HIDDEN_CUSTOM_EVENTS.has(label)) continue;
    const count = (e.data as Record<string, unknown>)?.count as number | undefined;
    typeCounts.set(label, (typeCounts.get(label) || 0) + (count && count > 1 ? count : 1));
  }

  if (typeCounts.size === 0) return null;

  return (
    <>
      {Array.from(typeCounts.entries()).map(([label, count]) => (
        <span
          key={label}
          className="text-2xs px-1.5 py-0.5 rounded"
          style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
        >
          {label}{count > 1 ? ` ×${count}` : ''}
        </span>
      ))}
    </>
  );
}
