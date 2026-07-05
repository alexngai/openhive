/**
 * Settings → Connections. Management surface for the multi-hub connections
 * (Approach A2 polish of docs/design/remote-control.md): list / switch / rename
 * / remove / add. The sidebar HubSwitcher covers quick switching; this panel is
 * the roomier CRUD view. All state lives in stores/hubs.ts.
 */

import { useState } from 'react';
import { Server, Plus, Trash2, Check, Pencil, X } from 'lucide-react';
import clsx from 'clsx';
import { useHubsStore, type HubConnection } from '../../stores/hubs';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { TimeAgo } from '../../components/common/TimeAgo';

function hostOf(conn: HubConnection): string {
  if (conn.origin === '') return 'same-origin';
  try {
    return new URL(conn.origin).host;
  } catch {
    return conn.origin;
  }
}

export function ConnectionsPanel() {
  const connections = useHubsStore((s) => s.connections);
  const activeHubId = useHubsStore((s) => s.activeHubId);
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Connections</h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            Hubs this client can steer. Switch between them here or from the sidebar.
          </p>
        </div>
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="btn btn-primary flex items-center gap-1.5 text-xs shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Add connection
          </button>
        )}
      </div>

      {showAdd && <AddConnectionCard onDone={() => setShowAdd(false)} />}

      <div className="space-y-1.5">
        {connections.map((conn) => (
          <ConnectionRow key={conn.id} conn={conn} isActive={conn.id === activeHubId} />
        ))}
      </div>
    </div>
  );
}

function ConnectionRow({ conn, isActive }: { conn: HubConnection; isActive: boolean }) {
  const switchTo = useHubsStore((s) => s.switchTo);
  const removeConnection = useHubsStore((s) => s.removeConnection);
  const renameConnection = useHubsStore((s) => s.renameConnection);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(conn.label);

  const isSameOrigin = conn.origin === '';

  const save = () => {
    renameConnection(conn.id, label);
    setEditing(false);
  };
  const cancel = () => {
    setLabel(conn.label);
    setEditing(false);
  };

  return (
    <div
      className="card px-4 py-3"
      style={isActive ? { borderColor: 'var(--color-accent)' } : undefined}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Server
          className="w-3.5 h-3.5 shrink-0"
          style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
        />
        {editing ? (
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') cancel();
            }}
            className="input text-sm py-0.5 px-1.5 flex-1 min-w-0"
            autoFocus
          />
        ) : (
          <span className="text-sm font-medium truncate">{conn.label}</span>
        )}
        {isActive && (
          <span
            className="text-2xs px-1.5 py-0.5 rounded font-medium shrink-0"
            style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-bg)' }}
          >
            active
          </span>
        )}
        {conn.authMode && (
          <span
            className="text-2xs px-1.5 py-0.5 rounded shrink-0"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
          >
            {conn.authMode}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-2xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
        <span className="font-mono truncate">{hostOf(conn)}</span>
        {conn.agent?.name && (
          <>
            <span className="opacity-30">&middot;</span>
            <span className="truncate">{conn.agent.name}</span>
          </>
        )}
        {conn.lastUsedAt && (
          <>
            <span className="opacity-30">&middot;</span>
            <span>Used <TimeAgo date={new Date(conn.lastUsedAt).toISOString()} /></span>
          </>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {!isActive && (
          <button onClick={() => switchTo(conn.id)} className="btn btn-ghost text-2xs px-2 py-0.5">
            Switch to
          </button>
        )}
        {editing ? (
          <>
            <button onClick={save} className="btn btn-ghost text-2xs px-2 py-0.5 flex items-center gap-1">
              <Check className="w-2.5 h-2.5" />
              Save
            </button>
            <button onClick={cancel} className="btn btn-ghost text-2xs px-2 py-0.5 flex items-center gap-1" style={{ color: 'var(--color-text-muted)' }}>
              <X className="w-2.5 h-2.5" />
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => { setLabel(conn.label); setEditing(true); }}
            className="btn btn-ghost text-2xs px-2 py-0.5 flex items-center gap-1"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Pencil className="w-2.5 h-2.5" />
            Rename
          </button>
        )}
        {!isSameOrigin && !editing && (
          <button
            onClick={() => removeConnection(conn.id)}
            className="btn btn-ghost text-2xs px-2 py-0.5 flex items-center gap-1"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Trash2 className="w-2.5 h-2.5" />
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function AddConnectionCard({ onDone }: { onDone: () => void }) {
  const addConnection = useHubsStore((s) => s.addConnection);
  const switchTo = useHubsStore((s) => s.switchTo);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [switchAfter, setSwitchAfter] = useState(true);
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
      if (switchAfter) switchTo(conn.id);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card p-4 space-y-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Add connection</h3>
        <button type="button" onClick={onDone} className="btn btn-ghost p-1" title="Cancel">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div>
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
          Hub URL <span className="text-red-400">*</span>
        </label>
        <input
          className="input w-full"
          placeholder="https://mini:7836"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(null); }}
          disabled={busy}
          autoFocus
        />
      </div>
      <div>
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
          API key
        </label>
        <input
          className="input w-full"
          type="password"
          placeholder="Bearer token — leave blank for a local-mode hub"
          value={token}
          onChange={(e) => { setToken(e.target.value); setError(null); }}
          disabled={busy}
        />
      </div>
      <div>
        <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
          Label
        </label>
        <input
          className="input w-full"
          placeholder="Optional — defaults to the instance name"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={busy}
        />
      </div>
      <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
        <input type="checkbox" checked={switchAfter} onChange={(e) => setSwitchAfter(e.target.checked)} disabled={busy} />
        Switch to this hub after adding
      </label>
      {error && <p className="text-xs" style={{ color: 'var(--color-danger)' }}>{error}</p>}
      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="submit"
          className="btn btn-primary flex items-center gap-1.5 text-xs"
          disabled={busy || !url.trim()}
        >
          {busy && <LoadingSpinner size="sm" />}
          Add &amp; connect
        </button>
        <button type="button" onClick={onDone} className="btn btn-ghost text-xs">Cancel</button>
      </div>
    </form>
  );
}
