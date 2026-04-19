/**
 * Cascade Changelog Generator
 *
 * Produces a human-readable summary of all commits, merges, and open
 * conflicts bound to an OpenTasks task. The primary Phase 3 artifact:
 * close a task → get a "what shipped" view for free.
 *
 * Pure function over cascade projections. Doesn't touch git, doesn't call
 * the opentasks daemon. Enrichment (task title, assignee) is the caller's
 * responsibility — this module stays focused on cascade data.
 *
 * @module cascade/changelog
 */

import {
  getCommitRangeForTask,
  listConflictsForStream,
  type CascadeCommitRange,
  type CascadeConflict,
} from '../db/dal/cascade-streams.js';

// ============================================================================
// Structured output
// ============================================================================

export interface ChangelogCommit {
  commit_hash: string;
  change_id: string | null;
  message_summary: string | null;
  author_agent_id: string | null;
  files_touched: string[];
  synced_at: string;
  /** Stream this commit belongs to (in case the task spans multiple) */
  stream_id: string;
  /** Which swarm emitted the commit */
  source_swarm_id: string;
}

export interface ChangelogStreamSummary {
  stream_row_id: string;
  stream_id: string;
  source_swarm_id: string;
  source_agent_id: string;
  first_commit: string | null;
  last_commit: string | null;
  commit_count: number;
  change_ids: string[];
  /** Merge commit if the stream has been merged */
  merge_commit: string | null;
  /** Target stream/branch the merge landed on, when known */
  merge_target: string | null;
  /** Open conflicts still pending on this stream */
  open_conflicts: Array<{
    conflict_id: string | null;
    conflicted_files: string[];
    source: string | null;
    detected_at: string;
  }>;
}

export interface CascadeChangelog {
  task_ref: { resource_id: string; node_id: string };
  /** True when any stream produced at least one commit bound to this task */
  has_work: boolean;
  /** Aggregate counts across all bound streams */
  totals: {
    commits: number;
    streams: number;
    merged_streams: number;
    open_conflicts: number;
    files_touched: number;
  };
  /** Per-stream summaries — supports tasks that fork into multiple streams */
  streams: ChangelogStreamSummary[];
  /** All commits across all streams, flattened in chronological order */
  commits: ChangelogCommit[];
  /** Union of all files touched across all bound commits, sorted */
  files_union: string[];
  /** Server timestamp when the changelog was generated */
  generated_at: string;
}

// ============================================================================
// Markdown rendering
// ============================================================================

export interface MarkdownOptions {
  /** Optional task title for the heading. Falls back to the task_ref if absent. */
  title?: string;
  /** Optional one-line task description */
  subtitle?: string;
  /** Whether to include the "Files touched" section. Default true. */
  include_files?: boolean;
  /** Whether to include the "Conflicts" section when no conflicts present. Default false. */
  include_empty_conflicts?: boolean;
  /** Truncate commit message summaries to this length. Default 120. */
  summary_max_length?: number;
  /** Files-touched list cap per commit (to keep rows readable). Default 5. */
  files_per_commit_cap?: number;
}

// ============================================================================
// Generation
// ============================================================================

/**
 * Build a structured changelog for an OpenTasks task.
 *
 * Returns an empty-but-well-formed object when no cascade streams are bound
 * to the task (has_work=false). Callers can surface "no commits yet" UI
 * without special-casing null.
 */
export function generateChangelog(
  task_resource_id: string,
  task_node_id: string,
  options: { commitsLimit?: number; commitsOffset?: number } = {}
): CascadeChangelog {
  const ranges = getCommitRangeForTask(task_resource_id, task_node_id, options);
  const streams: ChangelogStreamSummary[] = [];
  const commits: ChangelogCommit[] = [];
  const filesUnion = new Set<string>();
  let mergedCount = 0;
  let openConflictCount = 0;

  for (const range of ranges) {
    const conflicts = listConflictsForStream(range.stream_row_id);
    const openConflicts = conflicts
      .filter((c) => c.status === 'pending' || c.status === 'in_progress')
      .map((c) => ({
        conflict_id: c.conflict_id,
        conflicted_files: c.conflicted_files,
        source: c.source,
        detected_at: c.detected_at,
      }));
    openConflictCount += openConflicts.length;
    if (range.merge_commit) mergedCount++;

    streams.push({
      stream_row_id: range.stream_row_id,
      stream_id: range.stream_id,
      source_swarm_id: range.source_swarm_id,
      source_agent_id: range.source_agent_id,
      first_commit: range.first_commit,
      last_commit: range.last_commit,
      commit_count: range.commits.length,
      change_ids: range.change_ids,
      merge_commit: range.merge_commit,
      merge_target: range.merge_target,
      open_conflicts: openConflicts,
    });

    for (const c of range.commits) {
      commits.push({
        commit_hash: c.commit_hash,
        change_id: c.change_id,
        message_summary: c.message_summary,
        author_agent_id: c.author_agent_id,
        files_touched: c.files_touched,
        synced_at: c.synced_at,
        stream_id: range.stream_id,
        source_swarm_id: range.source_swarm_id,
      });
      for (const f of c.files_touched) filesUnion.add(f);
    }
  }

  // Chronological order across streams (stable when synced_at is equal).
  commits.sort((a, b) => a.synced_at.localeCompare(b.synced_at));

  return {
    task_ref: { resource_id: task_resource_id, node_id: task_node_id },
    has_work: commits.length > 0,
    totals: {
      commits: commits.length,
      streams: streams.length,
      merged_streams: mergedCount,
      open_conflicts: openConflictCount,
      files_touched: filesUnion.size,
    },
    streams,
    commits,
    files_union: Array.from(filesUnion).sort(),
    generated_at: new Date().toISOString(),
  };
}

/**
 * Render a structured changelog as markdown. Stable shape — callers can
 * paste the output into PR descriptions, release notes, or Slack without
 * further processing.
 */
export function renderMarkdown(
  changelog: CascadeChangelog,
  options: MarkdownOptions = {}
): string {
  const titleLine =
    options.title ?? `Task ${changelog.task_ref.resource_id}/${changelog.task_ref.node_id}`;
  const summaryLength = options.summary_max_length ?? 120;
  const filesCap = options.files_per_commit_cap ?? 5;
  const includeFiles = options.include_files !== false;
  const includeEmptyConflicts = options.include_empty_conflicts === true;

  const lines: string[] = [];
  lines.push(`# ${titleLine}`);
  if (options.subtitle) {
    lines.push('');
    lines.push(`_${options.subtitle}_`);
  }
  lines.push('');

  if (!changelog.has_work) {
    lines.push('No commits bound to this task yet.');
    return lines.join('\n');
  }

  // Summary line
  const t = changelog.totals;
  const summaryParts: string[] = [
    `${t.commits} commit${t.commits === 1 ? '' : 's'}`,
    `${t.streams} stream${t.streams === 1 ? '' : 's'}`,
    `${t.files_touched} file${t.files_touched === 1 ? '' : 's'} touched`,
  ];
  if (t.merged_streams > 0) {
    summaryParts.push(`${t.merged_streams} merged`);
  }
  if (t.open_conflicts > 0) {
    summaryParts.push(`**${t.open_conflicts} open conflict${t.open_conflicts === 1 ? '' : 's'}**`);
  }
  lines.push(summaryParts.join(' · '));
  lines.push('');

  // Commits section
  lines.push('## Commits');
  lines.push('');
  for (const c of changelog.commits) {
    const short = c.commit_hash.slice(0, 8);
    const summary = truncate(c.message_summary ?? '(no message)', summaryLength);
    const author = c.author_agent_id ? ` _(${c.author_agent_id})_` : '';
    const files =
      c.files_touched.length > 0
        ? ` — ${c.files_touched.slice(0, filesCap).join(', ')}${
            c.files_touched.length > filesCap
              ? ` _(+${c.files_touched.length - filesCap} more)_`
              : ''
          }`
        : '';
    lines.push(`- \`${short}\` ${summary}${author}${files}`);
  }
  lines.push('');

  // Merges section (only when there are merges)
  const mergedStreams = changelog.streams.filter((s) => s.merge_commit);
  if (mergedStreams.length > 0) {
    lines.push('## Merges');
    lines.push('');
    for (const s of mergedStreams) {
      const mergeShort = s.merge_commit!.slice(0, 8);
      const target = s.merge_target ?? 'unknown';
      lines.push(
        `- \`stream/${s.stream_id}\` → \`${target}\` via merge commit \`${mergeShort}\``
      );
    }
    lines.push('');
  }

  // Conflicts section
  if (t.open_conflicts > 0 || includeEmptyConflicts) {
    lines.push('## Conflicts');
    lines.push('');
    if (t.open_conflicts === 0) {
      lines.push('_None_');
    } else {
      for (const s of changelog.streams) {
        for (const cf of s.open_conflicts) {
          const fileList = cf.conflicted_files.slice(0, filesCap).join(', ');
          const extra =
            cf.conflicted_files.length > filesCap
              ? ` (+${cf.conflicted_files.length - filesCap} more)`
              : '';
          const idSuffix = cf.conflict_id ? ` (${cf.conflict_id})` : '';
          const src = cf.source ? ` [${cf.source}]` : '';
          lines.push(
            `- \`stream/${s.stream_id}\`${src}${idSuffix}: ${fileList}${extra}`
          );
        }
      }
    }
    lines.push('');
  }

  // Files touched (optional; useful for PR descriptions)
  if (includeFiles && changelog.files_union.length > 0) {
    lines.push('## Files touched');
    lines.push('');
    for (const f of changelog.files_union) {
      lines.push(`- ${f}`);
    }
    lines.push('');
  }

  // Trim trailing blank line
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// Re-export helpful types for consumers
export type { CascadeCommitRange, CascadeConflict };
