import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { GitBranch, Zap } from 'lucide-react';
import { useDispatchList } from '../../hooks/useDispatch';
import { useDispatchRealtime } from '../../hooks/useDispatchRealtime';
import { useMapSwarms, useCascadeDAG, useSessionsList } from '../../hooks/useApi';
import { DispatchStatusChip } from './DispatchStatusChip';
import { TimeAgo } from '../common/TimeAgo';

/** How many dispatches to surface inline before the "see all" affordance
 *  points the user at the sidebar panel / Dispatch list. Three feels
 *  right — a row strip stays scannable, and the full history is always one
 *  click away in the sidebar panel. */
const INLINE_LIMIT = 3;

interface Props {
  resourceId: string;
  specId: string;
}

/**
 * Horizontal strip surfacing recent dispatches for a spec, planted under
 * the spec title on SpecDetail. Complements the sidebar SpecDispatchPanel
 * (full history) — readers who just authored a spec usually want the
 * recent-3 visible without scanning the sidebar.
 *
 * Renders nothing when the spec has no dispatches yet; the sidebar panel
 * already handles the "no dispatches" copy.
 */
export function SpecRecentDispatchStrip({ resourceId, specId }: Props) {
  useDispatchRealtime();
  const { data } = useDispatchList({
    spec_resource_id: resourceId,
    spec_id: specId,
    limit: INLINE_LIMIT,
  });
  const { data: swarms = [] } = useMapSwarms();
  const swarmsById = new Map(swarms.map((s) => [s.id, s.name]));

  const dispatches = data?.data ?? [];

  // "Changes opened" heuristic — scoped to the most-recent dispatch's target
  // swarm to keep this a single extra cascade/sessions query pair. Multi-swarm
  // specs under-count; the /changes page is always one click away for the
  // full picture.
  const primarySwarmId = dispatches[0]?.target_swarm_id;
  const { data: cascadeResp } = useCascadeDAG({ source_swarm_id: primarySwarmId });
  const { data: sessionsResp } = useSessionsList({ swarm_id: primarySwarmId, limit: 100 });

  const relatedChangesCount = useMemo(() => {
    if (!primarySwarmId || dispatches.length === 0) return 0;
    const sessionIds = new Set<string>();
    for (const d of dispatches) {
      if (d.target_swarm_id !== primarySwarmId) continue;
      for (const sid of d.session_ids) sessionIds.add(sid);
    }
    const agentIds = new Set<string>();
    for (const s of sessionsResp?.data ?? []) {
      if (sessionIds.has(s.id) && s.acp_target_agent_id) {
        agentIds.add(s.acp_target_agent_id);
      }
    }
    if (agentIds.size === 0) return 0;
    return (cascadeResp?.data?.nodes ?? []).filter((n) => agentIds.has(n.source_agent_id)).length;
  }, [primarySwarmId, dispatches, sessionsResp, cascadeResp]);

  if (dispatches.length === 0) return null;

  const total = data?.total ?? dispatches.length;
  const hasMore = total > dispatches.length;

  return (
    <div className="mt-3 flex items-center gap-2 flex-wrap">
      <span
        className="text-2xs font-medium uppercase tracking-wider shrink-0"
        style={{ color: 'var(--color-text-muted)' }}
      >
        Recent dispatches
      </span>
      {dispatches.map((d) => (
        <Link
          key={d.id}
          to={`/dispatch/${d.id}`}
          className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors hover:bg-white/5 shrink-0"
          style={{
            border: '1px solid var(--color-border-subtle)',
            color: 'var(--color-text-secondary)',
          }}
          title={`Dispatch ${d.id}`}
        >
          <Zap className="h-3 w-3 text-honey-500" />
          <span className="truncate max-w-[160px]">
            {swarmsById.get(d.target_swarm_id) ?? d.target_swarm_id}
          </span>
          <DispatchStatusChip status={d.status} />
          <TimeAgo
            date={d.created_at}
            className="text-2xs"
            style={{ color: 'var(--color-text-muted)' }}
          />
        </Link>
      ))}
      {hasMore && (
        <span
          className="text-2xs"
          style={{ color: 'var(--color-text-muted)' }}
          title="Full history in the sidebar panel"
        >
          +{total - dispatches.length} more
        </span>
      )}
      {relatedChangesCount > 0 && (
        <Link
          to="/changes"
          className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors hover:bg-white/5 shrink-0"
          style={{
            border: '1px solid var(--color-border-subtle)',
            color: 'var(--color-text-secondary)',
          }}
          title="Cascade streams opened by agents that ran these dispatches"
        >
          <GitBranch className="h-3 w-3 text-honey-500" />
          {relatedChangesCount} change{relatedChangesCount === 1 ? '' : 's'} opened
        </Link>
      )}
    </div>
  );
}
