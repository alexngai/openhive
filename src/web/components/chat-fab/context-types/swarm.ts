/**
 * Swarm context type — a MAP-registered swarm (hosted or externally
 * connected). Data-type body (§4.5): identity attrs on the wrapper, body
 * is a key-value block with status, presence counts, and last seen.
 */

import type { ChatFabContextItem } from '../chat-fab-item';
import { registerContextType } from '../context-registry';
import { fencedBlock } from '../fenced-block';

export interface SwarmData {
  id: string;
  name?: string;
  status?: 'online' | 'offline' | 'unreachable' | string;
  agent_count?: number;
  registered_agent_count?: number;
  last_seen_at?: string | null;
  description?: string | null;
}

/**
 * React Query shape returned by `useMapSwarm` (`['map-swarm', id]`).
 * Narrowed locally.
 */
interface CachedMapSwarm {
  id?: string;
  name?: string;
  status?: string;
  agent_count?: number;
  last_seen_at?: string | null;
  description?: string | null;
  registered_agents?: Array<{ id?: string }>;
}

function identity(d: SwarmData): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      id: d.id,
    }).filter(([, v]) => typeof v === 'string' && v.length > 0),
  );
}

function buildAttrs(d: SwarmData, stale: boolean): Record<string, string> {
  const attrs: Record<string, string> = {
    kind: 'openhive:swarm',
    ...identity(d),
  };
  if (stale) attrs.stale = 'true';
  return attrs;
}

function formatBody(d: SwarmData): string {
  const rows: Array<[string, string]> = [['ID', `\`${d.id}\``]];
  if (d.name) rows.push(['Name', d.name]);
  if (d.status) rows.push(['Status', d.status]);
  if (typeof d.agent_count === 'number') {
    rows.push(['Agents (total)', String(d.agent_count)]);
  }
  if (typeof d.registered_agent_count === 'number') {
    rows.push(['Registered agents', String(d.registered_agent_count)]);
  }
  if (d.last_seen_at) rows.push(['Last seen', d.last_seen_at]);
  if (d.description) rows.push(['Description', d.description]);

  const lines = ['| Field | Value |', '|---|---|'];
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
  return lines.join('\n');
}

function projectCachedSwarm(
  cached: CachedMapSwarm,
  fallback: SwarmData,
): SwarmData | null {
  if (!cached || !cached.id) return null;
  return {
    id: cached.id,
    name: cached.name ?? fallback.name,
    status: cached.status ?? fallback.status,
    agent_count: cached.agent_count ?? fallback.agent_count,
    registered_agent_count:
      cached.registered_agents?.length ?? fallback.registered_agent_count,
    last_seen_at: cached.last_seen_at ?? fallback.last_seen_at,
    description: cached.description ?? fallback.description,
  };
}

registerContextType<SwarmData>({
  type: 'swarm',
  kind: 'openhive:swarm',
  description: 'A MAP-registered swarm (hosted or externally connected).',
  icon: '🐝',
  label: (d) => `Swarm: ${d.name ?? d.id}`,
  identity,
  format: (d, flags) =>
    fencedBlock(
      'context',
      buildAttrs(d, Boolean(flags?.stale)),
      formatBody(d),
    ),
  live: async (d, { queryClient, signal }) => {
    const cached = queryClient.getQueryData<CachedMapSwarm>([
      'map-swarm',
      d.id,
    ]);
    if (cached) {
      return projectCachedSwarm(cached, d);
    }
    const fetched = await queryClient.fetchQuery<CachedMapSwarm>({
      queryKey: ['map-swarm', d.id],
      signal,
    });
    if (!fetched) return null;
    return projectCachedSwarm(fetched, d);
  },
});

export function swarmContextItem(
  swarm: SwarmData,
  opts: { primary?: boolean } = {},
): ChatFabContextItem & { type: 'swarm'; data: SwarmData } {
  return {
    type: 'swarm',
    label: `Swarm: ${swarm.name ?? swarm.id}`,
    data: swarm,
    primary: opts.primary,
  };
}
