/**
 * CascadeBlock — shows cascade commit range + merges + conflicts bound to
 * an OpenTasks task. Embedded on the task detail page (primary use) and
 * reusable from any context that has a (resource_id, node_id) pair.
 *
 * Loading/empty/error states all land in the same visual footprint so the
 * surrounding layout doesn't jump.
 */

import { useState } from 'react';
import {
  GitCommit,
  GitMerge,
  GitPullRequestDraft,
  Clipboard,
  Check,
  FileText,
  Users,
} from 'lucide-react';
import { useCascadeChangelog } from '../hooks/useApi';
import { useCascadeRealtime } from '../hooks/useRealtimeInvalidation';
import { TimeAgo } from './common/TimeAgo';

interface CascadeBlockProps {
  resourceId: string;
  nodeId: string;
  /** Title for the markdown header. Defaults to "Task {nodeId}". */
  taskTitle?: string;
  /** Subtitle (e.g., one-line task description). */
  taskSubtitle?: string;
}

export function CascadeBlock({
  resourceId,
  nodeId,
  taskTitle,
  taskSubtitle,
}: CascadeBlockProps) {
  const { data, isLoading, error } = useCascadeChangelog(resourceId, nodeId, {
    title: taskTitle,
    subtitle: taskSubtitle,
  });
  // Subscribe to cascade WS events for this task so commits/conflicts/merges
  // appear without waiting for the 15s staleTime to expire.
  useCascadeRealtime(resourceId, nodeId);

  if (isLoading) {
    return (
      <div
        className="card p-4 text-xs animate-pulse"
        style={{ color: 'var(--color-text-muted)' }}
      >
        Loading cascade activity…
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="card p-4 text-xs"
        style={{ color: 'var(--color-text-muted)' }}
      >
        Failed to load cascade activity: {(error as Error).message}
      </div>
    );
  }

  const changelog = data?.data;
  const markdown = data?.markdown;

  if (!changelog || !changelog.has_work) {
    return (
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-1">
          <GitCommit
            className="w-4 h-4"
            style={{ color: 'var(--color-text-muted)' }}
          />
          <h3 className="text-sm font-semibold">Cascade activity</h3>
        </div>
        <p
          className="text-xs"
          style={{ color: 'var(--color-text-muted)' }}
        >
          No commits bound to this task yet. Work will appear here once a
          cascade-aware agent commits with this task's reference.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <CascadeSummary changelog={changelog} markdown={markdown} />
      {changelog.streams.some((s) => s.open_conflicts.length > 0) && (
        <CascadeConflicts changelog={changelog} />
      )}
      <CascadeCommitsList changelog={changelog} />
      {changelog.streams.some((s) => s.merge_commit) && (
        <CascadeMerges changelog={changelog} />
      )}
      {changelog.files_union.length > 0 && (
        <CascadeFiles changelog={changelog} />
      )}
    </div>
  );
}

// ----- Sub-components ------------------------------------------------------

function CascadeSummary({
  changelog,
  markdown,
}: {
  changelog: NonNullable<ReturnType<typeof useCascadeChangelog>['data']>['data'];
  markdown: string | undefined;
}) {
  const t = changelog.totals;
  const stats: Array<{ icon: JSX.Element; label: string; value: number; highlight?: boolean }> = [
    { icon: <GitCommit className="w-3.5 h-3.5" />, label: 'commits', value: t.commits },
    { icon: <Users className="w-3.5 h-3.5" />, label: 'streams', value: t.streams },
    { icon: <GitMerge className="w-3.5 h-3.5" />, label: 'merged', value: t.merged_streams },
    { icon: <FileText className="w-3.5 h-3.5" />, label: 'files', value: t.files_touched },
  ];
  if (t.open_conflicts > 0) {
    stats.push({
      icon: <GitPullRequestDraft className="w-3.5 h-3.5" />,
      label: 'open conflicts',
      value: t.open_conflicts,
      highlight: true,
    });
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Cascade activity</h3>
        {markdown && <CopyMarkdownButton markdown={markdown} />}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map((s) => (
          <div
            key={s.label}
            className="flex flex-col"
            style={s.highlight ? { color: 'var(--color-danger)' } : undefined}
          >
            <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wider" style={s.highlight ? undefined : { color: 'var(--color-text-muted)' }}>
              {s.icon}
              {s.label}
            </div>
            <div className="text-xl font-semibold mt-0.5">{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CascadeCommitsList({
  changelog,
}: {
  changelog: NonNullable<ReturnType<typeof useCascadeChangelog>['data']>['data'];
}) {
  return (
    <div className="card p-4">
      <h4 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
        <GitCommit className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
        Commits ({changelog.commits.length})
      </h4>
      <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
        {changelog.commits.map((c) => (
          <li key={`${c.stream_id}:${c.commit_hash}`} className="py-2 first:pt-0 last:pb-0">
            <div className="flex items-start gap-2">
              <code
                className="text-2xs font-mono px-1.5 py-0.5 rounded shrink-0"
                style={{ backgroundColor: 'var(--color-elevated)' }}
                title={c.commit_hash}
              >
                {c.commit_hash.slice(0, 8)}
              </code>
              <div className="min-w-0 flex-1">
                <div className="text-xs truncate">
                  {c.message_summary ?? <span style={{ color: 'var(--color-text-muted)' }}>(no message)</span>}
                </div>
                <div className="text-2xs mt-0.5 flex items-center gap-2 flex-wrap" style={{ color: 'var(--color-text-muted)' }}>
                  {c.author_agent_id && <span>{c.author_agent_id}</span>}
                  <TimeAgo date={c.synced_at} />
                  <span>· stream/{c.stream_id.slice(0, 8)}</span>
                  {c.files_touched.length > 0 && (
                    <span>· {c.files_touched.length} file{c.files_touched.length === 1 ? '' : 's'}</span>
                  )}
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CascadeMerges({
  changelog,
}: {
  changelog: NonNullable<ReturnType<typeof useCascadeChangelog>['data']>['data'];
}) {
  const merged = changelog.streams.filter((s) => s.merge_commit);
  return (
    <div className="card p-4">
      <h4 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
        <GitMerge className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
        Merges ({merged.length})
      </h4>
      <ul className="space-y-1.5">
        {merged.map((s) => (
          <li key={s.stream_row_id} className="text-xs">
            <code
              className="text-2xs font-mono px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'var(--color-elevated)' }}
            >
              stream/{s.stream_id.slice(0, 8)}
            </code>{' '}
            →{' '}
            <code
              className="text-2xs font-mono px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'var(--color-elevated)' }}
            >
              {s.merge_target ?? 'unknown'}
            </code>{' '}
            <span style={{ color: 'var(--color-text-muted)' }}>via</span>{' '}
            <code
              className="text-2xs font-mono px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'var(--color-elevated)' }}
              title={s.merge_commit ?? ''}
            >
              {s.merge_commit?.slice(0, 8)}
            </code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CascadeConflicts({
  changelog,
}: {
  changelog: NonNullable<ReturnType<typeof useCascadeChangelog>['data']>['data'];
}) {
  return (
    <div
      className="card p-4"
      style={{ borderColor: 'var(--color-danger-border)' }}
    >
      <h4 className="text-sm font-semibold mb-2 flex items-center gap-1.5" style={{ color: 'var(--color-danger)' }}>
        <GitPullRequestDraft className="w-4 h-4" />
        Open conflicts ({changelog.totals.open_conflicts})
      </h4>
      <ul className="space-y-2">
        {changelog.streams.flatMap((s) =>
          s.open_conflicts.map((cf, i) => (
            <li key={`${s.stream_row_id}-${i}`} className="text-xs">
              <div>
                <code
                  className="text-2xs font-mono px-1.5 py-0.5 rounded"
                  style={{ backgroundColor: 'var(--color-elevated)' }}
                >
                  stream/{s.stream_id.slice(0, 8)}
                </code>
                {cf.source && (
                  <span
                    className="ml-1.5 text-2xs uppercase tracking-wider"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {cf.source}
                  </span>
                )}
                {cf.conflict_id && (
                  <span
                    className="ml-1.5 text-2xs font-mono"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {cf.conflict_id}
                  </span>
                )}
              </div>
              <div className="mt-1 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                Files: {cf.conflicted_files.join(', ')}
              </div>
            </li>
          )),
        )}
      </ul>
    </div>
  );
}

function CascadeFiles({
  changelog,
}: {
  changelog: NonNullable<ReturnType<typeof useCascadeChangelog>['data']>['data'];
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = changelog.files_union.slice(0, 10);
  const rest = changelog.files_union.length - preview.length;

  return (
    <div className="card p-4">
      <h4 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
        <FileText className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
        Files touched ({changelog.files_union.length})
      </h4>
      <ul className="text-xs font-mono space-y-0.5">
        {(expanded ? changelog.files_union : preview).map((f) => (
          <li key={f} style={{ color: 'var(--color-text-secondary)' }}>
            {f}
          </li>
        ))}
      </ul>
      {rest > 0 && !expanded && (
        <button
          type="button"
          className="mt-2 text-2xs hover:text-honey-500 transition-colors rounded px-1 -mx-1
                     focus:outline-none focus-visible:ring-2 focus-visible:ring-honey-500/60"
          style={{ color: 'var(--color-text-muted)' }}
          onClick={() => setExpanded(true)}
          aria-expanded={expanded}
          aria-label={`Show ${rest} more files`}
        >
          Show {rest} more…
        </button>
      )}
    </div>
  );
}

function CopyMarkdownButton({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API not available; silently ignore.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="btn-ghost text-2xs flex items-center gap-1 px-1.5 py-0.5"
      title="Copy markdown changelog to clipboard"
      aria-label={copied ? 'Markdown copied' : 'Copy markdown changelog to clipboard'}
    >
      {copied ? (
        <>
          <Check className="w-3 h-3" />
          Copied
        </>
      ) : (
        <>
          <Clipboard className="w-3 h-3" />
          Copy markdown
        </>
      )}
    </button>
  );
}
