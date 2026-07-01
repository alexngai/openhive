import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, Folder, FolderGit2, Search, X, Zap, History } from 'lucide-react';
import {
  useKnownProjectPathEntries,
  type KnownProjectPathEntry,
  type KnownProjectPathSource,
} from '../../hooks/useApi';

/**
 * Free-form working-directory picker for the Spawn Swarm dialog. Models
 * the same UX as `AssigneeCombobox`: a button-shaped trigger with a
 * dropdown listing known suggestions filtered by a search input, and
 * support for free-form text entry for any path not in the suggestion
 * list.
 *
 * Suggestions are grouped by source (recent hosted spawns / registered
 * swarms / repo resources). The disabled state mirrors the schema's
 * `cwd + repo_id` exclusivity — when a repo resource is picked, the
 * combobox shows a non-interactive hint instead of letting the user
 * type a value the backend would reject.
 */

interface WorkingDirectoryComboboxProps {
  /** Current value (empty string = not set). */
  value: string;
  /** Emit the new value (empty string clears). */
  onChange: (next: string) => void;
  /** True when a repo resource is selected — the field is informational only. */
  disabled?: boolean;
  /** Optional helper line rendered when disabled (e.g. the resolved repo path). */
  disabledHint?: string;
  /** Placeholder when the field is empty. */
  placeholder?: string;
}

// Section headers + icons keyed by source. Ordering here matches the
// rendering order in the dropdown so "recent" entries surface first.
const SECTIONS: Array<{
  source: KnownProjectPathSource;
  label: string;
  Icon: typeof Folder;
}> = [
  { source: 'hosted-tui',        label: 'Recent (Claude Code / Codex)', Icon: History },
  { source: 'hosted-bootstrap',  label: 'Recent (SwarmRunner)',           Icon: History },
  { source: 'registered-swarm',  label: 'Registered swarms',            Icon: Zap },
  { source: 'repo',              label: 'Registered repos',             Icon: FolderGit2 },
];

export function WorkingDirectoryCombobox({
  value,
  onChange,
  disabled,
  disabledHint,
  placeholder = '/absolute/path/to/your/project',
}: WorkingDirectoryComboboxProps) {
  const { data: entries } = useKnownProjectPathEntries();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click. Same pattern as AssigneeCombobox.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Focus the search input on open so the user can type immediately.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

  // Build the grouped + filtered suggestion list. `query` filters across
  // both path and label so typing a repo name surfaces its local_path.
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const buckets = new Map<KnownProjectPathSource, KnownProjectPathEntry[]>();
    for (const e of entries ?? []) {
      if (q) {
        const hay = `${e.path}\n${e.label ?? ''}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const bucket = buckets.get(e.source) ?? [];
      bucket.push(e);
      buckets.set(e.source, bucket);
    }
    return SECTIONS.map((s) => ({ ...s, items: buckets.get(s.source) ?? [] })).filter(
      (s) => s.items.length > 0,
    );
  }, [entries, query]);

  const totalMatches = grouped.reduce((sum, s) => sum + s.items.length, 0);

  // Free-form: when the user types a path that doesn't exactly match any
  // suggestion, offer to commit it as-is. The backend validates absolute
  // path + exists; we surface a hint here for absolute-path shape only.
  const trimmedQuery = query.trim();
  const exactMatchExists = (entries ?? []).some((e) => e.path === trimmedQuery);
  const canCommitFreeform = trimmedQuery.length > 0 && !exactMatchExists;

  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery('');
  };

  const clear = () => {
    onChange('');
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={rootRef} className="relative w-full">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          'input w-full flex items-center gap-2 text-left transition-colors',
          disabled && 'opacity-60 cursor-not-allowed',
          !disabled && 'cursor-pointer',
        )}
      >
        <Folder
          className="w-3.5 h-3.5 shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
        />
        <span className="flex-1 min-w-0 truncate font-mono text-2xs">
          {value ? (
            <span style={{ color: 'var(--color-text)' }}>{value}</span>
          ) : (
            <span style={{ color: 'var(--color-text-muted)' }}>
              {disabled && disabledHint ? disabledHint : placeholder}
            </span>
          )}
        </span>
        {value && !disabled && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            className="shrink-0 p-0.5 rounded hover:bg-hover"
            aria-label="Clear working directory"
          >
            <X className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
          </button>
        )}
        <ChevronDown
          className={clsx('w-3 h-3 shrink-0 transition-transform', open && 'rotate-180')}
          style={{ color: 'var(--color-text-muted)' }}
        />
      </button>

      {open && !disabled && (
        <div
          className="absolute left-0 right-0 top-full mt-1 rounded-lg border shadow-lg z-20 overflow-hidden"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
          }}
        >
          {/* Search / freeform input. Enter commits the typed text as-is,
              letting operators pick a path that isn't in the suggestion list. */}
          <div
            className="flex items-center gap-1.5 p-1.5 border-b"
            style={{ borderColor: 'var(--color-border-subtle)' }}
          >
            <Search
              className="w-3 h-3 shrink-0"
              style={{ color: 'var(--color-text-muted)' }}
            />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter' && canCommitFreeform) {
                  e.preventDefault();
                  commit(trimmedQuery);
                }
              }}
              placeholder="Type to search or enter a new path…"
              className="text-xs bg-transparent outline-none flex-1 font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </div>

          <div className="max-h-64 overflow-y-auto py-1">
            {totalMatches === 0 && !canCommitFreeform && (
              <div
                className="px-3 py-2 text-2xs"
                style={{ color: 'var(--color-text-muted)' }}
              >
                No known directories yet. Type a path and press Enter.
              </div>
            )}

            {grouped.map(({ source, label, Icon, items }) => (
              <div key={source} className="py-0.5">
                <div
                  className="px-2 pt-1 pb-0.5 text-2xs uppercase tracking-wide"
                  style={{ color: 'var(--color-text-muted)', fontSize: '10px' }}
                >
                  {label}
                </div>
                {items.map((e) => {
                  const isSelected = value === e.path;
                  return (
                    <button
                      key={`${source}:${e.path}`}
                      type="button"
                      onClick={() => commit(e.path)}
                      className="flex items-center gap-2 w-full px-2 py-1.5 text-left hover:bg-hover transition-colors"
                    >
                      <Icon
                        className="w-3 h-3 shrink-0"
                        style={{ color: 'var(--color-text-muted)' }}
                      />
                      <div className="flex-1 min-w-0">
                        {e.label && (
                          <div className="text-xs truncate">{e.label}</div>
                        )}
                        <div
                          className="font-mono truncate"
                          style={{
                            fontSize: '11px',
                            color: e.label
                              ? 'var(--color-text-muted)'
                              : 'var(--color-text)',
                          }}
                        >
                          {e.path}
                        </div>
                      </div>
                      {isSelected && (
                        <Check className="w-3 h-3 text-honey-500 shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Free-form commit row — visible whenever the typed query
              doesn't match an existing suggestion. */}
          {canCommitFreeform && (
            <div
              className="border-t"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              <button
                type="button"
                onClick={() => commit(trimmedQuery)}
                className="flex items-center gap-2 w-full px-2 py-1.5 text-left text-xs hover:bg-hover transition-colors"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                <Folder className="w-3 h-3 shrink-0" />
                <span>
                  Use <span className="font-mono">{trimmedQuery}</span>
                </span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
