import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Pause, Play, AlertTriangle, Plus, Calendar } from 'lucide-react';
import clsx from 'clsx';
import cronstrue from 'cronstrue';
import {
  useSchedules,
  getPayloadKind,
  type Schedule,
  type DispatchSpecPayload,
  type DispatchPromptPayload,
  type ExperimentRunPayload,
} from '../hooks/useSchedules';
import { useSchedulesRealtime } from '../hooks/useSchedulesRealtime';
import { TimeAgo } from '../components/common/TimeAgo';
import { ListFilters, useDebouncedValue, matchesSearch } from '../components/common/ListFilters';
import { CreateScheduleModal } from '../components/schedules/CreateScheduleModal';
import { JobsTabs } from '../components/dispatch/JobsTabs';
import { StatusChip, type StatusTone } from '../components/common/StatusChip';
import { EmptyState } from '../components/common/EmptyState';

function scheduleStateToChip(active: boolean): { tone: StatusTone; label: string } {
  return active
    ? { tone: 'success', label: 'Active' }
    : { tone: 'neutral', label: 'Paused' };
}

function scheduleSearchTerms(schedule: Schedule): string[] {
  const kind = getPayloadKind(schedule.payload);
  if (kind === 'dispatch_prompt') {
    const payload = schedule.payload as DispatchPromptPayload;
    return [payload.prompt, ...payload.target_swarm_ids];
  }
  if (kind === 'experiment') {
    const payload = schedule.payload as ExperimentRunPayload;
    return ['experiment', payload.experiment_ref];
  }
  const payload = schedule.payload as DispatchSpecPayload;
  return [
    payload.spec_ref.spec_id,
    payload.spec_ref.resource_id,
    ...payload.target_swarm_ids,
  ];
}

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
        return matchesSearch(
          q,
          s.id,
          s.cron,
          ...scheduleSearchTerms(s),
        );
      }),
    [schedules, q],
  );

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h1
            className="flex items-center gap-2 text-2xl font-bold"
            style={{ color: 'var(--color-text)' }}
          >
            <Clock className="h-6 w-6 text-honey-500" />
            Jobs
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Cron-style recurring jobs. Each fire dispatches work or launches an experiment run.
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

      <JobsTabs activeId="schedules" className="mb-4" />

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
                    : 'hover:opacity-100',
                )}
                style={pausedFilter !== v ? { color: 'var(--color-text-muted)' } : undefined}
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
        <div
          className="mt-6 rounded-md border p-3 text-sm"
          style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
        >
          Failed to load schedules: {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon={Calendar}
            title={schedules.length === 0 ? 'No schedules yet' : 'No schedules match the current filters.'}
            description={schedules.length === 0 ? 'Create a schedule to run dispatches on a recurring cadence.' : undefined}
            action={
              schedules.length === 0 ? (
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="flex items-center gap-1.5 rounded-md bg-honey-500 px-3 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-honey-400"
                >
                  <Plus className="h-4 w-4" />
                  New schedule
                </button>
              ) : undefined
            }
          />
        </div>
      )}

      {filtered.length > 0 && (
        <div className="mt-6 space-y-2">
          {filtered.map((s) => (
            <ScheduleRow key={s.id} schedule={s} />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateScheduleModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}

function ScheduleRow({ schedule }: { schedule: Schedule }) {
  const kind = getPayloadKind(schedule.payload);
  const targets =
    kind === 'experiment'
      ? []
      : (schedule.payload as DispatchPromptPayload | DispatchSpecPayload).target_swarm_ids;
  let cronDescription = '';
  try {
    cronDescription = cronstrue.toString(schedule.cron, { use24HourTimeFormat: false });
  } catch {
    /* keep empty if invalid */
  }

  return (
    <Link
      to={`/schedules/${schedule.id}`}
      className="block rounded-md border transition-colors hover:bg-white/5"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      <div className="flex items-start gap-3 px-3 py-2.5">
        {/* Cron */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs text-honey-400">{schedule.cron}</span>
            {schedule.timezone && (
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                {schedule.timezone}
              </span>
            )}
            {cronDescription && (
              <span className="text-2xs italic" style={{ color: 'var(--color-text-muted)' }}>
                {cronDescription}
              </span>
            )}
          </div>

          <div className="mt-1 flex items-center gap-3 text-xs flex-wrap" style={{ color: 'var(--color-text-muted)' }}>
            {/* Work */}
            {kind === 'dispatch_prompt' ? (
              <span className="line-clamp-1" style={{ color: 'var(--color-text-secondary)' }}>
                {(schedule.payload as DispatchPromptPayload).prompt}
              </span>
            ) : kind === 'experiment' ? (
              <span className="inline-flex items-center gap-1">
                <span style={{ color: 'var(--color-text-secondary)' }}>Experiment</span>
                <span className="font-mono" style={{ color: 'var(--color-text-secondary)' }}>
                  {(schedule.payload as ExperimentRunPayload).experiment_ref}
                </span>
              </span>
            ) : (
              <span className="font-mono" style={{ color: 'var(--color-text-secondary)' }}>
                {(schedule.payload as DispatchSpecPayload).spec_ref.spec_id}
              </span>
            )}
            <span>·</span>
            {/* Targets */}
            {kind === 'experiment' ? (
              <span>experiment runner</span>
            ) : targets.length === 1 ? (
              <span className="font-mono">{targets[0]}</span>
            ) : (
              <span>{targets.length} swarms</span>
            )}
            <span>·</span>
            {/* Next fire */}
            {schedule.next_fires_at ? (
              <span>Next: <TimeAgo date={schedule.next_fires_at} /></span>
            ) : (
              <span>No next fire</span>
            )}
            <span>·</span>
            {/* Last fired */}
            {schedule.last_fired_at ? (
              <span>Last: <TimeAgo date={schedule.last_fired_at} /></span>
            ) : (
              <span>never fired</span>
            )}
          </div>
        </div>

        {/* Status + pause reason */}
        <div className="flex items-center gap-1.5 shrink-0">
          {schedule.paused && schedule.pause_reason && (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" title={schedule.pause_reason} />
          )}
          <StatusChip
            {...scheduleStateToChip(!schedule.paused)}
            icon={schedule.paused ? Pause : Play}
          />
        </div>
      </div>
    </Link>
  );
}
