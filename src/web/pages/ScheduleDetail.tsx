import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Clock,
  Pause,
  Play,
  Trash2,
  AlertTriangle,
  Save,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import cronstrue from 'cronstrue';
import {
  useSchedule,
  useUpdateSchedule,
  usePauseSchedule,
  useResumeSchedule,
  useDeleteSchedule,
  useCronPreview,
  getPayloadKind,
  type Schedule,
  type DispatchSpecPayload,
  type DispatchPromptPayload,
  type ExperimentRunPayload,
} from '../hooks/useSchedules';
import { useSchedulesRealtime } from '../hooks/useSchedulesRealtime';
import { TimeAgo } from '../components/common/TimeAgo';
import { DispatchStatusChip } from '../components/dispatch/DispatchStatusChip';
import { PageLoader } from '../components/common/LoadingSpinner';
import { StatusChip, type StatusTone } from '../components/common/StatusChip';

function scheduleStateToChip(active: boolean): { tone: StatusTone; label: string } {
  return active
    ? { tone: 'success', label: 'Active' }
    : { tone: 'neutral', label: 'Paused' };
}

export function ScheduleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  useSchedulesRealtime();

  const { data, isLoading, error } = useSchedule(id);

  if (isLoading) {
    return <PageLoader />;
  }
  if (error) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <Link
          to="/schedules"
          className="inline-flex items-center gap-1 text-sm mb-4"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to schedules
        </Link>
        <div
          className="rounded-md border p-4 text-sm"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text)',
          }}
        >
          {`Failed to load schedule: ${(error as Error).message}`}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <Link
          to="/schedules"
          className="inline-flex items-center gap-1 text-sm mb-4 hover:opacity-80"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to schedules
        </Link>
        <div
          className="rounded-md border p-4 text-sm"
          style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
        >
          Schedule not found.
        </div>
      </div>
    );
  }

  const { schedule, fires } = data;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Link to="/schedules" className="mb-4 inline-flex items-center gap-1 text-sm hover:opacity-80" style={{ color: 'var(--color-text-muted)' }}>
        <ArrowLeft className="h-3.5 w-3.5" /> Back to schedules
      </Link>

      <Header schedule={schedule} onDeleted={() => navigate('/schedules')} />

      <CronAndPayloadEditor schedule={schedule} />

      <FireHistory fires={fires} />
    </div>
  );
}

function Header({
  schedule,
  onDeleted,
}: {
  schedule: Schedule;
  onDeleted: () => void;
}) {
  const pause = usePauseSchedule(schedule.id);
  const resume = useResumeSchedule(schedule.id);
  const del = useDeleteSchedule();
  const targets = 'target_swarm_ids' in schedule.payload ? (schedule.payload.target_swarm_ids ?? []) : [];
  const kind = getPayloadKind(schedule.payload);

  async function handleDelete() {
    if (!confirm(`Delete this schedule? This cannot be undone.`)) return;
    await del.mutateAsync(schedule.id);
    onDeleted();
  }

  return (
    <div
      className="mb-6 rounded-lg border p-5"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-elevated)',
      }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
            <Clock className="h-5 w-5 text-honey-500" />
            <span className="font-mono text-base">{schedule.cron}</span>
            {schedule.timezone && (
              <span
                className="rounded px-1.5 py-0.5 text-xs font-normal"
                style={{
                  backgroundColor: 'var(--color-surface)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {schedule.timezone}
              </span>
            )}
          </h1>
          <p className="mt-1 font-mono text-xs" style={{ color: 'var(--color-text-muted)' }}>{schedule.id}</p>

          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <ScheduleWorkRow schedule={schedule} />
            <MetaRow label={kind === 'experiment' ? 'Run target' : 'Targets'}>
              {kind === 'experiment' ? (
                <span style={{ color: 'var(--color-text)' }}>experiment worker</span>
              ) : (
                <span className="font-mono" style={{ color: 'var(--color-text)' }}>{targets.length} swarm{targets.length === 1 ? '' : 's'}</span>
              )}
            </MetaRow>
            <MetaRow label="Next fire">
              {schedule.next_fires_at ? <TimeAgo date={schedule.next_fires_at} /> : <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
            </MetaRow>
            <MetaRow label="Last fired">
              {schedule.last_fired_at ? <TimeAgo date={schedule.last_fired_at} /> : <span style={{ color: 'var(--color-text-muted)' }}>never</span>}
            </MetaRow>
            <MetaRow label="Catch-up">
              <code style={{ color: 'var(--color-text)' }}>{schedule.policy.catchUp}</code>
            </MetaRow>
            <MetaRow label="Skip if running">
              <code style={{ color: 'var(--color-text)' }}>{String(schedule.policy.skipIfRunning)}</code>
            </MetaRow>
            <MetaRow label="Initiator">
              <span style={{ color: 'var(--color-text-secondary)' }}>{schedule.initiator_type} · </span>
              <span className="font-mono" style={{ color: 'var(--color-text-secondary)' }}>{schedule.initiator_id}</span>
            </MetaRow>
            <MetaRow label="Created">
              <TimeAgo date={schedule.created_at} />
            </MetaRow>
          </div>

          {schedule.paused && schedule.pause_reason && (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>Paused — {schedule.pause_reason}</span>
            </div>
          )}

          <div className="mt-3">
            <StatusChip {...scheduleStateToChip(!schedule.paused)} icon={schedule.paused ? Pause : Play} />
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          {schedule.paused ? (
            <button
              type="button"
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
              className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 ring-1 ring-emerald-500/30 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </button>
          ) : (
            <button
              type="button"
              onClick={() => pause.mutate(undefined)}
              disabled={pause.isPending}
              className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-white/5 disabled:opacity-50"
              style={{
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text)',
              }}
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </button>
          )}
          <button
            type="button"
            onClick={handleDelete}
            disabled={del.isPending}
            className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-3 py-1.5 text-sm font-medium text-red-300 ring-1 ring-red-500/30 transition-colors hover:bg-red-500/20 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

function CronAndPayloadEditor({ schedule }: { schedule: Schedule }) {
  const update = useUpdateSchedule(schedule.id);
  const [editing, setEditing] = useState(false);
  const [cron, setCron] = useState(schedule.cron);
  const [timezone, setTimezone] = useState(schedule.timezone ?? '');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) {
      setCron(schedule.cron);
      setTimezone(schedule.timezone ?? '');
    }
  }, [schedule.cron, schedule.timezone, editing]);

  async function save() {
    setErr(null);
    try {
      await update.mutateAsync({
        cron,
        timezone: timezone.trim() || null,
      });
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div
      className="mb-6 rounded-lg border p-5"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-elevated)',
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Cron expression
        </h2>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-honey-400 transition-colors hover:text-honey-300"
          >
            Edit
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-white/5"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <X className="h-3 w-3" /> Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={update.isPending}
              className="flex items-center gap-1 rounded-md bg-honey-500 px-2 py-1 text-xs font-medium text-zinc-900 hover:bg-honey-400 disabled:opacity-50"
            >
              <Save className="h-3 w-3" /> Save
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <input
            type="text"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            className="input w-full font-mono text-sm"
          />
          <input
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Timezone (optional, e.g. America/Los_Angeles)"
            className="input w-full text-xs"
          />
          <CronPreviewInline cron={cron} timezone={timezone} />
          <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            Saving recomputes next_fires_at from now.
          </p>
          {err && <div className="text-xs text-red-300">{err}</div>}
        </div>
      ) : (
        <div>
          <code className="font-mono text-sm" style={{ color: 'var(--color-text)' }}>{schedule.cron}</code>
          <CronPreviewInline cron={schedule.cron} timezone={schedule.timezone ?? ''} />
        </div>
      )}

      <div className="mt-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          Payload
        </h3>
        <pre
          className="overflow-x-auto rounded-md p-3 text-xs"
          style={{
            backgroundColor: 'var(--color-surface)',
            color: 'var(--color-text-secondary)',
          }}
        >
          {JSON.stringify(schedule.payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function FireHistory({ fires }: { fires: import('../hooks/useDispatch').Dispatch[] }) {
  return (
    <div
      className="rounded-lg border p-5"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-elevated)',
      }}
    >
      <h2 className="mb-3 text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
        Recent fires
      </h2>
      {fires.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No dispatches yet — this schedule hasn't fired.</p>
      ) : (
        <div className="space-y-1">
          {fires.map((d) => (
            <Link
              key={d.id}
              to={`/dispatch/${d.id}`}
              className="flex items-center gap-3 rounded-md border px-3 py-2 text-xs transition-colors hover:bg-white/5"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              <span className="font-mono text-honey-400 min-w-0 truncate flex-1">{d.id}</span>
              <DispatchStatusChip status={d.status} />
              <span className="font-mono shrink-0" style={{ color: 'var(--color-text-secondary)' }}>{d.target_swarm_id}</span>
              <span className="shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                <TimeAgo date={d.created_at} />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div style={{ color: 'var(--color-text-muted)' }}>{label}</div>
      <div style={{ color: 'var(--color-text)' }}>{children}</div>
    </>
  );
}

function CronPreviewInline({ cron, timezone }: { cron: string; timezone: string }) {
  const tz = timezone.trim() || undefined;
  const { data, isLoading, error } = useCronPreview(cron, { timezone: tz, count: 3 });
  if (!cron) return null;

  let description = '';
  try {
    description = cronstrue.toString(cron, { use24HourTimeFormat: false });
  } catch {
    /* invalid — handled below */
  }

  if (isLoading) {
    return <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Computing preview…</p>;
  }
  if (error) {
    return <p className="text-2xs text-red-400">Invalid cron expression</p>;
  }
  if (!data || data.fires.length === 0) return null;
  return (
    <div className="space-y-1">
      {description && (
        <p className="text-2xs italic" style={{ color: 'var(--color-text-secondary)' }}>{description}</p>
      )}
      <div
        className="rounded border px-2 py-1.5"
        style={{
          borderColor: 'var(--color-border-subtle)',
          backgroundColor: 'var(--color-surface)',
        }}
      >
        <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
          Next {data.fires.length} fires ({data.timezone})
        </div>
        <ul className="mt-0.5 space-y-0.5 text-2xs" style={{ color: 'var(--color-text-secondary)' }}>
          {data.fires.map((f) => (
            <li key={f} className="font-mono">{new Date(f).toLocaleString()}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ScheduleWorkRow({ schedule }: { schedule: Schedule }) {
  const kind = getPayloadKind(schedule.payload);
  if (kind === 'dispatch_prompt') {
    const p = schedule.payload as DispatchPromptPayload;
    return (
      <>
        <div style={{ color: 'var(--color-text-muted)' }}>Work</div>
        <div style={{ color: 'var(--color-text)' }}>
          <span
            className="rounded px-1.5 py-0.5 text-2xs uppercase tracking-wider"
            style={{
              backgroundColor: 'var(--color-surface)',
              color: 'var(--color-text-secondary)',
            }}
          >
            ad-hoc prompt
          </span>
          <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs" style={{ color: 'var(--color-text-secondary)' }}>
            {p.prompt}
          </div>
        </div>
      </>
    );
  }
  if (kind === 'experiment') {
    const p = schedule.payload as ExperimentRunPayload;
    return (
      <>
        <div style={{ color: 'var(--color-text-muted)' }}>Experiment</div>
        <div style={{ color: 'var(--color-text)' }}>
          <Link
            to={`/experiments/${p.experiment_ref}`}
            className="font-mono text-honey-400 hover:text-honey-300"
          >
            {p.experiment_ref}
          </Link>
          {p.run_controls && (
            <div className="mt-1 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              {p.run_controls.cycles != null && <span>{p.run_controls.cycles} cycles</span>}
              {p.run_controls.cycles != null && p.run_controls.budgetSeconds != null && <span> · </span>}
              {p.run_controls.budgetSeconds != null && <span>{p.run_controls.budgetSeconds}s budget</span>}
            </div>
          )}
        </div>
      </>
    );
  }
  const p = schedule.payload as DispatchSpecPayload;
  return (
    <>
      <div style={{ color: 'var(--color-text-muted)' }}>Spec</div>
      <div style={{ color: 'var(--color-text)' }}>
        <Link
          to={`/specs/${p.spec_ref.resource_id}/${p.spec_ref.spec_id}`}
          className="font-mono text-honey-400 hover:text-honey-300"
        >
          {p.spec_ref.spec_id}
        </Link>
      </div>
    </>
  );
}
