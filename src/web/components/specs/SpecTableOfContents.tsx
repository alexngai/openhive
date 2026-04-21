import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Minus, Plus, ChevronLeft } from 'lucide-react';
import type { TocItem } from './TiptapSpecEditor';

const TOC_EXPANDED_STORAGE_KEY = 'openhive:specs:tocExpanded';

interface SpecTableOfContentsProps {
  items: TocItem[];
  onItemClick: (id: string) => void;
  onCollapse?: () => void;
  className?: string;
}

/**
 * Table of contents panel for specs. Shows the heading outline, supports
 * "top levels only" vs "all levels" collapse, and highlights the
 * heading currently in view. Persisted expand/collapse preference.
 */
export function SpecTableOfContents({
  items,
  onItemClick,
  onCollapse,
  className = '',
}: SpecTableOfContentsProps) {
  const [isExpanded, setIsExpanded] = useState(() => {
    const stored = localStorage.getItem(TOC_EXPANDED_STORAGE_KEY);
    return stored !== null ? JSON.parse(stored) : true;
  });

  useEffect(() => {
    localStorage.setItem(TOC_EXPANDED_STORAGE_KEY, JSON.stringify(isExpanded));
  }, [isExpanded]);

  // Show all levels when expanded; top two (h1, h2) when collapsed.
  const visible = isExpanded ? items : items.filter((i) => i.level <= 2);

  // When collapsed and the active item is hidden, show the nearest visible
  // ancestor as active so the user still sees where they are.
  const activeId = (() => {
    const active = items.find((i) => i.isActive);
    if (!active) return null;
    if (isExpanded || active.level <= 2) return active.id;
    const idx = items.indexOf(active);
    for (let i = idx - 1; i >= 0; i--) {
      if (items[i].level <= 2) return items[i].id;
    }
    return null;
  })();

  return (
    <div className={clsx('flex h-full flex-col', className)}>
      <div
        className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-3 py-2"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <h3
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--color-text-muted)' }}
        >
          Contents
        </h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="rounded p-1 hover:bg-white/5"
            style={{ color: 'var(--color-text-muted)' }}
            title={isExpanded ? 'Top levels only' : 'Expand all'}
          >
            {isExpanded ? <Minus className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          </button>
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="rounded p-1 hover:bg-white/5"
              style={{ color: 'var(--color-text-muted)' }}
              title="Hide table of contents"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="px-3 py-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          No headings yet. Add <code className="font-mono">##</code> headings as you write.
        </p>
      ) : (
        <nav className="flex-1 overflow-y-auto px-2 py-2">
          {visible.map((item) => {
            const indent = (item.level - 1) * 10;
            const isActive = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onItemClick(item.id)}
                className={clsx(
                  'block w-full truncate rounded px-2 py-1 text-left text-xs transition-colors',
                  isActive
                    ? 'bg-white/10 font-medium'
                    : 'hover:bg-white/5',
                )}
                style={{
                  paddingLeft: `${8 + indent}px`,
                  color: isActive
                    ? 'var(--color-text)'
                    : item.isScrolledOver
                      ? 'var(--color-text-muted)'
                      : 'var(--color-text-secondary)',
                }}
              >
                {item.textContent || '(empty heading)'}
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
