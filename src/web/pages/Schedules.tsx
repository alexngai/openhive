import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Pause, Play, AlertTriangle, Plus } from 'lucide-react';
import clsx from 'clsx';
import cronstrue from 'cronstrue';
import {
  useSchedules,
  getPayloadKind,
  type Schedule,
  type DispatchSpecPayload,
  type DispatchPromptPayload,
} from '../hooks/useSchedules';
import { useSchedulesRealtime } from '../hooks/useSchedulesRealtime';
import { TimeAgo } from '../components/common/TimeAgo';
import { ListFilters, useDebouncedValue, matchesSearch } from '../components/common/ListFilters';
import { CreateScheduleModal } from '../components/schedules/CreateScheduleModal';

export function Schedules() {
  const [showCreate, setShowCreate] = useState(false);
  const [pausedFilter, setPausedFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search);

  useSchedulesRealtime();

  const { data, isLoading, error } = useSchedules({
    paused: pausedFilter === 'all' ? undefined : pausedFilter === 'paused',
  });

  const schedules = data?.data ?? [];

  const filtered = useMemo(
    () =>
      schedules.filter((s) => {
        const kind = getPayloadKind(s.payload);
        const extras: string[] =
          kind === 'dispatch_prompt'
            ? [(s.payload as DispatchPromptPayload).prompt]
            : [
                (s.payload as DispatchSpecPayload).spec_ref.spec_id,
                (s.payload as DispatchSpecPayload).spec_ref.resource_id,
              ];
        return matchesSearch(
          q,
          s.id,
          s.cron,
          ...extras,
          ...(s.payload.target_swarm_ids ?? []),
        );
      }),
    [schedules, q],
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1
            className="flex items-center gap-2 text-2xl font-bold"
            style={{ color: 'var(--color-text)' }}
          >
            <Clock className="h-6 w-6 text-honey-500" />
            Schedules
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Cron-style recurring dispatches. Each fire produces one queued dispatch per target swarm.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-md bg-honey-500 px-3 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-honey-400"
        >
          <Plus className="h-4 w-4" />
          New schedule
        </button>
      </div>

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        placeholder="Search schedules…"
        right={
          <div className="flex items-center gap-1.5 text-xs">
            {(['all', 'active', 'paused'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setPausedFilter(v)}
                className={clsx(
                  'rounded-md px-2.5 py-1 transition-colors',
                  pausedFilter === v
                    ? 'bg-honey-500/15 text-honey-300 ring-1 ring-honey-500/30'
                    : 'text-zinc-400 hover:text-zinc-200',
                )}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        }
      />

      {isLoading && (
        <div className="mt-6 text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Loading schedules…
        </div>
      )}
      {error && (
        <div className="mt-6 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          Failed to load schedules: {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="mt-12 rounded-lg border border-dashed border-zinc-700 p-8 text-center text-sm" style={{ color: 'var(--color-text-muted)' }}>
          {schedules.length === 0
            ? 'No schedules yet. Click "New schedule" to create one.'
            : 'No schedules match the current filters.'}
        </div>
      )}

      {filtered.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-lg border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/50">
              <tr className="text-left text-xs uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                <th className="px-4 py-2 font-medium">Cron</th>
                <th className="px-4 py-2 font-medium">Spec</th>
                <th className="px-4 py-2 font-medium">Targets</th>
                <th className="px-4 py-2 font-medium">Next fire</th>
                <th className="px-4 py-2 font-medium">Last fired</th>
                <th className="px-4 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {filtered.map((s) => (
                <ScheduleRow key={s.id} schedule={s} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateScheduleModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}

function ScheduleRow({ schedule }: { schedule: Schedule }) {
  const targets = schedule.payload.target_swarm_ids ?? [];
  const kind = getPayloadKind(schedule.payload);
  let cronDescription = '';
  try {
    cronDescription = cronstrue.toString(schedule.cron, { use24HourTimeFormat: false });
  } catch {
    /* keep empty if invalid */
  }
  return (
    <tr
      className="cursor-pointer transition-colors hover:bg-zinc-900/40"
      onClick={() => {
        window.location.href = `/schedules/${schedule.id}`;
      }}
    >
      <td className="px-4 py-3 text-xs">
        <Link
          to={`/schedules/${schedule.id}`}
          className="font-mono text-honey-400 hover:text-honey-300"
          onClick={(e) => e.stopPropagation()}
        >
          {schedule.cron}
        </Link>
        {cronDescription && (
          <div className="mt-0.5 text-[10px] italic text-zinc-400">{cronDescription}</div>
        )}
        {schedule.timezone && (
          <div className="text-[10px] text-zinc-500">{schedule.timezone}</div>
        )}
      </td>
      <td className="px-4 py-3 text-xs">
        {kind === 'dispatch_prompt' ? (
          <>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">prompt</div>
            <div className="line-clamp-2 text-xs text-zinc-300">
              {(schedule.payload as DispatchPromptPayload).prompt}
            </div>
          </>
        ) : (
          <>
            <div className="font-mono">
              {(schedule.payload as DispatchSpecPayload).spec_ref.spec_id}
            </div>
            <div className="text-[10px] text-zinc-500">
              {(schedule.payload as DispatchSpecPayload).spec_ref.resource_id}
            </div>
          </>
        )}
      </td>
      <td className="px-4 py-3 text-xs">
        {targets.length === 1
          ? <span className="font-mono">{targets[0]}</span>
          : <span className="text-zinc-300">{targets.length} swarms</span>}
      </td>
      <td className="px-4 py-3 text-xs">
        {schedule.next_fires_at ? (
          <TimeAgo date={schedule.next_fires_at} />
        ) : (
          <span className="text-zinc-500">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs">
        {schedule.last_fired_at ? (
          <TimeAgo date={schedule.last_fired_at} />
        ) : (
          <span className="text-zinc-500">never</span>
        )}
      </td>
      <td className="px-4 py-3">
        {schedule.paused ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-700/50 px-2 py-0.5 text-xs text-zinc-300">
            <Pause className="h-3 w-3" />
            Paused
            {schedule.pause_reason && (
              <span title={schedule.pause_reason}>
                <AlertTriangle className="ml-0.5 h-3 w-3 text-amber-400" />
              </span>
            )}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300">
            <Play className="h-3 w-3" />
            Active
          </span>
        )}
      </td>
    </tr>
  );
}
