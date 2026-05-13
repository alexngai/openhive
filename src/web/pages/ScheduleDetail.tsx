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
} from '../hooks/useSchedules';
import { useSchedulesRealtime } from '../hooks/useSchedulesRealtime';
import { TimeAgo } from '../components/common/TimeAgo';
import { DispatchStatusChip } from '../components/dispatch/DispatchStatusChip';

export function ScheduleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  useSchedulesRealtime();

  const { data, isLoading, error } = useSchedule(id);

  if (isLoading) {
    return <div className="p-6 text-sm text-zinc-400">Loading…</div>;
  }
  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          Failed to load schedule: {(error as Error).message}
        </div>
        <Link to="/schedules" className="mt-3 inline-flex items-center gap-1 text-sm text-honey-400">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to schedules
        </Link>
      </div>
    );
  }
  if (!data) return null;

  const { schedule, fires } = data;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <Link to="/schedules" className="mb-4 inline-flex items-center gap-1 text-sm text-honey-400 hover:text-honey-300">
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

  async function handleDelete() {
    if (!confirm(`Delete this schedule? This cannot be undone.`)) return;
    await del.mutateAsync(schedule.id);
    onDeleted();
  }

  return (
    <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold" style={{ color: 'var(--color-text)' }}>
            <Clock className="h-5 w-5 text-honey-500" />
            <span className="font-mono text-base">{schedule.cron}</span>
            {schedule.timezone && (
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs font-normal text-zinc-300">
                {schedule.timezone}
              </span>
            )}
          </h1>
          <p className="mt-1 font-mono text-xs text-zinc-500">{schedule.id}</p>

          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <ScheduleWorkRow schedule={schedule} />
            <MetaRow label="Targets">
              <span className="font-mono text-zinc-200">{schedule.payload.target_swarm_ids.length} swarm{schedule.payload.target_swarm_ids.length === 1 ? '' : 's'}</span>
            </MetaRow>
            <MetaRow label="Next fire">
              {schedule.next_fires_at ? <TimeAgo date={schedule.next_fires_at} /> : <span className="text-zinc-500">—</span>}
            </MetaRow>
            <MetaRow label="Last fired">
              {schedule.last_fired_at ? <TimeAgo date={schedule.last_fired_at} /> : <span className="text-zinc-500">never</span>}
            </MetaRow>
            <MetaRow label="Catch-up">
              <code className="text-zinc-200">{schedule.policy.catchUp}</code>
            </MetaRow>
            <MetaRow label="Skip if running">
              <code className="text-zinc-200">{String(schedule.policy.skipIfRunning)}</code>
            </MetaRow>
            <MetaRow label="Initiator">
              <span className="text-zinc-300">{schedule.initiator_type} · </span>
              <span className="font-mono text-zinc-300">{schedule.initiator_id}</span>
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
              className="flex items-center gap-1.5 rounded-md bg-zinc-700/50 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-50"
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
    <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/30 p-5">
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
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
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
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 font-mono text-sm text-zinc-100 focus:border-honey-500 focus:outline-none focus:ring-1 focus:ring-honey-500"
          />
          <input
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Timezone (optional, e.g. America/Los_Angeles)"
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-honey-500 focus:outline-none focus:ring-1 focus:ring-honey-500"
          />
          <CronPreviewInline cron={cron} timezone={timezone} />
          <p className="text-[10px] text-zinc-500">
            Saving recomputes next_fires_at from now.
          </p>
          {err && <div className="text-xs text-red-300">{err}</div>}
        </div>
      ) : (
        <div>
          <code className="font-mono text-sm text-zinc-100">{schedule.cron}</code>
          <CronPreviewInline cron={schedule.cron} timezone={schedule.timezone ?? ''} />
        </div>
      )}

      <div className="mt-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
          Payload
        </h3>
        <pre className="overflow-x-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-300">
          {JSON.stringify(schedule.payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function FireHistory({ fires }: { fires: Schedule extends never ? never : ReadonlyArray<import('../hooks/useDispatch').Dispatch> }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-5">
      <h2 className="mb-3 text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
        Recent fires
      </h2>
      {fires.length === 0 ? (
        <p className="text-xs text-zinc-500">No dispatches yet — this schedule hasn't fired.</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/50">
              <tr className="text-left text-xs uppercase tracking-wider" style={{ color: 'var(--color-text-muted)' }}>
                <th className="px-3 py-2 font-medium">Dispatch</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Target</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {fires.map((d) => (
                <tr key={d.id} className="hover:bg-zinc-900/40">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link to={`/dispatch/${d.id}`} className="text-honey-400 hover:text-honey-300">
                      {d.id}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <DispatchStatusChip status={d.status} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-zinc-300">{d.target_swarm_id}</td>
                  <td className="px-3 py-2 text-xs">
                    <TimeAgo date={d.created_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="text-zinc-500">{label}</div>
      <div className="text-zinc-200">{children}</div>
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
    return <p className="text-[10px] text-zinc-500">Computing preview…</p>;
  }
  if (error) {
    return <p className="text-[10px] text-red-400">Invalid cron expression</p>;
  }
  if (!data || data.fires.length === 0) return null;
  return (
    <div className="space-y-1">
      {description && (
        <p className="text-[11px] italic text-zinc-300">{description}</p>
      )}
      <div className="rounded border border-zinc-800 bg-zinc-950/40 px-2 py-1.5">
        <div className="text-[10px] font-medium text-zinc-500">
          Next {data.fires.length} fires ({data.timezone})
        </div>
        <ul className="mt-0.5 space-y-0.5 text-[11px] text-zinc-300">
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
        <div className="text-zinc-500">Work</div>
        <div className="text-zinc-200">
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-300">
            ad-hoc prompt
          </span>
          <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-zinc-300">
            {p.prompt}
          </div>
        </div>
      </>
    );
  }
  const p = schedule.payload as DispatchSpecPayload;
  return (
    <>
      <div className="text-zinc-500">Spec</div>
      <div className="text-zinc-200">
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
