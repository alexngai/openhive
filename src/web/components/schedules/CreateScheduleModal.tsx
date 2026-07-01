import { useMemo, useState } from 'react';
import { X, Check, Search } from 'lucide-react';
import cronstrue from 'cronstrue';
import clsx from 'clsx';
import {
  useCreateSchedule,
  useCronPreview,
  type FallbackSpawnAdapter,
  type OpenHiveSchedulePayload,
} from '../../hooks/useSchedules';
import { useSpecs, type Spec } from '../../hooks/useSpecs';
import { useMapSwarmsForPicker } from '../../hooks/useApi';

interface Props {
  onClose: () => void;
  /** Optional: pre-fill from a spec context (e.g. when opened from SpecDetail). */
  initialSpecRef?: { resource_id: string; spec_id: string };
}

type Mode = 'spec' | 'prompt';

export function CreateScheduleModal({ onClose, initialSpecRef }: Props) {
  const [mode, setMode] = useState<Mode>(initialSpecRef ? 'spec' : 'spec');
  const [cron, setCron] = useState('0 * * * *');
  const [timezone, setTimezone] = useState('');
  // Spec mode
  const [selectedSpecKey, setSelectedSpecKey] = useState<string>(
    initialSpecRef ? `${initialSpecRef.resource_id}/${initialSpecRef.spec_id}` : '',
  );
  // Prompt mode
  const [prompt, setPrompt] = useState('');
  // Targets
  const [selectedSwarmIds, setSelectedSwarmIds] = useState<string[]>([]);
  // Policy
  const [catchUp, setCatchUp] = useState<'skip' | 'fire-once' | 'fire-all'>('fire-once');
  const [skipIfRunning, setSkipIfRunning] = useState(false);
  // Fallback spawn
  const [fallbackEnabled, setFallbackEnabled] = useState(false);
  const [fallbackAdapter, setFallbackAdapter] = useState<FallbackSpawnAdapter>('swarm-runner');
  const [error, setError] = useState<string | null>(null);

  const create = useCreateSchedule();

  // Source data
  const { data: specsResp } = useSpecs({ limit: 100 });
  const specs = specsResp?.data ?? [];
  const { data: swarms = [] } = useMapSwarmsForPicker();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (selectedSwarmIds.length === 0) {
      setError('Pick at least one target swarm.');
      return;
    }

    const fallbackSpawn = fallbackEnabled
      ? { adapter: fallbackAdapter, cleanup_on_terminal: true }
      : undefined;

    let payload: OpenHiveSchedulePayload;
    if (mode === 'spec') {
      const spec = specs.find((s) => `${s.resource_id}/${s.id}` === selectedSpecKey);
      if (!spec) {
        setError('Pick a spec.');
        return;
      }
      payload = {
        kind: 'dispatch_spec',
        spec_ref: { resource_id: spec.resource_id, spec_id: spec.id },
        target_swarm_ids: selectedSwarmIds,
        ...(fallbackSpawn ? { fallback_spawn: fallbackSpawn } : {}),
      };
    } else {
      if (!prompt.trim()) {
        setError('Enter a prompt for the agent.');
        return;
      }
      payload = {
        kind: 'dispatch_prompt',
        prompt: prompt.trim(),
        target_swarm_ids: selectedSwarmIds,
        ...(fallbackSpawn ? { fallback_spawn: fallbackSpawn } : {}),
      };
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
      <div
        className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-lg border shadow-xl"
        style={{
          borderColor: 'var(--color-border-subtle)',
          backgroundColor: 'var(--color-elevated)',
        }}
      >
        <div
          className="flex shrink-0 items-center justify-between border-b px-5 py-3"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <h2 className="text-lg font-semibold" style={{ color: 'var(--color-text)' }}>
            New schedule
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 transition-colors hover:bg-white/5"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
            <div>
              <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                Cron
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  className={inputClass + ' min-w-0 flex-1 font-mono'}
                  required
                  placeholder="0 * * * *"
                />
                <input
                  type="text"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="input w-24 shrink-0 text-sm"
                  placeholder="UTC"
                  aria-label="Timezone"
                />
              </div>
              <CronDescription cron={cron} />
              <CronPreviewBlock cron={cron} timezone={timezone} />
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                  Description
                </label>
                <ModeToggle mode={mode} onChange={setMode} />
              </div>
              {mode === 'spec' ? (
                <SpecPicker
                  specs={specs}
                  selectedKey={selectedSpecKey}
                  onSelect={setSelectedSpecKey}
                />
              ) : (
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className={inputClass + ' h-20'}
                  placeholder="e.g. Check open GitHub issues in openhive-3 and triage them."
                  required
                />
              )}
            </div>

            <Field label="Target swarms">
              <SwarmChipPicker
                swarms={swarms}
                selectedIds={selectedSwarmIds}
                onChange={setSelectedSwarmIds}
              />
            </Field>

            <div>
              <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={fallbackEnabled}
                  onChange={(e) => setFallbackEnabled(e.target.checked)}
                  className="rounded accent-honey-500"
                />
                Auto-spawn fallback when all swarms are offline
                {fallbackEnabled && (
                  <select
                    value={fallbackAdapter}
                    onChange={(e) => setFallbackAdapter(e.target.value as FallbackSpawnAdapter)}
                    className="input ml-1 px-1.5 py-0.5 text-xs"
                  >
                    <option value="swarm-runner">swarm-runner</option>
                    <option value="claude-code">claude-code</option>
                    <option value="codex">codex</option>
                  </select>
                )}
              </label>
            </div>

            <div className="grid grid-cols-2 items-end gap-3">
              <Field label="Catch-up policy">
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
              <label className="flex h-[34px] items-center gap-2 text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={skipIfRunning}
                  onChange={(e) => setSkipIfRunning(e.target.checked)}
                  className="rounded accent-honey-500"
                />
                Skip if already running
              </label>
            </div>
          </div>

          <div className="shrink-0 border-t px-5 py-3" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {error && (
              <div className="mb-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-white/5"
                style={{ color: 'var(--color-text-secondary)' }}
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
          </div>
        </form>
      </div>
    </div>
  );
}

const inputClass = 'input w-full';

// ── Cron plain-English description ────────────────────────────────────
function CronDescription({ cron }: { cron: string }) {
  if (!cron.trim()) return null;
  let description = '';
  try {
    description = cronstrue.toString(cron, { use24HourTimeFormat: false });
  } catch {
    return null; // invalid — CronPreviewBlock surfaces the error instead
  }
  return (
    <p className="mt-1 text-2xs italic" style={{ color: 'var(--color-text-secondary)' }}>{description}</p>
  );
}

// ── Cron next-N-fires server-side preview ─────────────────────────────
function CronPreviewBlock({ cron, timezone }: { cron: string; timezone: string }) {
  const tz = timezone.trim() || undefined;
  const { data, isLoading, error } = useCronPreview(cron, { timezone: tz, count: 3 });
  if (!cron) return null;
  if (isLoading) {
    return <p className="mt-1 text-2xs" style={{ color: 'var(--color-text-muted)' }}>Computing preview…</p>;
  }
  if (error) {
    return <p className="mt-1 text-2xs text-red-400">Invalid cron expression</p>;
  }
  if (!data || data.fires.length === 0) {
    return <p className="mt-1 text-2xs" style={{ color: 'var(--color-text-muted)' }}>No future fires</p>;
  }
  return (
    <p className="mt-1 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
      <span className="font-medium">Next ({data.timezone}):</span>{' '}
      <span className="font-mono" style={{ color: 'var(--color-text-secondary)' }}>
        {data.fires.map((f) => new Date(f).toLocaleString()).join(' · ')}
      </span>
    </p>
  );
}

// ── Mode toggle: dispatch_spec vs dispatch_prompt ─────────────────────
function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div
      className="flex rounded-md border p-0.5 text-2xs"
      style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-surface)' }}
    >
      <button
        type="button"
        onClick={() => onChange('spec')}
        className={clsx(
          'rounded px-2.5 py-0.5 transition-colors',
          mode === 'spec'
            ? 'bg-honey-500 font-medium text-zinc-900'
            : 'hover:bg-white/5',
        )}
        style={mode !== 'spec' ? { color: 'var(--color-text-secondary)' } : undefined}
      >
        Use spec
      </button>
      <button
        type="button"
        onClick={() => onChange('prompt')}
        className={clsx(
          'rounded px-2.5 py-0.5 transition-colors',
          mode === 'prompt'
            ? 'bg-honey-500 font-medium text-zinc-900'
            : 'hover:bg-white/5',
        )}
        style={mode !== 'prompt' ? { color: 'var(--color-text-secondary)' } : undefined}
      >
        Ad-hoc prompt
      </button>
    </div>
  );
}

// ── Spec picker (searchable list) ─────────────────────────────────────
function SpecPicker({
  specs,
  selectedKey,
  onSelect,
}: {
  specs: Spec[];
  selectedKey: string;
  onSelect: (key: string) => void;
}) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return specs.slice(0, 50);
    return specs
      .filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q) ||
          (s.resource_name ?? '').toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [specs, search]);

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search specs by title, id, or resource name…"
          className={inputClass + ' pl-7'}
        />
      </div>
      <div
        className="max-h-32 overflow-y-auto rounded-md border"
        style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-surface)' }}
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {specs.length === 0 ? 'No specs available' : 'No matches'}
          </div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {filtered.map((spec) => {
              const key = `${spec.resource_id}/${spec.id}`;
              const isSelected = selectedKey === key;
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => onSelect(key)}
                    className={clsx(
                      'flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition-colors',
                      isSelected
                        ? 'bg-honey-500/15 ring-1 ring-inset ring-honey-500/30'
                        : 'hover:bg-white/5',
                    )}
                  >
                    <div className="mt-0.5 w-4 shrink-0">
                      {isSelected && <Check className="h-3.5 w-3.5 text-honey-400" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium" style={{ color: 'var(--color-text)' }}>
                        {spec.title || <em style={{ color: 'var(--color-text-muted)' }}>untitled</em>}
                      </div>
                      <div className="truncate text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                        <span className="font-mono">{spec.id}</span>
                        <span className="mx-1">·</span>
                        <span>{spec.resource_name}</span>
                        {spec.status && (
                          <>
                            <span className="mx-1">·</span>
                            <span>{spec.status}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Swarm chip picker (multi-select) ──────────────────────────────────
interface SwarmForPicker {
  id: string;
  name: string;
  status?: string;
}

function SwarmChipPicker({
  swarms,
  selectedIds,
  onChange,
}: {
  swarms: SwarmForPicker[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const inactiveCount = useMemo(
    () => swarms.filter((s) => s.status !== 'online').length,
    [swarms],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const active = showInactive
      ? swarms
      : swarms.filter((s) => s.status === 'online');
    if (!q) return active.slice(0, 50);
    return active
      .filter(
        (s) =>
          s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [swarms, search, showInactive]);

  const toggle = (id: string) => {
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id],
    );
  };

  const selectedSwarms = selectedIds.map((id) => ({
    id,
    swarm: swarms.find((s) => s.id === id),
  }));

  return (
    <div className="space-y-1.5">
      {selectedSwarms.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedSwarms.map(({ id, swarm }) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-md bg-honey-500/15 px-2 py-0.5 text-xs text-honey-200 ring-1 ring-inset ring-honey-500/30"
            >
              <StatusDot status={swarm?.status} />
              <span>{swarm?.name ?? id}</span>
              <button
                type="button"
                onClick={() => toggle(id)}
                className="ml-0.5 rounded text-honey-300 hover:bg-honey-500/20 hover:text-honey-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search swarms…"
            className={inputClass + ' pl-7'}
          />
        </div>
        {inactiveCount > 0 && (
          <label className="flex shrink-0 items-center gap-1.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="rounded accent-honey-500"
            />
            Show inactive ({inactiveCount})
          </label>
        )}
      </div>
      <div
        className="max-h-32 overflow-y-auto rounded-md border"
        style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-surface)' }}
      >
        {filtered.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {swarms.length === 0
              ? 'No swarms available'
              : !showInactive && inactiveCount > 0 && swarms.filter((s) => s.status === 'online').length === 0
                ? 'No active swarms — toggle "Show inactive" to see offline ones'
                : 'No matches'}
          </div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {filtered.map((swarm) => {
              const isSelected = selectedIds.includes(swarm.id);
              return (
                <li key={swarm.id}>
                  <button
                    type="button"
                    onClick={() => toggle(swarm.id)}
                    className={clsx(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
                      isSelected
                        ? 'bg-honey-500/15 ring-1 ring-inset ring-honey-500/30'
                        : 'hover:bg-white/5',
                    )}
                  >
                    <div className="w-4 shrink-0">
                      {isSelected && <Check className="h-3.5 w-3.5 text-honey-400" />}
                    </div>
                    <StatusDot status={swarm.status} />
                    <span className="flex-1 truncate" style={{ color: 'var(--color-text)' }}>{swarm.name}</span>
                    <span className="truncate font-mono text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                      {swarm.id}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status?: string }) {
  const tone =
    status === 'online'
      ? 'bg-emerald-400'
      : status === 'offline'
        ? 'bg-zinc-600'
        : 'bg-amber-400';
  return <span className={clsx('inline-block h-1.5 w-1.5 rounded-full', tone)} />;
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
        <p className="mt-1 text-2xs" style={{ color: 'var(--color-text-muted)' }}>{hint}</p>
      )}
    </div>
  );
}
