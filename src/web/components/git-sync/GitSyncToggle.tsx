/**
 * GitSyncToggle
 *
 * Compact toolbar control that shows current git-sync state for a task
 * resource and opens a popover to toggle it. Wraps the `useResourceGitSync`
 * + `useUpdateResourceGitSync` hooks; gates itself on resource eligibility
 * (task type + local_path) so callers can drop it in without pre-checking.
 *
 * Visual contract:
 *   - Button label:   "Sync: on" / "Sync: off" / "Sync: N/A"
 *   - Click:          opens a popover with an Enable checkbox + remote name
 *   - After toggle:   shows a short "applied to running daemon" hint when the
 *                     PATCH response says so; otherwise "saved; restart
 *                     daemon to apply" (for when the daemon wasn't reachable).
 */

import { useState, useRef, useEffect } from 'react';
import { RefreshCw, GitBranch, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import {
  useResourceGitSync,
  useUpdateResourceGitSync,
  useRunGitSyncNow,
  type GitSyncMetadata,
} from '../../hooks/useApi';
import type { SyncableResource } from '../../lib/api';

interface GitSyncToggleProps {
  resource: SyncableResource | undefined;
  /** Optional CSS class for the trigger button (for toolbar integration). */
  className?: string;
}

/**
 * Git sync is only meaningful for:
 *   - Task resources (it's opentasks config we're writing)
 *   - With a local_path (the daemon must exist on this machine)
 */
function isEligible(resource: SyncableResource | undefined): boolean {
  if (!resource) return false;
  if (resource.resource_type !== 'task') return false;
  if (!resource.local_path) return false;
  return true;
}

export function GitSyncToggle({ resource, className = '' }: GitSyncToggleProps) {
  const eligible = isEligible(resource);
  const { data, isLoading } = useResourceGitSync(eligible ? resource?.id : undefined);
  const mutation = useUpdateResourceGitSync();
  const syncNow = useRunGitSyncNow();

  const [open, setOpen] = useState(false);
  const [applyNotice, setApplyNotice] = useState<null | {
    kind: 'live' | 'pending';
    at: number;
  }>(null);

  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  // Auto-clear the apply notice after 5s
  useEffect(() => {
    if (!applyNotice) return;
    const timer = setTimeout(() => setApplyNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [applyNotice]);

  if (!eligible) return null;

  const gitSync = data?.git_sync;
  const enabled = !!gitSync?.enabled;
  const health = data?.health;
  const hasError = enabled && !!health?.lastError;

  const label = isLoading
    ? 'Sync: …'
    : hasError
      ? 'Sync: error'
      : enabled
        ? 'Sync: on'
        : 'Sync: off';
  const color = hasError
    ? 'var(--color-danger)'
    : enabled
      ? '#34d399'
      : 'var(--color-text-muted)';

  const onToggle = (nextEnabled: boolean) => {
    if (!resource) return;
    const next: GitSyncMetadata = {
      enabled: nextEnabled,
      // Preserve the rest of the existing config on flip. For a fresh
      // enable, apply the server's live-sync defaults.
      remote: gitSync?.remote ?? 'origin',
      autoCommit: gitSync?.autoCommit,
      autoPush: gitSync?.autoPush,
      pullOnStartup: gitSync?.pullOnStartup,
      pullOnSignal: gitSync?.pullOnSignal,
    };
    mutation.mutate(
      { resourceId: resource.id, gitSync: next },
      {
        onSuccess: (result) => {
          setApplyNotice({
            kind: result.daemon_applied ? 'live' : 'pending',
            at: Date.now(),
          });
        },
      },
    );
  };

  return (
    <div className={`relative ${className}`} ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-2xs font-medium transition-colors hover:bg-white/5"
        style={{ color, backgroundColor: 'var(--color-elevated)' }}
        title={enabled ? 'Git sync enabled — commits + pushes on change' : 'Git sync disabled'}
      >
        <GitBranch className="w-3 h-3" />
        {label}
      </button>

      {open && (
        <div
          className="absolute right-0 mt-1 z-50 w-72 rounded-lg border p-3 shadow-lg"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-border)',
          }}
        >
          <div className="text-xs font-semibold mb-2" style={{ color: 'var(--color-text)' }}>
            Git sync
          </div>
          <p className="text-2xs mb-3" style={{ color: 'var(--color-text-muted)' }}>
            When enabled, the daemon auto-commits and auto-pushes every graph
            change to the configured remote, and pulls on startup.
          </p>

          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              disabled={mutation.isPending}
              onChange={(e) => onToggle(e.target.checked)}
              className="mt-0.5"
            />
            <span style={{ color: 'var(--color-text)' }}>
              Enable git sync for this resource
            </span>
          </label>

          {gitSync?.remote && (
            <div className="text-2xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
              Remote: <code>{gitSync.remote}</code>
            </div>
          )}

          {hasError && health?.lastError && (
            <div
              className="text-2xs mt-3 p-2 rounded"
              style={{ color: 'var(--color-danger)', backgroundColor: 'var(--color-danger-bg)' }}
            >
              <div className="flex items-center gap-1 font-semibold mb-1">
                <AlertCircle className="w-3 h-3" />
                Last {health.lastErrorOp ?? 'op'} failed
                {health.lastErrorAt && (
                  <span className="font-normal opacity-70">
                    · {new Date(health.lastErrorAt).toLocaleString()}
                  </span>
                )}
              </div>
              <code className="block break-all" style={{ color: 'var(--color-danger)' }}>
                {health.lastError}
              </code>
            </div>
          )}

          {enabled && !hasError && health?.lastSuccessAt && (
            <div className="text-2xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
              Last synced: {new Date(health.lastSuccessAt).toLocaleString()}
            </div>
          )}

          {enabled && resource && (
            <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--color-border)' }}>
              <button
                type="button"
                disabled={syncNow.isPending}
                onClick={() => syncNow.mutate(resource.id)}
                className="w-full flex items-center justify-center gap-1 px-2 py-1.5 rounded text-2xs font-medium transition-colors"
                style={{
                  color: 'var(--color-text)',
                  backgroundColor: 'var(--color-elevated)',
                }}
              >
                {syncNow.isPending ? (
                  <>
                    <RefreshCw className="w-3 h-3 animate-spin" /> Syncing…
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3 h-3" /> Sync now
                  </>
                )}
              </button>
              {syncNow.isError && (
                <div className="text-2xs mt-2" style={{ color: 'var(--color-danger)' }}>
                  {(syncNow.error as Error).message}
                </div>
              )}
              {syncNow.data && !syncNow.data.ran && (
                <div className="text-2xs mt-2 text-amber-400">
                  {syncNow.data.reason ?? 'sync.now returned without running'}
                </div>
              )}
            </div>
          )}

          {mutation.isPending && (
            <div className="flex items-center gap-1 text-2xs mt-3" style={{ color: 'var(--color-text-muted)' }}>
              <RefreshCw className="w-3 h-3 animate-spin" /> Saving…
            </div>
          )}

          {mutation.isError && (
            <div className="flex items-center gap-1 text-2xs mt-3" style={{ color: 'var(--color-danger)' }}>
              <XCircle className="w-3 h-3" /> {(mutation.error as Error).message}
            </div>
          )}

          {applyNotice?.kind === 'live' && (
            <div className="flex items-center gap-1 text-2xs mt-3 text-emerald-400">
              <CheckCircle2 className="w-3 h-3" /> Applied to running daemon
            </div>
          )}
          {applyNotice?.kind === 'pending' && (
            <div className="flex items-center gap-1 text-2xs mt-3 text-amber-400">
              <AlertCircle className="w-3 h-3" /> Saved — daemon will pick up on next restart
            </div>
          )}
        </div>
      )}
    </div>
  );
}
