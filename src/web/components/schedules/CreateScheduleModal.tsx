import { useState } from 'react';
import { X } from 'lucide-react';
import { useCreateSchedule, useCronPreview, type OpenHiveSchedulePayload } from '../../hooks/useSchedules';

interface Props {
  onClose: () => void;
  /** Optional: pre-fill from a spec context (e.g. when opened from SpecDetail). */
  initialSpecRef?: { resource_id: string; spec_id: string };
}

export function CreateScheduleModal({ onClose, initialSpecRef }: Props) {
  const [cron, setCron] = useState('0 * * * *');
  const [timezone, setTimezone] = useState('');
  const [resourceId, setResourceId] = useState(initialSpecRef?.resource_id ?? '');
  const [specId, setSpecId] = useState(initialSpecRef?.spec_id ?? '');
  const [swarmIdsRaw, setSwarmIdsRaw] = useState('');
  const [promptOverride, setPromptOverride] = useState('');
  const [catchUp, setCatchUp] = useState<'skip' | 'fire-once' | 'fire-all'>('fire-once');
  const [skipIfRunning, setSkipIfRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = useCreateSchedule();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const swarmIds = swarmIdsRaw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (swarmIds.length === 0) {
      setError('At least one target swarm id is required.');
      return;
    }
    if (!resourceId || !specId) {
      setError('Spec resource id and spec id are both required.');
      return;
    }

    const payload: OpenHiveSchedulePayload = {
      spec_ref: { resource_id: resourceId, spec_id: specId },
      target_swarm_ids: swarmIds,
    };
    if (promptOverride.trim()) {
      payload.prompt_override = promptOverride.trim();
    }

    try {
      await create.mutateAsync({
        cron,
        timezone: timezone.trim() || undefined,
        payload,
        policy: { catchUp, skipIfRunning },
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-900 p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            New schedule
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <Field label="Cron expression" hint="Standard 5-field unix cron (or @hourly / @daily / @weekly)">
            <input
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className={inputClass}
              required
              placeholder="0 * * * *"
            />
            <CronPreviewBlock cron={cron} timezone={timezone} />
          </Field>

          <Field label="Timezone" hint="Optional IANA timezone (e.g. America/Los_Angeles). Defaults to UTC.">
            <input
              type="text"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className={inputClass}
              placeholder="UTC"
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Spec resource id">
              <input
                type="text"
                value={resourceId}
                onChange={(e) => setResourceId(e.target.value)}
                className={inputClass}
                required
                placeholder="res_…"
              />
            </Field>
            <Field label="Spec id">
              <input
                type="text"
                value={specId}
                onChange={(e) => setSpecId(e.target.value)}
                className={inputClass}
                required
                placeholder="c-…"
              />
            </Field>
          </div>

          <Field label="Target swarm ids" hint="Comma or whitespace separated. Each fire creates one dispatch per target.">
            <textarea
              value={swarmIdsRaw}
              onChange={(e) => setSwarmIdsRaw(e.target.value)}
              className={inputClass + ' h-16'}
              required
              placeholder="swarm_abc, swarm_def"
            />
          </Field>

          <Field label="Prompt override (optional)">
            <textarea
              value={promptOverride}
              onChange={(e) => setPromptOverride(e.target.value)}
              className={inputClass + ' h-16'}
              placeholder="Appended to the seed prompt each fire."
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Catch-up policy" hint="What happens when a fire is missed">
              <select
                value={catchUp}
                onChange={(e) => setCatchUp(e.target.value as typeof catchUp)}
                className={inputClass}
              >
                <option value="fire-once">fire-once (default)</option>
                <option value="skip">skip</option>
                <option value="fire-all">fire-all</option>
              </select>
            </Field>
            <Field label="" hint=" ">
              <label className="mt-2 flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={skipIfRunning}
                  onChange={(e) => setSkipIfRunning(e.target.checked)}
                  className="rounded border-zinc-600 bg-zinc-800 text-honey-500"
                />
                Skip if already running
              </label>
            </Field>
          </div>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded-md bg-honey-500 px-3 py-1.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-honey-400 disabled:opacity-50"
            >
              {create.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 focus:border-honey-500 focus:outline-none focus:ring-1 focus:ring-honey-500';

function CronPreviewBlock({ cron, timezone }: { cron: string; timezone: string }) {
  const tz = timezone.trim() || undefined;
  const { data, isLoading, error } = useCronPreview(cron, { timezone: tz, count: 3 });
  if (!cron) return null;
  if (isLoading) {
    return <p className="mt-1 text-[10px] text-zinc-500">Computing preview…</p>;
  }
  if (error) {
    return <p className="mt-1 text-[10px] text-red-400">Invalid cron expression</p>;
  }
  if (!data || data.fires.length === 0) {
    return <p className="mt-1 text-[10px] text-zinc-500">No future fires</p>;
  }
  return (
    <div className="mt-1.5 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1.5">
      <div className="text-[10px] font-medium text-zinc-500">Next {data.fires.length} fires ({data.timezone})</div>
      <ul className="mt-0.5 space-y-0.5 text-[10px] text-zinc-300">
        {data.fires.map((f) => (
          <li key={f} className="font-mono">{new Date(f).toLocaleString()}</li>
        ))}
      </ul>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {label && (
        <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
          {label}
        </label>
      )}
      {children}
      {hint && hint.trim() && (
        <p className="mt-1 text-[10px] text-zinc-500">{hint}</p>
      )}
    </div>
  );
}
