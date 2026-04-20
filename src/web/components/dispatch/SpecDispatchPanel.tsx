import { Link } from 'react-router-dom';
import { Send, Zap } from 'lucide-react';
import { useDispatchList } from '../../hooks/useDispatch';
import { useDispatchRealtime } from '../../hooks/useDispatchRealtime';
import { useMapSwarms } from '../../hooks/useApi';
import { DispatchStatusChip } from './DispatchStatusChip';
import { TimeAgo } from '../common/TimeAgo';

interface SpecDispatchPanelProps {
  resourceId: string;
  specId: string;
}

/**
 * Sidebar panel listing dispatches for one (resource_id, spec_id) pair.
 * Used by SpecDetail; subscribes to realtime so a dispatch from elsewhere
 * (the modal, an autonomous agent, etc.) shows up here without refresh.
 */
export function SpecDispatchPanel({ resourceId, specId }: SpecDispatchPanelProps) {
  useDispatchRealtime();
  const { data, isLoading } = useDispatchList({
    spec_resource_id: resourceId,
    spec_id: specId,
    limit: 50,
  });
  const { data: swarms = [] } = useMapSwarms();
  const swarmsById = new Map(swarms.map((s) => [s.id, s.name]));

  const dispatches = data?.data ?? [];

  return (
    <div
      className="rounded-md border"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <div className="flex items-center gap-2">
          <Send className="h-4 w-4 text-honey-500" />
          <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            Dispatch
          </h3>
        </div>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {dispatches.length}
        </span>
      </div>

      {isLoading ? (
        <div className="px-3 py-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Loading…
        </div>
      ) : dispatches.length === 0 ? (
        <div className="px-3 py-3 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          No dispatches yet
        </div>
      ) : (
        <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
          {dispatches.map((d) => (
            <li
              key={d.id}
              className="px-3 py-2"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              <Link
                to={`/dispatch/${d.id}`}
                className="flex items-center justify-between gap-2 hover:opacity-80"
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="text-xs font-mono truncate"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {d.id}
                  </div>
                  <div
                    className="flex items-center gap-1 text-xs mt-0.5"
                    style={{ color: 'var(--color-text-secondary)' }}
                  >
                    <Zap className="h-3 w-3 text-honey-500" />
                    <span className="truncate">
                      {swarmsById.get(d.target_swarm_id) ?? d.target_swarm_id}
                    </span>
                    <span style={{ color: 'var(--color-text-muted)' }}>·</span>
                    <TimeAgo date={d.created_at} className="text-xs" />
                  </div>
                </div>
                <DispatchStatusChip status={d.status} className="shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
