import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  Loader2,
  Send,
  X,
  Zap,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Settings2,
} from 'lucide-react';
import {
  useMapSwarmsForPicker,
  useResourcesByType,
  useRepos,
} from '../../hooks/useApi';
import { useCreateDispatch, type CreatedDispatch } from '../../hooks/useDispatch';
import { toast } from '../../stores/toast';
import { Dialog } from '../common/Dialog';
import { TimeAgo } from '../common/TimeAgo';
import type { Spec } from '../../hooks/useSpecs';
import type { MapSwarm } from '../../lib/api';

type PickerSwarm = MapSwarm & { variant_count?: number };
const CODEX_EXECUTOR_KIND = 'swarm-codex';

/**
 * Dispatch-validation preset (P5.3). When present, the modal opens prefilled to
 * re-dispatch the same spec as a reviewer-role validation of a completed run:
 * reviewer prompt template, `role: reviewer`, Advanced expanded, and a target
 * swarm defaulted to one *other* than the executor.
 */
export interface ValidationPreset {
  /** Completed dispatch's outcome summary (what was done). */
  summary?: string;
  /** Swarm that executed the work — excluded from the default target pick. */
  executorSwarmId?: string;
  /** `cascade_stream` artifact ref (the diff), surfaced in the review prompt. */
  streamRef?: string;
}

interface DispatchModalProps {
  open: boolean;
  onClose: () => void;
  spec: Spec;
  onDispatched?: (dispatches: CreatedDispatch[]) => void;
  validationPreset?: ValidationPreset;
}

function buildValidationPrompt(spec: Spec, preset: ValidationPreset): string {
  const lines = [
    `You are validating completed work for spec "${spec.title || spec.id}".`,
    '',
    '## What was done',
    preset.summary?.trim() || '(the executor left no outcome summary)',
    '',
    '## Review against',
    "- The spec's acceptance criteria and requirements.",
  ];
  if (preset.streamRef) {
    lines.push(`- Changes / diff: ${preset.streamRef}`);
  }
  lines.push(
    '',
    '## Your task',
    'Verify the implementation satisfies the spec. Check correctness, tests, and edge cases.',
    'Post a clear verdict — APPROVED or CHANGES REQUESTED — with specific, actionable findings.',
  );
  return lines.join('\n');
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeKind(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isCodexExecutorTarget(s: MapSwarm): boolean {
  const metadata = asObject(s.metadata);
  const capabilities = asObject(s.capabilities);
  const dispatch = asObject(capabilities.dispatch);
  const stringMarkers = [
    metadata.kind,
    metadata.executor_kind,
    metadata.dispatch_executor,
    capabilities.kind,
    capabilities.executor_kind,
    dispatch.kind,
    dispatch.executor,
  ].map(normalizeKind);

  if (stringMarkers.includes(CODEX_EXECUTOR_KIND)) return true;
  if (capabilities.codex_executor === true) return true;
  if (dispatch.codex_executor === true) return true;

  const executors = Array.isArray(dispatch.executors)
    ? dispatch.executors.map(normalizeKind)
    : [];
  return executors.includes(CODEX_EXECUTOR_KIND);
}

function isDispatchable(s: MapSwarm): boolean {
  if (s.status !== 'online') return false;
  const caps = asObject(s.capabilities);
  const protocols = Array.isArray(caps.protocols) ? (caps.protocols as string[]) : [];
  const hasAcp = protocols.includes('acp');
  const mail = asObject(caps.mail);
  const hasMail = mail.canCreate === true || mail.canJoin === true;
  return hasAcp || hasMail || isCodexExecutorTarget(s);
}

function explainUnavailable(s: MapSwarm): string {
  if (s.status !== 'online') return s.status;
  return 'no ACP/mail/codex executor capability';
}

export function DispatchModal({ open, onClose, spec, onDispatched, validationPreset }: DispatchModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState('');
  const [showOffline, setShowOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Advanced (P4.1) — collapsed by default so the simple case stays ~2 clicks.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [teamId, setTeamId] = useState('');
  const [loadoutId, setLoadoutId] = useState('');
  const [role, setRole] = useState('');
  const [repoId, setRepoId] = useState('');
  const [branch, setBranch] = useState('');
  const [acpLifecycle, setAcpLifecycle] = useState<'' | 'fresh' | 'reuse'>('');
  const [mailLifecycle, setMailLifecycle] = useState<'' | 'fresh' | 'reuse'>('');
  // Coordinated-team mode (P4.2) — only meaningful with >1 target.
  const [coordinated, setCoordinated] = useState(false);
  const navigate = useNavigate();

  const { data: swarms = [] } = useMapSwarmsForPicker();
  const { data: teamResources } = useResourcesByType('team_template', { limit: 100 });
  const { data: loadoutResources } = useResourcesByType('loadout', { limit: 100 });
  const { data: reposData } = useRepos({ limit: 100 });
  const create = useCreateDispatch();

  const dispatchable = useMemo(() => swarms.filter(isDispatchable), [swarms]);
  const allListed = showOffline ? swarms : dispatchable;
  const sortedSwarms = useMemo(
    () => [...allListed].sort((a, b) => a.name.localeCompare(b.name)),
    [allListed],
  );
  const selectedCodexTargets = useMemo(
    () => swarms.filter((s) => selected.has(s.id) && isCodexExecutorTarget(s)),
    [selected, swarms],
  );

  // Apply the validation preset once each time the modal is opened with one.
  // The prompt/role/Advanced prefill must NOT wait for the swarm list — a hub
  // with zero online swarms should still show the reviewer template so the user
  // can bring a swarm online and dispatch. Swarm auto-select is a separate,
  // best-effort step gated on the list being loaded.
  const presetTextAppliedRef = useRef(false);
  const presetSwarmAppliedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      presetTextAppliedRef.current = false;
      presetSwarmAppliedRef.current = false;
      return;
    }
    if (!validationPreset) return;
    if (!presetTextAppliedRef.current) {
      presetTextAppliedRef.current = true;
      setPrompt(buildValidationPrompt(spec, validationPreset));
      setRole('reviewer');
      setShowAdvanced(true);
    }
    if (!presetSwarmAppliedRef.current && dispatchable.length > 0) {
      presetSwarmAppliedRef.current = true;
      const reviewer = dispatchable.find((s) => s.id !== validationPreset.executorSwarmId);
      if (reviewer) setSelected(new Set([reviewer.id]));
    }
  }, [open, validationPreset, spec, dispatchable]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const close = () => {
    setSelected(new Set());
    setPrompt('');
    setError(null);
    setShowOffline(false);
    setShowAdvanced(false);
    setTeamId('');
    setLoadoutId('');
    setRole('');
    setRepoId('');
    setBranch('');
    setAcpLifecycle('');
    setMailLifecycle('');
    setCoordinated(false);
    onClose();
  };

  const handleConfirm = async () => {
    if (selected.size === 0) {
      setError('Pick at least one swarm to dispatch to.');
      return;
    }
    setError(null);
    try {
      const result = await create.mutateAsync({
        resource_id: spec.resource_id,
        spec_id: spec.id,
        target_swarms: Array.from(selected),
        prompt: prompt.trim() || undefined,
        loadout_resource_id: loadoutId || undefined,
        team_template_resource_id: teamId || undefined,
        role: role.trim() || undefined,
        acp_lifecycle: acpLifecycle || undefined,
        mail_lifecycle: mailLifecycle || undefined,
        repo_id: repoId || undefined,
        branch: branch.trim() || undefined,
        coordinated: selected.size > 1 && coordinated ? true : undefined,
      });
      const n = result.dispatches.length;
      onDispatched?.(result.dispatches);
      close();

      // Single-swarm dispatch: auto-navigate to the detail page so the user
      // sees status + outcome progress immediately. Multi-swarm: fall back
      // to a toast (no single detail to land on) and let the user drill in
      // from the Dispatch list — navigating to one of N would be
      // arbitrary.
      if (n === 1) {
        navigate(`/dispatch/${result.dispatches[0].id}`);
      } else {
        const swarmNames = result.dispatches
          .map((d) => d.target_swarm_name ?? d.target_swarm_id)
          .join(', ');
        toast.success(
          `Dispatched to ${n} swarms`,
          `${swarmNames} — orchestrator will pick up and bootstrap`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={open} onClose={close}>
      <div className="space-y-4 p-5">
        <h2
          className="text-lg font-semibold flex items-center gap-2"
          style={{ color: 'var(--color-text)' }}
        >
          <Send className="h-4 w-4 text-honey-500" />
          Dispatch &ldquo;{spec.title || 'Untitled spec'}&rdquo;
        </h2>
        {/* Spec ref preview */}
        <div
          className="text-xs"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <span className="font-mono">{spec.id}</span>
          <span> · {spec.resource_name}</span>
        </div>

        {/* Swarm picker */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
              Target swarms
            </label>
            <label
              className="flex items-center gap-1.5 text-xs cursor-pointer"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <input
                type="checkbox"
                checked={showOffline}
                onChange={(e) => setShowOffline(e.target.checked)}
                className="rounded"
              />
              Show offline / incompatible
            </label>
          </div>

          {sortedSwarms.length === 0 ? (
            <div
              className="rounded-md border p-3 text-sm flex items-start gap-2"
              style={{
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text-muted)',
              }}
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                {showOffline
                  ? 'No swarms are registered with this hub.'
                  : 'No online swarms with ACP, mail, or Codex executor capability. Toggle "Show offline / incompatible" to inspect.'}
              </div>
            </div>
          ) : (
            <div
              className="rounded-md border max-h-64 overflow-y-auto divide-y"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              {sortedSwarms.map((s) => {
                const ps = s as PickerSwarm;
                const eligible = isDispatchable(s);
                const isCodex = isCodexExecutorTarget(s);
                const checked = selected.has(s.id);
                return (
                  <label
                    key={s.id}
                    className={clsx(
                      'flex items-center gap-2 px-3 py-2 text-sm',
                      eligible ? 'cursor-pointer hover:bg-white/5' : 'opacity-50 cursor-not-allowed',
                    )}
                    style={{ borderColor: 'var(--color-border-subtle)' }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => eligible && toggle(s.id)}
                      disabled={!eligible}
                      className="rounded"
                    />
                    <Zap className="h-3.5 w-3.5 text-honey-500 shrink-0" />
                    <span className="truncate flex-1" style={{ color: 'var(--color-text)' }}>
                      {s.name}
                    </span>
                    {isCodex && (
                      <span
                        className="text-2xs shrink-0 px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300"
                      >
                        Codex
                      </span>
                    )}
                    {s.last_seen_at && (
                      <TimeAgo date={s.last_seen_at} className="text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                    )}
                    {(ps.variant_count ?? 0) > 1 && (
                      <span className="text-2xs shrink-0 px-1 rounded bg-white/5" style={{ color: 'var(--color-text-muted)' }}>
                        ×{ps.variant_count}
                      </span>
                    )}
                    {!eligible && (
                      <span
                        className="text-xs shrink-0"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        {explainUnavailable(s)}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {selectedCodexTargets.length > 0 && (
          <div
            className="rounded-md border p-3 text-sm flex items-start gap-2"
            style={{
              borderColor: 'rgba(245, 158, 11, 0.45)',
              background: 'rgba(245, 158, 11, 0.08)',
              color: 'var(--color-text)',
            }}
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-300" />
            <div className="space-y-1">
              <div className="font-medium">
                Codex dispatch uses full filesystem access by default.
              </div>
              <div className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                Selected Codex executor{selectedCodexTargets.length === 1 ? '' : 's'} run with{' '}
                <span className="font-mono">danger-full-access</span> unless the operator
                overrides <span className="font-mono">dispatch.codex_executor.sandbox</span>.
              </div>
            </div>
          </div>
        )}

        {/* Optional prompt */}
        <div>
          <label
            className="block text-xs mb-1"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Additional instructions (optional)
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Anything beyond what's already in the spec (constraints, deadlines, hints)…"
            className="w-full min-h-[80px] px-3 py-2 rounded-md border bg-transparent text-sm outline-none focus:ring-1 focus:ring-honey-500 resize-y"
            style={{
              borderColor: 'var(--color-border-subtle)',
              color: 'var(--color-text)',
            }}
            maxLength={5000}
          />
        </div>

        {/* Advanced (P4.1): loadout / team+role / repo / lifecycle */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1.5 text-xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {showAdvanced ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            <Settings2 className="h-3.5 w-3.5" />
            Advanced
          </button>

          {showAdvanced && (
            <div
              className="mt-3 space-y-3 rounded-md border p-3"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs block">
                  <span className="block mb-1" style={{ color: 'var(--color-text-muted)' }}>
                    Team template
                  </span>
                  <select
                    value={teamId}
                    onChange={(e) => setTeamId(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-md border bg-transparent text-sm outline-none focus:ring-1 focus:ring-honey-500"
                    style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
                  >
                    <option value="">— none —</option>
                    {(teamResources?.data ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs block">
                  <span className="block mb-1" style={{ color: 'var(--color-text-muted)' }}>
                    Loadout
                  </span>
                  <select
                    value={loadoutId}
                    onChange={(e) => setLoadoutId(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-md border bg-transparent text-sm outline-none focus:ring-1 focus:ring-honey-500"
                    style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
                  >
                    <option value="">— none —</option>
                    {(loadoutResources?.data ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {(teamId || loadoutId || role) && (
                <label className="text-xs block">
                  <span className="block mb-1" style={{ color: 'var(--color-text-muted)' }}>
                    Role{teamId ? '' : ' (advisory)'}
                  </span>
                  <input
                    type="text"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder={teamId ? 'e.g. reviewer' : 'e.g. worker'}
                    className="w-full px-2 py-1.5 rounded-md border bg-transparent text-sm outline-none focus:ring-1 focus:ring-honey-500"
                    style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
                  />
                </label>
              )}

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs block">
                  <span className="block mb-1" style={{ color: 'var(--color-text-muted)' }}>
                    Repo
                  </span>
                  <select
                    value={repoId}
                    onChange={(e) => setRepoId(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-md border bg-transparent text-sm outline-none focus:ring-1 focus:ring-honey-500"
                    style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
                  >
                    <option value="">— spec default —</option>
                    {(reposData?.data ?? []).map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs block">
                  <span className="block mb-1" style={{ color: 'var(--color-text-muted)' }}>
                    Branch
                  </span>
                  <input
                    type="text"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="default"
                    disabled={!repoId}
                    className="w-full px-2 py-1.5 rounded-md border bg-transparent text-sm outline-none focus:ring-1 focus:ring-honey-500 disabled:opacity-50"
                    style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs block">
                  <span className="block mb-1" style={{ color: 'var(--color-text-muted)' }}>
                    ACP lifecycle
                  </span>
                  <select
                    value={acpLifecycle}
                    onChange={(e) => setAcpLifecycle(e.target.value as '' | 'fresh' | 'reuse')}
                    className="w-full px-2 py-1.5 rounded-md border bg-transparent text-sm outline-none focus:ring-1 focus:ring-honey-500"
                    style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
                  >
                    <option value="">default</option>
                    <option value="fresh">fresh</option>
                    <option value="reuse">reuse</option>
                  </select>
                </label>
                <label className="text-xs block">
                  <span className="block mb-1" style={{ color: 'var(--color-text-muted)' }}>
                    Mail lifecycle
                  </span>
                  <select
                    value={mailLifecycle}
                    onChange={(e) => setMailLifecycle(e.target.value as '' | 'fresh' | 'reuse')}
                    className="w-full px-2 py-1.5 rounded-md border bg-transparent text-sm outline-none focus:ring-1 focus:ring-honey-500"
                    style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
                  >
                    <option value="">default</option>
                    <option value="fresh">fresh</option>
                    <option value="reuse">reuse</option>
                  </select>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Error */}
        {error && (
          <div
            className="rounded-md border p-3 text-sm flex items-start gap-2"
            style={{
              borderColor: 'var(--color-border-subtle)',
              color: 'var(--color-text)',
            }}
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />
            <div>{error}</div>
          </div>
        )}

        {/* Coordinated-team toggle (P4.2) — only relevant for a fan-out. */}
        {selected.size > 1 && (
          <label
            className="flex items-start gap-2 text-xs cursor-pointer rounded-md border p-2.5"
            style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
          >
            <input
              type="checkbox"
              checked={coordinated}
              onChange={(e) => setCoordinated(e.target.checked)}
              className="rounded mt-0.5"
            />
            <span>
              <span className="font-medium">Coordinate as a team</span>
              <span className="block mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                Share one mail thread across all {selected.size} agents; each prompt names its
                peers. Leave off for independent per-dispatch threads.
              </span>
            </span>
          </label>
        )}

        {/* Selected summary */}
        {selected.size > 0 && (
          <div
            className="text-xs flex items-center gap-1"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <CheckCircle2 className="h-3 w-3 text-honey-500" />
            {selected.size} swarm{selected.size === 1 ? '' : 's'} selected
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={close}
            disabled={create.isPending}
            className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded hover:bg-white/5 disabled:opacity-50"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            <X className="h-4 w-4" />
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={create.isPending || selected.size === 0}
            className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded bg-honey-500 text-black font-medium hover:bg-honey-400 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Dispatch
          </button>
        </div>
      </div>
    </Dialog>
  );
}
