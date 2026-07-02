/**
 * SpawnPreflightCallout — renders the failed checks from
 * GET /map/hosted/spawn/preflight as an inline callout, with an
 * "attempt anyway" escape hatch (the hub's PATH can differ from the
 * probe's view, so a hard block would be wrong).
 *
 * Renders nothing while loading or when every check passes — preflight
 * is guidance, not ceremony.
 */

import { AlertTriangle } from 'lucide-react';
import type { SpawnPreflightResult } from '../../hooks/useApi';

interface SpawnPreflightCalloutProps {
  preflight: SpawnPreflightResult | undefined;
  attemptAnyway: boolean;
  onAttemptAnywayChange: (value: boolean) => void;
}

export function SpawnPreflightCallout({
  preflight,
  attemptAnyway,
  onAttemptAnywayChange,
}: SpawnPreflightCalloutProps) {
  if (!preflight || preflight.ready) return null;
  const failed = preflight.checks.filter((c) => !c.ok);

  return (
    <div
      className="rounded-md border px-3 py-2 space-y-1.5"
      style={{
        borderColor: 'rgba(251, 191, 36, 0.3)',
        backgroundColor: 'rgba(251, 191, 36, 0.06)',
      }}
      role="alert"
    >
      <p className="text-xs font-medium flex items-center gap-1.5 text-amber-400">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        This spawn is likely to fail
      </p>
      <ul className="space-y-0.5">
        {failed.map((check) => (
          <li
            key={check.id}
            className="text-2xs leading-snug"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {check.message ?? check.id}
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-1.5 text-2xs cursor-pointer" style={{ color: 'var(--color-text-muted)' }}>
        <input
          type="checkbox"
          checked={attemptAnyway}
          onChange={(e) => onAttemptAnywayChange(e.target.checked)}
          className="accent-amber-400"
        />
        Attempt anyway (the spawn environment&apos;s PATH may differ)
      </label>
    </div>
  );
}
