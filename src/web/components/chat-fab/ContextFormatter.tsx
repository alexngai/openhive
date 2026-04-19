/**
 * Context Formatter — converts context items into markdown chat messages
 */

import type { ChatFabContextItem } from './ChatFabContext';

const TYPE_EMOJI: Record<string, string> = {
  spec: '📄',
  tasks: '📋',
  dispatch: '🚀',
  swarm: '⚡',
  session: '💬',
  task: '☑️',
  context: '📎',
  custom: '📎',
};

export function formatContextItem(item: ChatFabContextItem): string {
  const emoji = TYPE_EMOJI[item.type] ?? '📎';
  const lines: string[] = [];

  lines.push(`${emoji} **Shared context — ${item.label}**`);
  lines.push('');

  switch (item.type) {
    case 'spec': {
      const d = item.data;
      if (d.title) lines.push(`# ${d.title}`);
      if (d.content) lines.push(String(d.content));
      if (d.id) lines.push(`\n_Spec ID: \`${d.id}\`_`);
      break;
    }
    case 'tasks': {
      const tasks = (item.data.tasks ?? item.data) as Array<{
        id?: string; title?: string; status?: string;
      }>;
      if (Array.isArray(tasks) && tasks.length > 0) {
        lines.push('## Tasks');
        for (const t of tasks) {
          const status = t.status ? `[${t.status}] ` : '';
          lines.push(`- ${status}\`${t.id ?? '?'}\` — ${t.title ?? '(untitled)'}`);
        }
      } else {
        lines.push('_No tasks_');
      }
      break;
    }
    case 'task': {
      const d = item.data;
      const status = d.status ? `[${d.status}] ` : '';
      lines.push(`${status}\`${d.id ?? '?'}\` — ${d.title ?? '(untitled)'}`);
      if (d.content) lines.push(String(d.content));
      break;
    }
    case 'dispatch': {
      const d = item.data;
      lines.push(`| Field | Value |`);
      lines.push(`|---|---|`);
      if (d.id) lines.push(`| ID | \`${d.id}\` |`);
      if (d.spec_id) lines.push(`| Spec | \`${d.spec_id}\` |`);
      if (d.status) lines.push(`| Status | ${d.status} |`);
      if (d.target_swarm_id) lines.push(`| Swarm | \`${d.target_swarm_id}\` |`);
      break;
    }
    case 'swarm': {
      const d = item.data;
      lines.push(`**${d.name ?? 'Unknown swarm'}**`);
      if (d.status) lines.push(`Status: ${d.status}`);
      if (d.id) lines.push(`ID: \`${d.id}\``);
      break;
    }
    case 'session': {
      const d = item.data;
      lines.push(`Session: \`${d.id ?? d.sessionId ?? '?'}\``);
      if (d.project) lines.push(`Project: ${d.project}`);
      break;
    }
    default: {
      // Generic: dump as key-value pairs
      for (const [key, val] of Object.entries(item.data)) {
        if (val !== null && val !== undefined) {
          lines.push(`- **${key}**: ${typeof val === 'string' ? val : JSON.stringify(val)}`);
        }
      }
    }
  }

  return lines.join('\n');
}
