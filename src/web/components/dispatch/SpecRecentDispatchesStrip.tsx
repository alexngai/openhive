import { Link } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { useDispatches } from '../../hooks/useDispatches';
import { useDispatchesRealtime } from '../../hooks/useDispatchesRealtime';
import { useMapSwarms } from '../../hooks/useApi';
import { DispatchStatusChip } from './DispatchStatusChip';
import { TimeAgo } from '../common/TimeAgo';

/** How many dispatches to surface inline before the "see all" affordance
 *  points the user at the sidebar panel / Dispatches list. Three feels
 *  right — a row strip stays scannable, and the full history is always one
 *  click away in the sidebar panel. */
const INLINE_LIMIT = 3;

interface Props {
  resourceId: string;
  specId: string;
}

/**
 * Horizontal strip surfacing recent dispatches for a spec, planted under
 * the spec title on SpecDetail. Complements the sidebar SpecDispatchesPanel
 * (full history) — readers who just authored a spec usually want the
 * recent-3 visible without scanning the sidebar.
 *
 * Renders nothing when the spec has no dispatches yet; the sidebar panel
 * already handles the "no dispatches" copy.
 */
export function SpecRecentDispatchesStrip({ resourceId, specId }: Props) {
  useDispatchesRealtime();
  const { data } = useDispatches({
    spec_resource_id: resourceId,
    spec_id: specId,
    limit: INLINE_LIMIT,
  });
  const { data: swarms = [] } = useMapSwarms();
  const swarmsById = new Map(swarms.map((s) => [s.id, s.name]));

  const dispatches = data?.data ?? [];
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
          to={`/dispatches/${d.id}`}
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
    </div>
  );
}
