import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Send, Zap, FileText, User, Bot } from 'lucide-react';
import clsx from 'clsx';
import { useDispatches, type DispatchStatus } from '../hooks/useDispatches';
import { useDispatchesRealtime } from '../hooks/useDispatchesRealtime';
import { useMapSwarms } from '../hooks/useApi';
import { DispatchStatusChip } from '../components/dispatch/DispatchStatusChip';
import { TimeAgo } from '../components/common/TimeAgo';

const ALL_STATUSES: DispatchStatus[] = ['queued', 'running', 'complete', 'failed', 'cancelled'];

export function Dispatches() {
  const [statusFilter, setStatusFilter] = useState<Set<DispatchStatus>>(new Set());
  const [swarmFilter, setSwarmFilter] = useState<string>('');

  useDispatchesRealtime();
  const { data: swarms = [] } = useMapSwarms();

  const { data, isLoading, error } = useDispatches({
    status: statusFilter.size > 0 ? Array.from(statusFilter) : undefined,
    target_swarm_id: swarmFilter || undefined,
  });

  const dispatches = data?.data ?? [];
  const swarmsById = new Map(swarms.map((s) => [s.id, s]));

  const toggleStatus = (s: DispatchStatus) => {
    const next = new Set(statusFilter);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setStatusFilter(next);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1
          className="flex items-center gap-2 text-2xl font-bold"
          style={{ color: 'var(--color-text)' }}
        >
          <Send className="h-6 w-6 text-honey-500" />
          Dispatches
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Work handed off to swarms. Each row is one (spec, swarm) pair.
        </p>
      </div>

      {/* Filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Status:
        </span>
        {ALL_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => toggleStatus(s)}
            className={clsx(
              'px-2 py-1 rounded text-xs transition-colors',
              statusFilter.has(s)
                ? 'bg-honey-500/15 text-honey-400 border border-honey-500/40'
                : 'border border-transparent hover:bg-white/5',
            )}
            style={
              !statusFilter.has(s)
                ? { color: 'var(--color-text-secondary)' }
                : undefined
            }
          >
            {s}
          </button>
        ))}

        <span className="text-xs ml-4" style={{ color: 'var(--color-text-muted)' }}>
          Swarm:
        </span>
        <select
          value={swarmFilter}
          onChange={(e) => setSwarmFilter(e.target.value)}
          className="px-2 py-1 rounded border bg-transparent text-xs outline-none"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text)',
          }}
        >
          <option value="">All</option>
          {swarms.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div
          className="mb-4 rounded-md border p-3 text-sm"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text)',
          }}
        >
          Failed to load: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {isLoading && (
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Loading dispatches…
        </p>
      )}

      {!isLoading && dispatches.length === 0 && (
        <div
          className="rounded-md border p-6 text-center"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text-muted)',
          }}
        >
          <p className="text-sm">No dispatches match your filter.</p>
          <p className="mt-1 text-xs">
            Open a spec and click Dispatch to send work to a swarm.
          </p>
        </div>
      )}

      {dispatches.length > 0 && (
        <div className="space-y-2">
          {dispatches.map((d) => {
            const swarm = swarmsById.get(d.target_swarm_id);
            const InitiatorIcon = d.initiator_type === 'agent' ? Bot : User;
            return (
              <Link
                key={d.id}
                to={`/dispatches/${d.id}`}
                className="block rounded-md border p-3 transition-colors hover:bg-white/5"
                style={{
                  borderColor: 'var(--color-border-subtle)',
                  backgroundColor: 'var(--color-surface)',
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      <span className="font-mono">{d.id}</span>
                      <span>·</span>
                      <FileText className="h-3 w-3 text-honey-500" />
                      <span className="font-mono truncate">{d.spec_id}</span>
                    </div>
                    <div className="flex items-center gap-3 text-sm" style={{ color: 'var(--color-text)' }}>
                      <span className="inline-flex items-center gap-1">
                        <Zap className="h-3.5 w-3.5 text-honey-500" />
                        {swarm?.name ?? d.target_swarm_id}
                      </span>
                      <span style={{ color: 'var(--color-text-muted)' }}>·</span>
                      <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                        <InitiatorIcon className="h-3 w-3" />
                        {d.initiator_type === 'agent' ? 'agent' : 'user'} · <span className="font-mono">{d.initiator_id}</span>
                      </span>
                      <span style={{ color: 'var(--color-text-muted)' }}>·</span>
                      <TimeAgo date={d.created_at} className="text-xs" />
                    </div>
                  </div>
                  <DispatchStatusChip status={d.status} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
