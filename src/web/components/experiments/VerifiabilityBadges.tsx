/**
 * VerifiabilityBadges — honesty about how trustworthy a run/experiment is.
 *
 * Three independent axes, each rendered through StatusChip with a typed tone:
 *
 *   1. Provenance — `content_hash` present → "locked" (the config is pinned and
 *      the run is reproducible); null → "exploratory" (fast-iteration, no lock).
 *   2. Claim regime — from the runner's `claim_strength.strength`:
 *        capability                    → success/teal  (real capability lift)
 *        judged / heldOutJudge         → warning/amber (judge-mediated)
 *        gameable                      → danger/red    (the metric can be gamed)
 *        anchor                        → info/blue     (anchored comparison)
 *        null / absent                 → "unverified" neutral
 *   3. Environment fingerprint — a neutral mono chip when present.
 *
 * HARD RULE: NULL fields render as "exploratory / not available" — we NEVER
 * fabricate a regime or a hash we don't have.
 */

import { Lock } from 'lucide-react';
import { StatusChip, type StatusTone } from '../common/StatusChip';
import type { ClaimStrength } from '../../hooks/useExperiments';

export interface VerifiabilitySource {
  content_hash: string | null;
  claim_strength?: ClaimStrength | null;
  env_fingerprint?: unknown | null;
}

function shortHash(hash: string): string {
  // Strip an algorithm prefix (`sha256:`) then keep the leading 8 chars.
  const bare = hash.includes(':') ? hash.slice(hash.indexOf(':') + 1) : hash;
  return bare.slice(0, 8);
}

function claimRegime(
  strength: string | undefined,
): { tone: StatusTone; label: string } | null {
  switch (strength) {
    case 'capability':
      return { tone: 'success', label: 'capability' };
    case 'judged':
      return { tone: 'warning', label: 'judged' };
    case 'heldOutJudge':
      return { tone: 'warning', label: 'held-out judge' };
    case 'gameable':
      return { tone: 'danger', label: 'gameable' };
    case 'anchor':
      return { tone: 'info', label: 'anchor' };
    default:
      // Unknown but non-empty strength → surface it verbatim as neutral so we
      // never silently drop a regime the runner reported.
      return strength ? { tone: 'neutral', label: strength } : null;
  }
}

interface VerifiabilityBadgesProps {
  source: VerifiabilitySource;
  /** Compact mode for table rows — drops the env fingerprint chip. */
  compact?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function VerifiabilityBadges({
  source,
  compact = false,
  size = 'sm',
  className,
}: VerifiabilityBadgesProps) {
  const { content_hash, claim_strength, env_fingerprint } = source;

  const regime = claimRegime(claim_strength?.strength);
  const hasEnv =
    env_fingerprint != null &&
    !(typeof env_fingerprint === 'object' && Object.keys(env_fingerprint).length === 0);

  return (
    <span className={className} style={{ display: 'inline-flex', flexWrap: 'wrap', gap: '0.375rem' }}>
      {/* Provenance */}
      {content_hash ? (
        <StatusChip
          tone="info"
          size={size}
          icon={Lock}
          label={`locked · ${shortHash(content_hash)}`}
          title={`Reproducible — config locked to ${content_hash}`}
        />
      ) : (
        <StatusChip
          tone="neutral"
          size={size}
          label="exploratory"
          title="Fast-iteration run — no config lock, not reproducible"
        />
      )}

      {/* Claim regime */}
      {regime ? (
        <StatusChip
          tone={regime.tone}
          size={size}
          label={regime.label}
          title={
            claim_strength?.label
              ? `Claim regime: ${claim_strength.label}`
              : `Claim regime: ${regime.label}`
          }
        />
      ) : (
        <StatusChip
          tone="neutral"
          size={size}
          label="unverified"
          title="No claim regime reported — verifiability unknown"
        />
      )}

      {/* Environment fingerprint */}
      {!compact && hasEnv && (
        <span
          className="inline-flex items-center rounded font-mono text-2xs px-1.5 py-0.5"
          style={{
            backgroundColor: 'var(--color-surface)',
            color: 'var(--color-text-muted)',
          }}
          title="Environment fingerprint recorded at run time"
        >
          env✓
        </span>
      )}
    </span>
  );
}
