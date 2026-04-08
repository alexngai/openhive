/**
 * TaskFilterBar — Filter popover triggered by a filter icon.
 * Contains search, priority, assignee, sort controls.
 */

import { useState, useRef, useEffect } from 'react';
import { Filter, Search, X, ArrowUpDown } from 'lucide-react';

export interface TaskFilters {
  search: string;
  priorities: number[];
  assignee: string;
  sortBy: 'priority' | 'created_at' | 'updated_at' | 'title';
}

export const DEFAULT_FILTERS: TaskFilters = {
  search: '',
  priorities: [],
  assignee: '',
  sortBy: 'priority',
};

const PRIORITY_OPTIONS = [
  { value: 1, label: 'Low' },
  { value: 2, label: 'Medium' },
  { value: 3, label: 'High' },
  { value: 4, label: 'Critical' },
];

const SORT_OPTIONS = [
  { value: 'priority', label: 'Priority' },
  { value: 'created_at', label: 'Created' },
  { value: 'updated_at', label: 'Updated' },
  { value: 'title', label: 'Title' },
] as const;

export function hasActiveFilters(filters: TaskFilters): boolean {
  return filters.search !== '' || filters.priorities.length > 0 || filters.assignee !== '';
}

interface Props {
  filters: TaskFilters;
  onChange: (filters: TaskFilters) => void;
}

export function TaskFilterBar({ filters, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const active = hasActiveFilters(filters);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const activeCount = (filters.search ? 1 : 0) + (filters.priorities.length > 0 ? 1 : 0) + (filters.assignee ? 1 : 0);

  return (
    <div className="relative" ref={popoverRef}>
      {/* Filter trigger */}
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1 px-2 py-1 rounded-md transition-colors cursor-pointer ${
          active ? 'bg-honey-500/15 text-honey-500' : 'hover:bg-white/5'
        }`}
        style={!active ? { color: 'var(--color-text-muted)' } : {}}
        title="Filter tasks"
      >
        <Filter className="w-3.5 h-3.5" />
        {activeCount > 0 && (
          <span className="text-2xs">{activeCount}</span>
        )}
      </button>

      {/* Popover */}
      {open && (
        <div
          className="absolute top-full right-0 mt-1 w-72 rounded-lg shadow-xl border overflow-hidden z-50"
          style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        >
          {/* Search */}
          <div className="p-3 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
              <input
                type="text"
                value={filters.search}
                onChange={(e) => onChange({ ...filters, search: e.target.value })}
                placeholder="Search tasks..."
                className="input text-xs w-full pl-7 py-1.5"
                autoFocus
              />
              {filters.search && (
                <button
                  onClick={() => onChange({ ...filters, search: '' })}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-white/10"
                >
                  <X className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
                </button>
              )}
            </div>
          </div>

          <div className="p-3 space-y-3">
            {/* Priority */}
            <div>
              <label className="text-2xs font-medium block mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Priority</label>
              <div className="flex gap-1">
                {PRIORITY_OPTIONS.map((opt) => {
                  const isActive = filters.priorities.includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      onClick={() => {
                        const next = isActive
                          ? filters.priorities.filter((p) => p !== opt.value)
                          : [...filters.priorities, opt.value];
                        onChange({ ...filters, priorities: next });
                      }}
                      className={`text-2xs px-2 py-1 rounded transition-colors cursor-pointer ${
                        isActive ? 'bg-honey-500/15 text-honey-500' : 'hover:bg-white/5'
                      }`}
                      style={!isActive ? { color: 'var(--color-text-muted)' } : {}}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Assignee */}
            <div>
              <label className="text-2xs font-medium block mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Assignee</label>
              <input
                type="text"
                value={filters.assignee}
                onChange={(e) => onChange({ ...filters, assignee: e.target.value })}
                placeholder="Filter by assignee"
                className="input text-xs w-full py-1.5"
              />
            </div>

            {/* Sort */}
            <div>
              <label className="text-2xs font-medium block mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Sort by</label>
              <select
                value={filters.sortBy}
                onChange={(e) => onChange({ ...filters, sortBy: e.target.value as TaskFilters['sortBy'] })}
                className="input text-xs w-full py-1.5"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Footer */}
          {active && (
            <div className="p-2 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
              <button
                onClick={() => { onChange(DEFAULT_FILTERS); setOpen(false); }}
                className="text-2xs hover:underline w-full text-center cursor-pointer"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Apply filters to a list of task nodes */
export function applyTaskFilters(
  nodes: Array<Record<string, unknown>>,
  filters: TaskFilters,
): Array<Record<string, unknown>> {
  let result = nodes;

  if (filters.search) {
    const q = filters.search.toLowerCase();
    result = result.filter((n) => {
      const title = ((n.title as string) || '').toLowerCase();
      const desc = ((n.description as string) || '').toLowerCase();
      return title.includes(q) || desc.includes(q);
    });
  }

  if (filters.priorities.length > 0) {
    result = result.filter((n) => filters.priorities.includes((n.priority as number) ?? 0));
  }

  if (filters.assignee) {
    const q = filters.assignee.toLowerCase();
    result = result.filter((n) => {
      const assignee = ((n.assignee as string) || '').toLowerCase();
      return assignee.includes(q);
    });
  }

  result = [...result].sort((a, b) => {
    switch (filters.sortBy) {
      case 'priority':
        return ((b.priority as number) ?? 0) - ((a.priority as number) ?? 0);
      case 'title':
        return ((a.title as string) || '').localeCompare((b.title as string) || '');
      case 'created_at':
        return ((b.created_at as string) || '').localeCompare((a.created_at as string) || '');
      case 'updated_at':
        return ((b.updated_at as string) || '').localeCompare((a.updated_at as string) || '');
      default:
        return 0;
    }
  });

  return result;
}
