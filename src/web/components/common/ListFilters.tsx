/**
 * ListFilters — shared toolbar for list pages (Memory, Skills, Specs,
 * Dispatches).
 *
 * Purpose: give every list page the same search affordance + result count
 * without forcing a rigid layout. Page-specific controls (status chips,
 * archived toggle, swarm dropdown) slot into `right` so pages keep their
 * specific semantics but share the search UX.
 *
 * Search is debounced in the parent via `useDebouncedValue` (below) — this
 * component stays pure so it can be tested without fake timers.
 */

import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';

export interface ListFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  /** Placeholder copy for the search input. Defaults to "Search…" */
  placeholder?: string;
  /** Auto-focus the input on mount. Default: false. */
  autoFocus?: boolean;
  /** Visible / total counts shown alongside the search. Omit to hide. */
  count?: { visible: number; total: number; noun?: string };
  /** Page-specific controls rendered on the right side of the toolbar
   *  (status chips, filter toggles, action buttons, etc.). */
  right?: React.ReactNode;
  /** Optional id for testing. */
  inputId?: string;
}

export function ListFilters({
  search,
  onSearchChange,
  placeholder = 'Search…',
  autoFocus = false,
  count,
  right,
  inputId,
}: ListFiltersProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const showClear = search.length > 0;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 rounded-md border min-w-[220px] flex-1 max-w-md"
        style={{
          borderColor: 'var(--color-border-subtle)',
          backgroundColor: 'var(--color-surface)',
        }}
      >
        <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
        <input
          id={inputId}
          ref={inputRef}
          type="search"
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus={autoFocus}
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm outline-none"
          style={{ color: 'var(--color-text)' }}
        />
        {showClear && (
          <button
            type="button"
            onClick={() => {
              onSearchChange('');
              inputRef.current?.focus();
            }}
            className="shrink-0 opacity-70 hover:opacity-100"
            style={{ color: 'var(--color-text-muted)' }}
            title="Clear"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {count && (
        <span className="text-xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
          {count.visible === count.total
            ? `${count.total} ${count.noun ?? 'item'}${count.total !== 1 ? 's' : ''}`
            : `${count.visible} of ${count.total}`}
        </span>
      )}

      {right && <div className="flex items-center gap-2 ml-auto flex-wrap">{right}</div>}
    </div>
  );
}

/**
 * Debounce hook for search inputs. Avoids filtering on every keystroke
 * and makes page-level filter logic identical across the four list pages.
 */
export function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Case-insensitive substring match across a set of fields. Used by pages
 * doing client-side text filtering. Returns true when `q` is empty so
 * callers can spread it into a `.filter()` call without a separate guard.
 */
export function matchesSearch(q: string, ...fields: Array<string | null | undefined>): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  for (const f of fields) {
    if (f && f.toLowerCase().includes(needle)) return true;
  }
  return false;
}
