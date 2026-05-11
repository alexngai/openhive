/**
 * PRStackDrawer — "Open PR stack" workflow.
 *
 * Triggered from `StreamStackView`'s header. Flow:
 *
 *   1. Idle: shows the chosen root + "Open PR stack" CTA, plus optional
 *      target branch / draft toggle.
 *   2. Submitting: spinner; mutation in flight.
 *   3. Result: per-stream cards keyed by walker order. Each card carries a
 *      status badge (created / existing / push_required / blocked_by_parent
 *      / failed), branch info, and a click-through to `pr_url` when set.
 *
 * Idempotent: clicking "Open PR stack" again after a partial outcome
 * re-runs the mutation; already-open PRs surface as `existing`.
 */

import { useState } from 'react';
import {
  GitPullRequest,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ExternalLink,
  Loader2,
  GitBranch,
} from 'lucide-react';
import {
  useOpenPRStack,
  type PRStackResult,
  type PRStackResultEntry,
  type PRStackEntryStatus,
} from '../../hooks/useCascadePRStack';

interface PRStackDrawerProps {
  rootRowId: string;
  rootName?: string;
  onClose?: () => void;
}

export function PRStackDrawer({ rootRowId, rootName, onClose }: PRStackDrawerProps) {
  const [draft, setDraft] = useState(false);
  const [targetBranch, setTargetBranch] = useState('');
  const mutation = useOpenPRStack();
  const result = mutation.data ?? null;

  return (
    <div className="flex flex-col h-full bg-zinc-950 text-zinc-100 border border-zinc-800 rounded-md overflow-hidden">
      <PanelHeader rootName={rootName} onClose={onClose} />
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="p-4 border-b border-zinc-800 flex items-end gap-3 text-xs">
          <div className="flex-1">
            <label className="block text-zinc-400 mb-1">
              Root target branch <span className="text-zinc-600">(defaults to trunk)</span>
            </label>
            <input
              type="text"
              value={targetBranch}
              onChange={(e) => setTargetBranch(e.target.value)}
              placeholder="main"
              className="input text-xs py-1 w-full font-mono"
              disabled={mutation.isPending}
            />
          </div>
          <label className="flex items-center gap-1.5 text-zinc-300 pb-1.5">
            <input
              type="checkbox"
              checked={draft}
              onChange={(e) => setDraft(e.target.checked)}
              disabled={mutation.isPending}
            />
            Draft
          </label>
          <button
            type="button"
            className="btn-honey text-xs px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50"
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate({
                rootRowId,
                target_branch: targetBranch.trim() || undefined,
                draft,
              })
            }
          >
            {mutation.isPending ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Opening…
              </>
            ) : (
              <>
                <GitPullRequest className="w-3.5 h-3.5" />
                {result ? 'Open again' : 'Open PR stack'}
              </>
            )}
          </button>
        </div>

        {mutation.error && <RouteErrorPanel error={mutation.error} />}
        {result && <ResultList result={result} />}
        {!result && !mutation.error && !mutation.isPending && <IdleHint />}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Result list
// ───────────────────────────────────────────────────────────────────────

function ResultList({ result }: { result: PRStackResult }) {
  return (
    <div className="p-4 space-y-2">
      <div className="text-2xs text-zinc-500">
        Trunk: <span className="font-mono text-zinc-300">{result.trunk}</span>
        <span className="mx-1.5">·</span>
        {result.entries.length} {result.entries.length === 1 ? 'stream' : 'streams'}
      </div>
      {result.entries.map((e) => (
        <EntryCard key={e.stream_row_id} entry={e} />
      ))}
    </div>
  );
}

function EntryCard({ entry }: { entry: PRStackResultEntry }) {
  const cfg = STATUS_CONFIG[entry.result_status];
  const Icon = cfg.Icon;
  return (
    <div
      className="rounded-md border bg-zinc-900/40 p-3 text-xs"
      style={{ borderColor: cfg.borderColor }}
    >
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: cfg.iconColor }} />
          <span className="font-medium truncate">{entry.name}</span>
          <span className={`text-2xs px-1.5 py-0.5 rounded ${cfg.badgeClass}`}>
            {cfg.label}
          </span>
        </div>
        {entry.pr_url && (
          <a
            href={entry.pr_url}
            target="_blank"
            rel="noreferrer"
            className="text-2xs flex items-center gap-1 text-honey-300 hover:text-honey-200"
          >
            #{entry.pr_number ?? '?'}
            <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
      <div className="flex items-center gap-2 text-2xs text-zinc-500 font-mono">
        <GitBranch className="w-3 h-3" />
        <span title="head_branch">{entry.head_branch}</span>
        <span className="text-zinc-700">→</span>
        <span title="base_branch">{entry.base_branch}</span>
      </div>
      {entry.error && (
        <div className="mt-2 text-2xs text-rose-300 break-words">{entry.error}</div>
      )}
      {entry.result_status === 'push_required' && (
        <div className="mt-2 text-2xs text-amber-300">
          The branch <code className="font-mono">{entry.head_branch}</code> is not on origin.
          Reconnect the agent and push, or open the PR manually once it&apos;s pushed.
        </div>
      )}
      {entry.result_status === 'blocked_by_parent' && (
        <div className="mt-2 text-2xs text-zinc-400">
          Blocked because an ancestor in this lineage needs to push first.
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Status config
// ───────────────────────────────────────────────────────────────────────

interface StatusConfig {
  label: string;
  Icon: typeof CheckCircle2;
  iconColor: string;
  borderColor: string;
  badgeClass: string;
}

const STATUS_CONFIG: Record<PRStackEntryStatus, StatusConfig> = {
  created: {
    label: 'Created',
    Icon: CheckCircle2,
    iconColor: 'rgb(110, 231, 183)',
    borderColor: 'rgba(110, 231, 183, 0.35)',
    badgeClass: 'bg-emerald-500/15 text-emerald-300',
  },
  existing: {
    label: 'Existing',
    Icon: GitPullRequest,
    iconColor: 'rgb(125, 211, 252)',
    borderColor: 'rgba(125, 211, 252, 0.35)',
    badgeClass: 'bg-sky-500/15 text-sky-300',
  },
  push_required: {
    label: 'Push required',
    Icon: AlertTriangle,
    iconColor: 'rgb(252, 211, 77)',
    borderColor: 'rgba(252, 211, 77, 0.35)',
    badgeClass: 'bg-amber-500/15 text-amber-300',
  },
  blocked_by_parent: {
    label: 'Blocked by ancestor',
    Icon: AlertTriangle,
    iconColor: 'rgb(161, 161, 170)',
    borderColor: 'rgba(161, 161, 170, 0.25)',
    badgeClass: 'bg-zinc-500/15 text-zinc-300',
  },
  failed: {
    label: 'Failed',
    Icon: XCircle,
    iconColor: 'rgb(252, 165, 165)',
    borderColor: 'rgba(252, 165, 165, 0.35)',
    badgeClass: 'bg-rose-500/15 text-rose-300',
  },
};

// ───────────────────────────────────────────────────────────────────────
// Chrome
// ───────────────────────────────────────────────────────────────────────

function PanelHeader({
  rootName,
  onClose,
}: {
  rootName?: string;
  onClose?: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <GitPullRequest className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        <span className="font-mono truncate">
          Open PR stack{rootName ? ` — ${rootName}` : ''}
        </span>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-200 transition-colors px-2"
          aria-label="Close PR stack drawer"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function IdleHint() {
  return (
    <div className="p-4 text-xs text-zinc-500">
      Walks descendants from this root and opens one PR per unmerged stream.
      Sequential — siblings of a different parent proceed independently.
      Idempotent on re-run: already-open PRs surface as <em>existing</em>.
    </div>
  );
}

function RouteErrorPanel({ error }: { error: unknown }) {
  const e = error as
    | { status?: number; body?: { error?: string; message?: string } }
    | undefined;
  const code = e?.body?.error;
  const message =
    e?.body?.message ??
    (error instanceof Error ? error.message : 'Failed to open PR stack');
  return (
    <div className="p-4">
      <div className="flex items-center gap-2 text-rose-300 mb-1">
        <XCircle className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">{code ?? 'error'}</span>
      </div>
      <div className="text-zinc-400 text-xs">{message}</div>
    </div>
  );
}
