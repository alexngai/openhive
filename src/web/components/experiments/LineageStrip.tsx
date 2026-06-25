/**
 * LineageStrip — the horizontal, cycle-ordered strip of candidate nodes:
 * baseline → c1 → c2 … Each node is colored by status, with the
 * promoted/incumbent candidate getting an accent ring + trophy. Horizontal
 * scroll on overflow (never wraps — the left-to-right order IS the lineage).
 *
 * This is intentionally NOT a graph: v1 shows the cycle-ordered candidate
 * sequence, which is what the projection actually guarantees.
 */

import { Fragment } from 'react';
import { ChevronRight, Trophy } from 'lucide-react';
import { candidateStatusTone } from './tones';
import { StatusDot } from '../common/StatusChip';
import type { ExperimentCandidate } from '../../hooks/useExperiments';

interface LineageStripProps {
  candidates: ExperimentCandidate[];
  /** The experiment's incumbent candidate id, if any — gets the trophy ring. */
  incumbentId?: string | null;
  className?: string;
}

function orderCandidates(candidates: ExperimentCandidate[]): ExperimentCandidate[] {
  return [...candidates].sort((a, b) => {
    const ca = a.cycle_index ?? Number.MAX_SAFE_INTEGER;
    const cb = b.cycle_index ?? Number.MAX_SAFE_INTEGER;
    if (ca !== cb) return ca - cb;
    return a.created_at.localeCompare(b.created_at);
  });
}

export function LineageStrip({ candidates, incumbentId, className }: LineageStripProps) {
  if (candidates.length === 0) {
    return (
      <p className={className} style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
        No candidates projected yet.
      </p>
    );
  }

  const ordered = orderCandidates(candidates);

  return (
    <div className={className}>
      <div className="flex items-center gap-1 overflow-x-auto pb-2">
        {ordered.map((c, i) => {
          const { tone, label } = candidateStatusTone(c.status);
          const isIncumbent = !!incumbentId && c.id === incumbentId;
          const isPromoted = c.promoted || isIncumbent;
          const dotTone = isPromoted ? 'accent' : tone;
          const dashed = c.status === 'discard';

          return (
            <Fragment key={c.id}>
              {i > 0 && (
                <ChevronRight
                  className="h-3 w-3 shrink-0"
                  style={{ color: 'var(--color-text-muted)' }}
                />
              )}
              <div
                className="flex shrink-0 flex-col items-center gap-1 rounded-md px-2 py-1.5"
                style={{
                  backgroundColor: 'var(--color-surface)',
                  border: isPromoted
                    ? '1px solid var(--color-accent)'
                    : dashed
                      ? '1px dashed var(--color-border-subtle)'
                      : '1px solid var(--color-border-subtle)',
                  minWidth: '4.5rem',
                }}
                title={`${c.candidate_ref} — ${label}${c.cycle_index != null ? ` (cycle ${c.cycle_index})` : ''}`}
              >
                <div className="flex items-center gap-1">
                  <StatusDot tone={dotTone} />
                  {isPromoted && (
                    <Trophy className="h-3 w-3" style={{ color: 'var(--color-accent)' }} />
                  )}
                </div>
                <span
                  className="font-mono text-2xs truncate max-w-[5rem]"
                  style={{ color: 'var(--color-text)' }}
                >
                  {c.candidate_ref}
                </span>
                <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                  {label}
                </span>
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
