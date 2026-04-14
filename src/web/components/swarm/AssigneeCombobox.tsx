import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Check, ChevronDown, Search, X, Zap } from 'lucide-react';
import { useMapSwarms } from '../../hooks/useApi';
import { resolveAssigneeSwarm, SwarmChip } from './SwarmChip';
import type { MapSwarm } from '../../lib/api';

const STATUS_DOT: Record<MapSwarm['status'], string> = {
  online:      'bg-emerald-400',
  offline:     'bg-gray-500',
  unreachable: 'bg-amber-400',
};

interface AssigneeComboboxProps {
  value: string | null | undefined;
  onChange: (next: string | null) => void;
  disabled?: boolean;
}

/**
 * Combobox for picking an assignee. Suggests known swarms with live status;
 * falls back to freeform text for non-swarm assignees.
 *
 * On change, emits the new string (or null to clear). Caller is responsible
 * for persisting via the existing PATCH task mutation.
 */
export function AssigneeCombobox({ value, onChange, disabled }: AssigneeComboboxProps) {
  const { data: swarms } = useMapSwarms();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matchedSwarm = resolveAssigneeSwarm(value, swarms);
  const hasCustomValue = Boolean(value?.trim()) && !matchedSwarm;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setCustomMode(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open, customMode]);

  const sortedSwarms = [...(swarms ?? [])].sort((a, b) => {
    // Online first, then alphabetical
    const aOnline = a.status === 'online' ? 0 : 1;
    const bOnline = b.status === 'online' ? 0 : 1;
    if (aOnline !== bOnline) return aOnline - bOnline;
    return a.name.localeCompare(b.name);
  });

  const filtered = sortedSwarms.filter(s => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
  });

  const commitCustom = () => {
    const trimmed = customText.trim();
    onChange(trimmed || null);
    setOpen(false);
    setCustomMode(false);
    setCustomText('');
    setQuery('');
  };

  const select = (swarmId: string) => {
    onChange(swarmId);
    setOpen(false);
    setQuery('');
  };

  const clear = () => {
    onChange(null);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative inline-block w-full">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className={clsx(
          'flex items-center gap-2 w-full text-left rounded px-1.5 py-1 -ml-1.5 transition-colors',
          disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5',
          open && 'bg-white/5',
        )}
      >
        <div className="flex-1 min-w-0">
          {matchedSwarm ? (
            <SwarmChip assignee={value} size="sm" />
          ) : hasCustomValue ? (
            <span
              className="inline-flex items-center text-2xs px-1.5 py-0.5 rounded font-medium"
              style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
            >
              @{value}
            </span>
          ) : (
            <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Unassigned</span>
          )}
        </div>
        <ChevronDown className={clsx('w-3 h-3 shrink-0 transition-transform', open && 'rotate-180')} style={{ color: 'var(--color-text-muted)' }} />
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 top-full mt-1 rounded-lg border shadow-lg z-20 overflow-hidden"
          style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        >
          {customMode ? (
            <div className="p-2 space-y-1.5">
              <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                Custom assignee
              </div>
              <input
                ref={inputRef}
                type="text"
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitCustom();
                  else if (e.key === 'Escape') { setCustomMode(false); setCustomText(''); }
                }}
                placeholder="e.g. alice, external-agent"
                className="input text-xs w-full"
              />
              <div className="flex gap-1">
                <button onClick={commitCustom} className="btn-primary text-2xs px-2 py-0.5">Save</button>
                <button
                  onClick={() => { setCustomMode(false); setCustomText(''); }}
                  className="btn-ghost text-2xs px-2 py-0.5"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5 p-1.5 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
                <Search className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                <input
                  ref={inputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
                  placeholder="Search swarms..."
                  className="text-xs bg-transparent outline-none flex-1"
                />
              </div>

              <div className="max-h-56 overflow-y-auto py-1">
                {filtered.length === 0 && (
                  <div className="px-3 py-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                    No swarms match.
                  </div>
                )}
                {filtered.map((s) => {
                  const isSelected = matchedSwarm?.id === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => select(s.id)}
                      className="flex items-center gap-2 w-full px-2 py-1.5 text-left hover:bg-white/5 transition-colors"
                    >
                      <Zap className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                      <span className="flex-1 text-xs truncate">{s.name}</span>
                      <span className="text-2xs capitalize" style={{ color: 'var(--color-text-muted)' }}>
                        {s.status}
                      </span>
                      <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', STATUS_DOT[s.status])} />
                      {isSelected && <Check className="w-3 h-3 text-honey-500 shrink-0" />}
                    </button>
                  );
                })}
              </div>

              <div className="border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
                <button
                  type="button"
                  onClick={() => { setCustomText(hasCustomValue ? (value ?? '') : ''); setCustomMode(true); }}
                  className="flex items-center gap-2 w-full px-2 py-1.5 text-left text-xs hover:bg-white/5 transition-colors"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  <span className="w-3 h-3 shrink-0 flex items-center justify-center text-2xs">@</span>
                  Custom assignee…
                </button>
                {(matchedSwarm || hasCustomValue) && (
                  <button
                    type="button"
                    onClick={clear}
                    className="flex items-center gap-2 w-full px-2 py-1.5 text-left text-xs hover:bg-red-500/10 transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <X className="w-3 h-3 shrink-0" />
                    Clear assignee
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
