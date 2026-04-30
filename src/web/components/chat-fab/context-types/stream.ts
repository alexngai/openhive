/**
 * Stream context type — a git-cascade stream (branch workstream).
 *
 * Data-type body (§4.5): fenced wrapper carries identity attrs, the inner
 * body is a Markdown key-value table with status, commit range, linked
 * task ref, and merge target.
 */

import type { ChatFabContextItem } from '../chat-fab-item';
import { registerContextType } from '../context-registry';
import { fencedBlock } from '../fenced-block';

export interface StreamData {
  id: string;
  stream_id: string;
  source_swarm_id: string;
  source_agent_id?: string;
  name?: string;
  status?: string;
  publish_branch?: string;
  task_resource_id?: string;
  task_node_id?: string;
  commit_count?: number;
  open_conflict_count?: number;
  last_event_at?: string;
  parent_stream_id?: string;
}

/**
 * React Query shape returned by `useCascadeStreamDetail`
 * (`['cascade-stream-detail', streamRowId]`). Shape is open
 * (`Record<string, unknown>`) at the hook level, so we narrow locally.
 */
interface CachedStreamDetail {
  data?: {
    id?: string;
    stream_id?: string;
    source_swarm_id?: string;
    source_agent_id?: string;
    name?: string;
    status?: string;
    publish_branch?: string;
    task_resource_id?: string | null;
    task_node_id?: string | null;
    commit_count?: number;
    open_conflict_count?: number;
    last_event_at?: string;
    parent_stream_id?: string | null;
  };
}

function identity(d: StreamData): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      id: d.id,
      stream_id: d.stream_id,
      source_swarm_id: d.source_swarm_id,
    }).filter(([, v]) => typeof v === 'string' && v.length > 0),
  );
}

function buildAttrs(d: StreamData, stale: boolean): Record<string, string> {
  const attrs: Record<string, string> = {
    kind: 'openhive:stream',
    ...identity(d),
  };
  if (stale) attrs.stale = 'true';
  return attrs;
}

function formatBody(d: StreamData): string {
  const rows: Array<[string, string]> = [
    ['ID', `\`${d.id}\``],
    ['Stream', `\`${d.stream_id}\``],
  ];
  if (d.name) rows.push(['Name', d.name]);
  if (d.status) rows.push(['Status', d.status]);
  if (d.publish_branch) rows.push(['Branch', `\`${d.publish_branch}\``]);
  if (d.source_agent_id) rows.push(['Source agent', `\`${d.source_agent_id}\``]);
  if (d.task_resource_id && d.task_node_id) {
    rows.push([
      'Linked task',
      `\`${d.task_resource_id}/${d.task_node_id}\``,
    ]);
  }
  if (typeof d.commit_count === 'number') {
    rows.push(['Commits', String(d.commit_count)]);
  }
  if (typeof d.open_conflict_count === 'number' && d.open_conflict_count > 0) {
    rows.push(['Open conflicts', String(d.open_conflict_count)]);
  }
  if (d.parent_stream_id) {
    rows.push(['Parent', `\`${d.parent_stream_id}\``]);
  }
  if (d.last_event_at) rows.push(['Last event', d.last_event_at]);

  const lines = ['| Field | Value |', '|---|---|'];
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
  return lines.join('\n');
}

function projectCachedStream(
  cached: CachedStreamDetail,
  fallback: StreamData,
): StreamData | null {
  const d = cached.data;
  if (!d || !d.id) return null;
  return {
    id: d.id,
    stream_id: d.stream_id ?? fallback.stream_id,
    source_swarm_id: d.source_swarm_id ?? fallback.source_swarm_id,
    source_agent_id: d.source_agent_id ?? fallback.source_agent_id,
    name: d.name ?? fallback.name,
    status: d.status ?? fallback.status,
    publish_branch: d.publish_branch ?? fallback.publish_branch,
    task_resource_id: d.task_resource_id ?? fallback.task_resource_id,
    task_node_id: d.task_node_id ?? fallback.task_node_id,
    commit_count: d.commit_count ?? fallback.commit_count,
    open_conflict_count: d.open_conflict_count ?? fallback.open_conflict_count,
    last_event_at: d.last_event_at ?? fallback.last_event_at,
    parent_stream_id: d.parent_stream_id ?? fallback.parent_stream_id,
  };
}

registerContextType<StreamData>({
  type: 'stream',
  kind: 'openhive:stream',
  description:
    'A git-cascade stream: a branch workstream carrying commits toward a merge target.',
  icon: '🌿',
  label: (d) => `Stream: ${d.name ?? d.stream_id}`,
  identity,
  format: (d, flags) =>
    fencedBlock(
      'context',
      buildAttrs(d, Boolean(flags?.stale)),
      formatBody(d),
    ),
  live: async (d, { queryClient, signal }) => {
    const cached = queryClient.getQueryData<CachedStreamDetail>([
      'cascade-stream-detail',
      d.id,
    ]);
    if (cached) {
      return projectCachedStream(cached, d);
    }
    const fetched = await queryClient.fetchQuery<CachedStreamDetail>({
      queryKey: ['cascade-stream-detail', d.id],
      signal,
    });
    if (!fetched) return null;
    return projectCachedStream(fetched, d);
  },
});

export function streamContextItem(
  stream: StreamData,
  opts: { primary?: boolean } = {},
): ChatFabContextItem & { type: 'stream'; data: StreamData } {
  return {
    type: 'stream',
    label: `Stream: ${stream.name ?? stream.stream_id}`,
    data: stream,
    primary: opts.primary,
  };
}
