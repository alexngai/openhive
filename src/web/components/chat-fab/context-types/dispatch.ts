/**
 * Dispatch context type — a dispatched unit of work (spec → swarm).
 *
 * Data-type body (§4.5): fenced wrapper carries identity attrs, the inner
 * body is a Markdown key-value table. Per decision F7, `latest_attempt`
 * rides on the dispatch payload as a derived field, not a new context
 * type — consumers pass `attempts_history[attempts_history.length - 1]`.
 */

import type { ChatFabContextItem } from '../chat-fab-item';
import { registerContextType } from '../context-registry';
import { fencedBlock } from '../fenced-block';

export interface DispatchAttemptRef {
  attempt: number;
  status: 'running' | 'completed' | 'failed' | 'retrying';
  started_at?: string;
  error?: string;
}

export interface DispatchData {
  id: string;
  spec_id: string;
  target_swarm_id: string;
  status?: string;
  created_at?: string;
  /** Derived — consumers pass `attempts_history[attempts_history.length - 1]`. */
  latest_attempt?: DispatchAttemptRef;
}

/**
 * React Query shape returned by `useDispatch` (`['dispatch', id]`).
 * Narrowed locally — we don't want to lock in the hook's public type in
 * this registry file.
 */
interface CachedDispatchDetail {
  dispatch?: {
    id?: string;
    spec_id?: string;
    target_swarm_id?: string;
    status?: string;
    created_at?: string;
    attempts_history?: Array<{
      attempt: number;
      status: 'running' | 'completed' | 'failed' | 'retrying';
      started_at?: string;
      error?: string;
    }>;
  };
}

/**
 * Identity attrs — required for agent actions (update dispatch, reference
 * in tool calls). Empty/undefined values are dropped so attrs never emit
 * `key=""`.
 */
function identity(d: DispatchData): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      id: d.id,
      spec_id: d.spec_id,
      target_swarm_id: d.target_swarm_id,
    }).filter(([, v]) => typeof v === 'string' && v.length > 0),
  );
}

function buildAttrs(d: DispatchData, stale: boolean): Record<string, string> {
  const attrs: Record<string, string> = {
    kind: 'openhive:dispatch',
    ...identity(d),
  };
  if (stale) attrs.stale = 'true';
  return attrs;
}

function formatLatestAttempt(a: DispatchAttemptRef): string {
  const head = `[\`attempt-${a.attempt}\`] ${a.status}`;
  return a.error ? `${head} — ${a.error}` : head;
}

function formatBody(d: DispatchData): string {
  const rows: Array<[string, string]> = [['ID', `\`${d.id}\``]];
  if (d.spec_id) rows.push(['Spec', `\`${d.spec_id}\``]);
  if (d.status) rows.push(['Status', d.status]);
  if (d.target_swarm_id) rows.push(['Swarm', `\`${d.target_swarm_id}\``]);
  if (d.created_at) rows.push(['Started', d.created_at]);
  if (d.latest_attempt) {
    rows.push(['Latest attempt', formatLatestAttempt(d.latest_attempt)]);
  }

  const lines = ['| Field | Value |', '|---|---|'];
  for (const [k, v] of rows) lines.push(`| ${k} | ${v} |`);
  return lines.join('\n');
}

function projectCachedDispatch(
  cached: CachedDispatchDetail,
  fallback: DispatchData,
): DispatchData | null {
  const d = cached.dispatch;
  if (!d || !d.id) return null;
  const latest = d.attempts_history?.[d.attempts_history.length - 1];
  return {
    id: d.id,
    spec_id: d.spec_id ?? fallback.spec_id,
    target_swarm_id: d.target_swarm_id ?? fallback.target_swarm_id,
    status: d.status ?? fallback.status,
    created_at: d.created_at ?? fallback.created_at,
    latest_attempt: latest
      ? {
          attempt: latest.attempt,
          status: latest.status,
          started_at: latest.started_at,
          error: latest.error,
        }
      : fallback.latest_attempt,
  };
}

registerContextType<DispatchData>({
  type: 'dispatch',
  kind: 'openhive:dispatch',
  description:
    'A dispatched unit of work: a spec routed to a target swarm for execution.',
  icon: '🚀',
  label: (d) => `Dispatch: ${d.id.slice(0, 8)}…`,
  identity,
  format: (d, flags) =>
    fencedBlock(
      'context',
      buildAttrs(d, Boolean(flags?.stale)),
      formatBody(d),
    ),
  live: async (d, { queryClient, signal }) => {
    const cached = queryClient.getQueryData<CachedDispatchDetail>([
      'dispatch',
      d.id,
    ]);
    if (cached) {
      return projectCachedDispatch(cached, d);
    }
    const fetched = await queryClient.fetchQuery<CachedDispatchDetail>({
      queryKey: ['dispatch', d.id],
      signal,
    });
    if (!fetched) return null;
    return projectCachedDispatch(fetched, d);
  },
});

export function dispatchContextItem(
  dispatch: DispatchData,
  opts: { primary?: boolean } = {},
): ChatFabContextItem & { type: 'dispatch'; data: DispatchData } {
  return {
    type: 'dispatch',
    label: `Dispatch: ${dispatch.id.slice(0, 8)}…`,
    data: dispatch,
    primary: opts.primary,
  };
}
