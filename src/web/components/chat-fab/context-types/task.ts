/**
 * Task context type (singular) — a single OpenTasks task node.
 *
 * Distinct from the plural `tasks` type: `tasks` renders an aggregate
 * bulleted list across many tasks; `task` renders a detailed view of one
 * task with status, assignee, and edge-list references. TaskDetail pages
 * register this as their primary item.
 *
 * Live loader note (step 9): OpenHive addresses tasks as `(resourceId,
 * nodeId)` pairs and there is no `useTask(resourceId, nodeId)` hook today
 * — TaskDetail reads the full graph via `useOpenTasksGraph(resourceId)`
 * and filters. The live loader projects the graph cache when available
 * (key: `['opentasks-graph', resourceId]`) and otherwise returns the
 * staged snapshot.
 */

import type { ChatFabContextItem } from '../chat-fab-item';
import { registerContextType } from '../context-registry';
import { fencedBlock } from '../fenced-block';

export interface TaskData {
  id: string;
  resource_id: string;
  title?: string;
  description?: string;
  status?: string;
  assignee?: string;
  blocked_by?: string[];
  blocks?: string[];
}

/**
 * React Query shape returned by `useOpenTasksGraph`
 * (`['opentasks-graph', resourceId]`). Narrowed locally.
 */
interface CachedOpenTasksGraph {
  nodes?: Array<{
    id?: string;
    title?: string;
    description?: string;
    status?: string;
    assignee?: string;
  }>;
  edges?: Array<{
    type?: string;
    source?: string;
    target?: string;
  }>;
}

function identity(d: TaskData): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      id: d.id,
      resource_id: d.resource_id,
    }).filter(([, v]) => typeof v === 'string' && v.length > 0),
  );
}

function buildAttrs(d: TaskData, stale: boolean): Record<string, string> {
  const attrs: Record<string, string> = {
    kind: 'openhive:task',
    ...identity(d),
  };
  if (stale) attrs.stale = 'true';
  return attrs;
}

function formatBody(d: TaskData): string {
  const lines: string[] = [];
  if (d.title) lines.push(`**${d.title}**`);
  if (d.description) lines.push('', d.description);
  const meta: string[] = [];
  if (d.status) meta.push(`- Status: \`${d.status}\``);
  if (d.assignee) meta.push(`- Assignee: \`${d.assignee}\``);
  if (d.blocked_by && d.blocked_by.length > 0) {
    meta.push(
      `- Blocked by: ${d.blocked_by.map((id) => `\`${id}\``).join(', ')}`,
    );
  }
  if (d.blocks && d.blocks.length > 0) {
    meta.push(`- Blocks: ${d.blocks.map((id) => `\`${id}\``).join(', ')}`);
  }
  if (meta.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(...meta);
  }
  if (lines.length === 0) return `- ID: \`${d.id}\``;
  return lines.join('\n');
}

function projectCachedTask(
  cached: CachedOpenTasksGraph,
  fallback: TaskData,
): TaskData | null {
  const node = cached.nodes?.find((n) => n.id === fallback.id);
  if (!node || !node.id) return null;
  const edges = cached.edges ?? [];
  // Block edges in opentasks: source blocks target. Reverse for blocked_by.
  const blocks = edges
    .filter((e) => e.type === 'blocks' && e.source === node.id && e.target)
    .map((e) => e.target as string);
  const blocked_by = edges
    .filter((e) => e.type === 'blocks' && e.target === node.id && e.source)
    .map((e) => e.source as string);
  return {
    id: node.id,
    resource_id: fallback.resource_id,
    title: node.title ?? fallback.title,
    description: node.description ?? fallback.description,
    status: node.status ?? fallback.status,
    assignee: node.assignee ?? fallback.assignee,
    blocked_by: blocked_by.length > 0 ? blocked_by : fallback.blocked_by,
    blocks: blocks.length > 0 ? blocks : fallback.blocks,
  };
}

registerContextType<TaskData>({
  type: 'task',
  kind: 'openhive:task',
  description: 'A single task node from an OpenTasks graph.',
  icon: '✅',
  label: (d) => `Task: ${d.title ?? d.id}`,
  identity,
  format: (d, flags) =>
    fencedBlock(
      'context',
      buildAttrs(d, Boolean(flags?.stale)),
      formatBody(d),
    ),
  live: async (d, { queryClient, signal }) => {
    const cached = queryClient.getQueryData<CachedOpenTasksGraph>([
      'opentasks-graph',
      d.resource_id,
    ]);
    if (cached) {
      return projectCachedTask(cached, d);
    }
    const fetched = await queryClient.fetchQuery<CachedOpenTasksGraph>({
      queryKey: ['opentasks-graph', d.resource_id],
      signal,
    });
    if (!fetched) return null;
    return projectCachedTask(fetched, d);
  },
});

export function taskContextItem(
  task: TaskData,
  opts: { primary?: boolean } = {},
): ChatFabContextItem & { type: 'task'; data: TaskData } {
  return {
    type: 'task',
    label: `Task: ${task.title ?? task.id}`,
    data: task,
    primary: opts.primary,
  };
}
