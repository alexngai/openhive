/**
 * EventStream — Reusable event stream container.
 *
 * Accepts a flat array of SessionEvents (any source — trajectory, chat, merged),
 * applies the grouping pipeline, renders with auto-scroll and pagination.
 *
 * The `children` slot renders after the event list (before the scroll anchor),
 * intended for chat input or other interactive elements.
 */

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { ArrowDown, MessageSquare } from 'lucide-react';
import type { SessionEvent, AgentIdentity } from '../../lib/api';
import { groupEventsForDisplay, getEventAuthor } from './event-utils';
import type { DisplayItem } from './event-utils';
import { EventBubble } from './EventBubble';
import { ToolCallGroupBlock } from './ToolCallGroupBlock';
import { LoadingSpinner } from '../common/LoadingSpinner';

export interface EventStreamProps {
  /** Flat event array in API order (newest-first). Reversed internally to chronological. */
  events: SessionEvent[];
  agentIdentity?: AgentIdentity;

  // Pagination
  isLoading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  total?: number;
  formatId?: string;

  // Empty/error states
  emptyMessage?: string;
  emptyIcon?: React.ComponentType<{ className?: string }>;

  /** Content rendered after the event stream (e.g. chat input). */
  children?: React.ReactNode;

  className?: string;
}

export function EventStream({
  events,
  agentIdentity,
  isLoading,
  hasMore,
  onLoadMore,
  isLoadingMore,
  total,
  formatId,
  emptyMessage = 'No events found.',
  emptyIcon: EmptyIcon = MessageSquare,
  children,
  className,
}: EventStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Track whether the bottom anchor is visible
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setIsAtBottom(entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // Auto-scroll to bottom on initial load
  useEffect(() => {
    if (events.length > 0 && !hasScrolledRef.current) {
      hasScrolledRef.current = true;
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'instant' });
      });
    }
  }, [events.length]);

  // Events come newest-first from API; reverse for chronological display
  const chronologicalEvents = useMemo(() => [...events].reverse(), [events]);

  // Group tool runs and attach custom events
  const displayEvents = useMemo(
    () => groupEventsForDisplay(chronologicalEvents),
    [chronologicalEvents],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="card px-6 py-8 text-center" style={{ color: 'var(--color-text-muted)' }}>
        <EmptyIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
        <p className="text-xs">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-medium flex items-center gap-1.5">
          <MessageSquare className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          Agent Trajectory
          {total != null && total > 0 && (
            <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>
              ({total} events)
            </span>
          )}
        </h2>
        {formatId && (
          <span
            className="text-2xs px-1.5 py-0.5 rounded"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
          >
            {formatId}
          </span>
        )}
      </div>

      {/* Load more button for older events */}
      {isLoadingMore && (
        <div className="flex items-center justify-center py-3">
          <LoadingSpinner />
          <span className="ml-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            Loading older events…
          </span>
        </div>
      )}
      {hasMore && !isLoadingMore && onLoadMore && (
        <div className="text-center py-2">
          <button
            onClick={onLoadMore}
            className="text-2xs px-3 py-1 rounded transition-colors"
            style={{
              color: 'var(--color-accent)',
              backgroundColor: 'var(--color-elevated)',
              border: '1px solid var(--color-border)',
            }}
          >
            Load older events ({events.length} of {total})
          </button>
        </div>
      )}
      {!hasMore && total != null && total > events.length && (
        <div className="text-center py-2">
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            All {total} events loaded
          </span>
        </div>
      )}

      {/* Event list */}
      <div className="space-y-3">
        {renderDisplayItems(displayEvents, agentIdentity)}
      </div>

      {/* Slot for chat input or other controls */}
      {children}

      {/* Scroll anchor */}
      <div ref={bottomRef} />

      {/* Scroll-to-bottom FAB */}
      {!isAtBottom && (
        <button
          onClick={scrollToBottom}
          className="fixed bottom-6 right-6 z-20 w-8 h-8 rounded-full flex items-center justify-center shadow transition-all hover:brightness-125 cursor-pointer border"
          style={{
            backgroundColor: 'var(--color-elevated)',
            color: 'var(--color-text-muted)',
            borderColor: 'var(--color-border-subtle)',
          }}
          title="Scroll to bottom"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

// ── Render helpers ─────────────────────────────────────────────────────────

function renderDisplayItems(displayEvents: DisplayItem[], agentIdentity?: AgentIdentity) {
  let lastAuthor: string | null = null;

  return displayEvents.map((item, i) => {
    // Tool call groups
    if ('_toolGroup' in item) {
      const showHeader = lastAuthor !== 'assistant';
      lastAuthor = 'assistant';
      return (
        <div key={`tg-${i}`} className={showHeader ? '' : '-mt-1.5'}>
          <ToolCallGroupBlock events={item.events} customEvents={item._customEvents} />
        </div>
      );
    }

    const event = item as SessionEvent & { _customEvents?: SessionEvent[] };
    const author = getEventAuthor(event);
    // System events (token_usage, error) don't reset author grouping
    if (author === null) {
      return <EventBubble key={event.id} event={event} agentIdentity={agentIdentity} customEvents={event._customEvents} />;
    }
    const showHeader = author !== lastAuthor;
    lastAuthor = author;
    return (
      <div key={event.id} className={showHeader ? '' : '-mt-1.5'}>
        <EventBubble event={event} showHeader={showHeader} agentIdentity={agentIdentity} customEvents={event._customEvents} />
      </div>
    );
  });
}
