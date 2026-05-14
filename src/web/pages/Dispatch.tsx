import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Send, Zap, FileText, User, Bot, Loader2, CheckCircle2, XCircle, Clock, Ban } from 'lucide-react';
import clsx from 'clsx';
import { useDispatchList, type DispatchStatus } from '../hooks/useDispatch';
import { useDispatchRealtime } from '../hooks/useDispatchRealtime';
import { useMapSwarmsForPicker } from '../hooks/useApi';
import { DispatchStatusChip } from '../components/dispatch/DispatchStatusChip';
import { JobsTabs } from '../components/dispatch/JobsTabs';
import { TimeAgo } from '../components/common/TimeAgo';
import { ListFilters, useDebouncedValue, matchesSearch } from '../components/common/ListFilters';
import { EmptyState } from '../components/common/EmptyState';

const ALL_STATUSES: DispatchStatus[] = ['queued', 'running', 'complete', 'failed', 'cancelled'];

const STATUS_META: Record<DispatchStatus, { label: string; Icon: React.ElementType; tone: string }> = {
  queued:    { label: 'Queued',    Icon: Clock,         tone: 'text-slate-400' },
  running:   { label: 'Running',   Icon: Loader2,       tone: 'text-amber-400' },
  complete:  { label: 'Complete',  Icon: CheckCircle2,  tone: 'text-emerald-400' },
  failed:    { label: 'Failed',    Icon: XCircle,       tone: 'text-red-400' },
  cancelled: { label: 'Cancelled', Icon: Ban,           tone: 'text-zinc-400' },
};

export function Dispatch() {
  const [statusFilter, setStatusFilter] = useState<Set<DispatchStatus>>(new Set());
  const [swarmFilter, setSwarmFilter] = useState<string>('');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search);

  useDispatchRealtime();
  const { data: swarms = [] } = useMapSwarmsForPicker();

  const { data, isLoading, error } = useDispatchList({
    status: statusFilter.size > 0 ? Array.from(statusFilter) : undefined,
    target_swarm_id: swarmFilter || undefined,
  });

  const dispatches = data?.data ?? [];
  const swarmsById = new Map(swarms.map((s) => [s.id, s]));
  // Client-side text search on top of the server-filtered result — matches
  // on dispatch id, spec id, initiator id, and the target swarm's name so
  // both "disp_abc…" and "dev-swarm" queries find the row.
  const filtered = useMemo(
    () =>
      dispatches.filter((d) =>
        matchesSearch(
          q,
          d.id,
          d.spec_id,
          d.initiator_id,
          swarmsById.get(d.target_swarm_id)?.name ?? d.target_swarm_id,
        ),
      ),
    [dispatches, swarmsById, q],
  );

  const toggleStatus = (s: DispatchStatus) => {
    const next = new Set(statusFilter);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setStatusFilter(next);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-4">
        <h1
          className="flex items-center gap-2 text-2xl font-bold"
          style={{ color: 'var(--color-text)' }}
        >
          <Send className="h-6 w-6 text-honey-500" />
          Jobs
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Work handed off to swarms. Each row is one (spec, swarm) pair.
        </p>
      </div>

      <JobsTabs activeId="one-offs" className="mb-4" />

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        placeholder="Search jobs…"
        count={{ visible: filtered.length, total: dispatches.length, noun: 'job', nounPlural: 'jobs' }}
        right={
          <>
            {ALL_STATUSES.map((s) => {
              const meta = STATUS_META[s];
              const active = statusFilter.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleStatus(s)}
                  aria-pressed={active}
                  className={clsx(
                    'inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors border',
                    active
                      ? `${meta.tone} border-current`
                      : 'border-transparent hover:bg-white/5',
                  )}
                  style={
                    active
                      ? undefined
                      : { color: 'var(--color-text-muted)' }
                  }
                >
                  <meta.Icon className={clsx('h-3 w-3', s === 'running' && active && 'animate-spin')} />
                  {meta.label}
                </button>
              );
            })}
            <select
              value={swarmFilter}
              onChange={(e) => setSwarmFilter(e.target.value)}
              className="px-2 py-1 rounded border bg-transparent text-xs outline-none"
              style={{
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text)',
              }}
              aria-label="Filter by swarm"
            >
              <option value="">All swarms</option>
              {swarms.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </>
        }
      />

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
          Loading jobs…
        </p>
      )}

      {!isLoading && filtered.length === 0 && (
        <EmptyState
          title={
            q
              ? `No jobs match “${q}”.`
              : dispatches.length === 0
                ? 'No jobs match your filter.'
                : 'No jobs match your search.'
          }
          description={dispatches.length === 0 ? 'Open a spec and dispatch it to send work to a swarm.' : undefined}
          size="md"
        />
      )}

      {filtered.length > 0 && (
        <div className="space-y-2">
          {filtered.map((d) => {
            const swarm = swarmsById.get(d.target_swarm_id);
            const InitiatorIcon = d.initiator_type === 'agent' ? Bot : User;
            return (
              <Link
                key={d.id}
                to={`/dispatch/${d.id}`}
                className="block rounded-md border p-3 transition-colors hover:bg-white/5"
                style={{
                  borderColor: 'var(--color-border-subtle)',
                  backgroundColor: 'var(--color-surface)',
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      <span className="font-mono" title={d.id}>
                        {d.id.length > 12 ? `${d.id.slice(0, 12)}…` : d.id}
                      </span>
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
                        {d.initiator_type === 'agent' ? 'agent' : 'user'}
                        <span className="font-mono" title={d.initiator_id}>
                          · {d.initiator_id.length > 10 ? `${d.initiator_id.slice(0, 10)}…` : d.initiator_id}
                        </span>
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
