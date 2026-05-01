/**
 * Session context type — an agent session resource (trajectory + chat).
 *
 * Prose/data hybrid body (§4.5): markdown with project/branch, truncated
 * first-prompt excerpt, checkpoint count, and state. Sourced from the
 * session's SyncableResource + metadata, not a dedicated session-detail
 * endpoint.
 */

import type { ChatFabContextItem } from '../chat-fab-item';
import { registerContextType } from '../context-registry';
import { fencedBlock } from '../fenced-block';

const FIRST_PROMPT_MAX_CHARS = 200;

export interface SessionData {
  id: string;
  name?: string;
  swarm_id?: string;
  project?: string;
  project_path?: string;
  branch?: string;
  first_prompt?: string;
  state?: string;
  checkpoint_count?: number;
  owner_agent_id?: string;
  description?: string | null;
}

/**
 * React Query shape returned by `useResource` (`['resource', id]`).
 * Narrowed locally — session metadata lives under `metadata.*`.
 */
interface CachedResource {
  id?: string;
  name?: string;
  description?: string | null;
  owner_agent_id?: string;
  metadata?: Record<string, unknown> | null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max).trimEnd()}…`;
}

function identity(d: SessionData): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      id: d.id,
      swarm_id: d.swarm_id,
    }).filter(([, v]) => typeof v === 'string' && v.length > 0),
  );
}

function buildAttrs(d: SessionData, stale: boolean): Record<string, string> {
  const attrs: Record<string, string> = {
    kind: 'openhive:session',
    ...identity(d),
  };
  if (stale) attrs.stale = 'true';
  return attrs;
}

function formatBody(d: SessionData): string {
  const lines: string[] = [];
  if (d.name) lines.push(`**${d.name}**`);
  if (d.project) {
    const projectLine = d.project_path
      ? `\`${d.project}\` — \`${d.project_path}\``
      : `\`${d.project}\``;
    lines.push(`- Project: ${projectLine}`);
  }
  if (d.branch) lines.push(`- Branch: \`${d.branch}\``);
  if (d.state) lines.push(`- State: \`${d.state}\``);
  if (typeof d.checkpoint_count === 'number') {
    lines.push(`- Checkpoints: ${d.checkpoint_count}`);
  }
  if (d.owner_agent_id) lines.push(`- Owner: \`${d.owner_agent_id}\``);
  if (d.first_prompt) {
    const excerpt = truncate(d.first_prompt, FIRST_PROMPT_MAX_CHARS);
    lines.push('', '> ' + excerpt.replace(/\n+/g, ' '));
  }
  if (lines.length === 0) return `- ID: \`${d.id}\``;
  return lines.join('\n');
}

function projectCachedSession(
  cached: CachedResource,
  fallback: SessionData,
): SessionData | null {
  if (!cached || !cached.id) return null;
  const meta = (cached.metadata ?? {}) as Record<string, unknown>;
  const readStr = (k: string): string | undefined => {
    const v = meta[k];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  const readNum = (k: string): number | undefined => {
    const v = meta[k];
    return typeof v === 'number' ? v : undefined;
  };
  return {
    id: cached.id,
    name: cached.name ?? fallback.name,
    swarm_id: readStr('source_swarm_id') ?? fallback.swarm_id,
    project: readStr('project') ?? fallback.project,
    project_path: readStr('project_path') ?? fallback.project_path,
    branch: readStr('branch') ?? fallback.branch,
    first_prompt: readStr('first_prompt') ?? fallback.first_prompt,
    state: readStr('state') ?? fallback.state,
    checkpoint_count: readNum('checkpoint_count') ?? fallback.checkpoint_count,
    owner_agent_id: cached.owner_agent_id ?? fallback.owner_agent_id,
    description: cached.description ?? fallback.description,
  };
}

registerContextType<SessionData>({
  type: 'session',
  kind: 'openhive:session',
  description:
    'An agent session resource — checkpoints, trajectory, optional ACP stream.',
  icon: '💬',
  label: (d) => `Session: ${d.name ?? d.id}`,
  identity,
  format: (d, flags) =>
    fencedBlock(
      'context',
      buildAttrs(d, Boolean(flags?.stale)),
      formatBody(d),
    ),
  live: async (d, { queryClient, signal }) => {
    const cached = queryClient.getQueryData<CachedResource>(['resource', d.id]);
    if (cached) {
      return projectCachedSession(cached, d);
    }
    const fetched = await queryClient.fetchQuery<CachedResource>({
      queryKey: ['resource', d.id],
      signal,
    });
    if (!fetched) return null;
    return projectCachedSession(fetched, d);
  },
});

export function sessionContextItem(
  session: SessionData,
  opts: { primary?: boolean } = {},
): ChatFabContextItem & { type: 'session'; data: SessionData } {
  return {
    type: 'session',
    label: `Session: ${session.name ?? session.id}`,
    data: session,
    primary: opts.primary,
  };
}
