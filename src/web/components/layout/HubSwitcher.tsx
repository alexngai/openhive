/**
 * HubSwitcher — the connection switcher in the sidebar header (Approach A2 of
 * docs/design/remote-control.md). Lists saved hub connections, switches the
 * active one (which re-points the whole client via the hubs store → lib/hub.ts),
 * and adds a new one by URL + API key.
 */

import { useEffect, useRef, useState } from 'react';
import { Server, ChevronsUpDown, Check, Plus, Trash2, X } from 'lucide-react';
import clsx from 'clsx';
import { useHubsStore, type HubConnection } from '../../stores/hubs';
import { LoadingSpinner } from '../common/LoadingSpinner';

function subtitleFor(conn: HubConnection): string {
  if (conn.origin === '') return conn.authMode === 'local' ? 'Local · this hub' : 'This hub';
  try {
    return new URL(conn.origin).host;
  } catch {
    return conn.origin;
  }
}

export function HubSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const connections = useHubsStore((s) => s.connections);
  const activeHubId = useHubsStore((s) => s.activeHubId);
  const switchTo = useHubsStore((s) => s.switchTo);
  const removeConnection = useHubsStore((s) => s.removeConnection);

  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = connections.find((c) => c.id === activeHubId) ?? connections[0];

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setAdding(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!active) return null;

  const select = (id: string) => {
    if (id !== activeHubId) switchTo(id);
    setOpen(false);
    setAdding(false);
  };

  return (
    <div ref={containerRef} className="relative border-b shrink-0" style={{ borderColor: 'var(--color-border-subtle)' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={collapsed ? `Hub: ${active.label}` : undefined}
        className={clsx(
          'flex items-center w-full cursor-pointer transition-colors duration-80',
          collapsed ? 'justify-center px-2 py-2.5' : 'gap-2 px-3 py-2.5',
        )}
        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
      >
        <Server className="w-4 h-4 shrink-0" style={{ color: 'var(--color-accent)' }} />
        {!collapsed && (
          <>
            <span className="min-w-0 text-left">
              <span className="block text-xs font-medium truncate" style={{ color: 'var(--color-text)' }}>
                {active.label}
              </span>
              <span className="block text-2xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                {subtitleFor(active)}
              </span>
            </span>
            <ChevronsUpDown className="w-3.5 h-3.5 ml-auto shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          </>
        )}
      </button>

      {open && (
        <div
          className="absolute left-2 right-2 top-full z-40 mt-1 rounded-md border shadow-lg overflow-hidden"
          style={{ backgroundColor: 'var(--color-elevated)', borderColor: 'var(--color-border)' }}
        >
          <div className="px-3 py-1.5 text-2xs font-medium uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
            Hubs
          </div>
          <ul className="max-h-64 overflow-y-auto">
            {connections.map((conn) => {
              const isActive = conn.id === activeHubId;
              return (
                <li key={conn.id} className="group flex items-center">
                  <button
                    onClick={() => select(conn.id)}
                    className="flex items-center gap-2 flex-1 min-w-0 px-3 py-1.5 text-left transition-colors duration-80"
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                  >
                    <Check
                      className={clsx('w-3.5 h-3.5 shrink-0', !isActive && 'opacity-0')}
                      style={{ color: 'var(--color-accent)' }}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs truncate" style={{ color: 'var(--color-text)' }}>{conn.label}</span>
                      <span className="block text-2xs truncate" style={{ color: 'var(--color-text-muted)' }}>{subtitleFor(conn)}</span>
                    </span>
                  </button>
                  {conn.origin !== '' && (
                    <button
                      onClick={() => removeConnection(conn.id)}
                      title="Remove connection"
                      className="opacity-0 group-hover:opacity-100 shrink-0 p-1.5 mr-1 rounded transition-opacity"
                      style={{ color: 'var(--color-text-muted)' }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-danger)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-muted)'; }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {adding ? (
              <AddConnectionForm
                onDone={(id) => { if (id) select(id); else { setAdding(false); } }}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <button
                onClick={() => setAdding(true)}
                className="flex items-center gap-2 w-full px-3 py-2 text-left transition-colors duration-80"
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--color-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <Plus className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>Add connection…</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AddConnectionForm({
  onDone,
  onCancel,
}: {
  onDone: (id: string | null) => void;
  onCancel: () => void;
}) {
  const addConnection = useHubsStore((s) => s.addConnection);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const conn = await addConnection({
        label: label.trim() || undefined,
        origin: url.trim(),
        token: token.trim() || null,
      });
      onDone(conn.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-2xs font-medium uppercase tracking-wide" style={{ color: 'var(--color-text-muted)' }}>Add connection</span>
        <button type="button" onClick={onCancel} className="p-0.5" style={{ color: 'var(--color-text-muted)' }} title="Cancel">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <input
        className="input w-full text-xs"
        placeholder="Hub URL (https://mini:7836)"
        value={url}
        onChange={(e) => { setUrl(e.target.value); setError(null); }}
        disabled={busy}
        autoFocus
      />
      <input
        className="input w-full text-xs"
        type="password"
        placeholder="API key (blank for local-mode hub)"
        value={token}
        onChange={(e) => { setToken(e.target.value); setError(null); }}
        disabled={busy}
      />
      <input
        className="input w-full text-xs"
        placeholder="Label (optional)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        disabled={busy}
      />
      {error && (
        <p className="text-2xs" style={{ color: 'var(--color-danger)' }}>{error}</p>
      )}
      <button
        type="submit"
        className="btn btn-primary w-full flex items-center justify-center gap-1.5 text-xs"
        disabled={busy || !url.trim()}
      >
        {busy && <LoadingSpinner size="sm" />}
        Connect
      </button>
    </form>
  );
}
