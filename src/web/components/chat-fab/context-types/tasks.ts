/**
 * Tasks context type — registers a bulleted task list as a single
 * context item (aggregate, not per-task).
 *
 * The agent receives a `<context kind="openhive:tasks" count="N">` block
 * with a bullet line per task: `[status] id — title`.
 */

import type { ChatFabContextItem } from '../chat-fab-item';
import { registerContextType } from '../context-registry';
import { fencedBlock } from '../fenced-block';

export interface TaskRef {
  id: string;
  title?: string;
  status?: string;
}

export interface TasksData {
  tasks: TaskRef[];
}

const identity = (d: TasksData): Record<string, string> => ({
  count: String(d.tasks.length),
});

function formatBody(d: TasksData): string {
  if (d.tasks.length === 0) return '_No tasks_';
  return d.tasks
    .map((t) => {
      const status = t.status ? `[${t.status}] ` : '';
      return `- ${status}\`${t.id}\` — ${t.title ?? '(untitled)'}`;
    })
    .join('\n');
}

function buildAttrs(d: TasksData, stale: boolean): Record<string, string> {
  const attrs: Record<string, string> = {
    kind: 'openhive:tasks',
    ...identity(d),
  };
  if (stale) attrs.stale = 'true';
  return attrs;
}

// No `live` loader on `tasks` — the aggregate is built at page-mount time
// from the page's linked-tasks list; individual-task live-refresh during
// Send is premature. If any task mutates between staging and Send, we
// accept the staged snapshot. Step-7 decision per brief.
registerContextType<TasksData>({
  type: 'tasks',
  kind: 'openhive:tasks',
  description: 'A bulleted list of linked tasks from the current page.',
  icon: '📋',
  label: (d) => `Linked tasks (${d.tasks.length})`,
  identity,
  format: (d, flags) =>
    fencedBlock(
      'context',
      buildAttrs(d, Boolean(flags?.stale)),
      formatBody(d),
    ),
});

export function tasksContextItem(
  tasks: TaskRef[],
  opts: { primary?: boolean } = {},
): ChatFabContextItem & { type: 'tasks'; data: TasksData } {
  return {
    type: 'tasks',
    label: `Linked tasks (${tasks.length})`,
    data: { tasks },
    primary: opts.primary,
  };
}
