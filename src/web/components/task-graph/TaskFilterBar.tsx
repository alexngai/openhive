/**
 * TaskFilterBar — Horizontal filter bar for task views.
 * Client-side filtering: search, priority, assignee, sort.
 */

import { Search, X, ArrowUpDown } from 'lucide-react';

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
  const active = hasActiveFilters(filters);

  return (
    <div
      className="flex items-center gap-2 px-4 py-1.5 border-b shrink-0"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)' }}
    >
      {/* Search */}
      <div className="relative flex-1 max-w-xs">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        <input
          type="text"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          placeholder="Search tasks..."
          className="input text-2xs w-full pl-7 py-1"
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

      {/* Priority filter */}
      <div className="flex items-center gap-1">
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
              className={`text-2xs px-1.5 py-0.5 rounded transition-colors ${
                isActive ? 'bg-honey-500/15 text-honey-500' : 'hover:bg-white/5'
              }`}
              style={!isActive ? { color: 'var(--color-text-muted)' } : {}}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Assignee filter */}
      <input
        type="text"
        value={filters.assignee}
        onChange={(e) => onChange({ ...filters, assignee: e.target.value })}
        placeholder="Assignee"
        className="input text-2xs py-1 w-24"
      />

      {/* Sort */}
      <div className="flex items-center gap-1">
        <ArrowUpDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        <select
          value={filters.sortBy}
          onChange={(e) => onChange({ ...filters, sortBy: e.target.value as TaskFilters['sortBy'] })}
          className="input text-2xs py-1 px-1.5"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Clear */}
      {active && (
        <button
          onClick={() => onChange(DEFAULT_FILTERS)}
          className="text-2xs hover:underline"
          style={{ color: 'var(--color-text-muted)' }}
        >
          Clear
        </button>
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

  // Search (title + description, case-insensitive)
  if (filters.search) {
    const q = filters.search.toLowerCase();
    result = result.filter((n) => {
      const title = ((n.title as string) || '').toLowerCase();
      const desc = ((n.description as string) || '').toLowerCase();
      return title.includes(q) || desc.includes(q);
    });
  }

  // Priority filter
  if (filters.priorities.length > 0) {
    result = result.filter((n) => filters.priorities.includes((n.priority as number) ?? 0));
  }

  // Assignee filter
  if (filters.assignee) {
    const q = filters.assignee.toLowerCase();
    result = result.filter((n) => {
      const assignee = ((n.assignee as string) || '').toLowerCase();
      return assignee.includes(q);
    });
  }

  // Sort
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
