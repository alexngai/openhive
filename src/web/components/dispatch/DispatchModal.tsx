import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Loader2, Send, X, Zap, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useMapSwarms } from '../../hooks/useApi';
import { useBootstrapDispatch, useCreateDispatch, type CreatedDispatch } from '../../hooks/useDispatches';
import { toast } from '../../stores/toast';
import { Dialog } from '../common/Dialog';
import type { Spec } from '../../hooks/useSpecs';
import type { MapSwarm } from '../../lib/api';

interface DispatchModalProps {
  open: boolean;
  onClose: () => void;
  spec: Spec;
  onDispatched?: (dispatches: CreatedDispatch[]) => void;
}

/**
 * Determine whether a swarm is a viable dispatch target. v1 rule (per the
 * resolved Stream 2 ambiguities): online and exposes at least one ACP-capable
 * or mail-capable agent. Uses aggregate capabilities the hub records on the
 * swarm record (per CLAUDE.md getAggregateCapabilities).
 */
function isDispatchable(s: MapSwarm): boolean {
  if (s.status !== 'online') return false;
  const caps = (s.capabilities ?? {}) as Record<string, unknown>;
  const protocols = Array.isArray(caps.protocols) ? (caps.protocols as string[]) : [];
  const hasAcp = protocols.includes('acp');
  const mail = caps.mail as Record<string, unknown> | undefined;
  const hasMail = !!mail && (mail.canCreate === true || mail.canJoin === true);
  return hasAcp || hasMail;
}

function explainUnavailable(s: MapSwarm): string {
  if (s.status !== 'online') return s.status;
  return 'no ACP/mail capability';
}

export function DispatchModal({ open, onClose, spec, onDispatched }: DispatchModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState('');
  const [showOffline, setShowOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: swarms = [] } = useMapSwarms();
  const create = useCreateDispatch();
  const bootstrap = useBootstrapDispatch();

  const dispatchable = useMemo(() => swarms.filter(isDispatchable), [swarms]);
  const allListed = showOffline ? swarms : dispatchable;
  const sortedSwarms = useMemo(
    () => [...allListed].sort((a, b) => a.name.localeCompare(b.name)),
    [allListed],
  );

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
      });
      const n = result.dispatches.length;

      // Best-effort hub-side bootstrap. Failures (no swarmcraft, no ACP agent,
      // etc.) are non-fatal — the dispatch row exists at `queued` either way.
      // We tally how many bootstrapped successfully so the toast is honest.
      const bootstrapResults = await Promise.allSettled(
        result.dispatches.map((d) => bootstrap.mutateAsync(d.id)),
      );
      const bootstrapped = bootstrapResults.filter((r) => r.status === 'fulfilled').length;

      const swarmNames = result.dispatches
        .map((d) => d.target_swarm_name ?? d.target_swarm_id)
        .join(', ');
      const headline = n === 1 ? 'Dispatched' : `Dispatched to ${n} swarms`;
      const detail =
        bootstrapped === n
          ? swarmNames
          : `${swarmNames} — ${bootstrapped}/${n} sessions bootstrapped`;
      toast.success(headline, detail);

      onDispatched?.(result.dispatches);
      close();
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
                  : 'No online swarms with ACP or mail capability. Toggle "Show offline / incompatible" to inspect.'}
              </div>
            </div>
          ) : (
            <div
              className="rounded-md border max-h-64 overflow-y-auto divide-y"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              {sortedSwarms.map((s) => {
                const eligible = isDispatchable(s);
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
