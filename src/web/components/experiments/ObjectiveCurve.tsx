/**
 * ObjectiveCurve — a small hand-rolled SVG line chart of the objective over
 * cycle index. No chart lib (the repo bundles none).
 *
 * Two series: held-out (solid) and train (dashed), keyed by candidate
 * cycle_index → score_held_out / score_train. If no candidate carries a
 * held-out score (the lightweight/inline-config path has no held-out split),
 * we draw the train series alone and label it single-scalar.
 *
 * Responsive width (viewBox + preserveAspectRatio), ~180px tall, semantic-token
 * colors, accessible (role=img + <title>/<desc>).
 */

import { useId } from 'react';
import type { ExperimentCandidate } from '../../hooks/useExperiments';

interface Point {
  cycle: number;
  value: number;
}

interface ObjectiveCurveProps {
  candidates: ExperimentCandidate[];
  className?: string;
}

const VIEW_W = 600;
const VIEW_H = 180;
const PAD_L = 36;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 24;

function seriesFrom(
  candidates: ExperimentCandidate[],
  pick: (c: ExperimentCandidate) => number | null,
): Point[] {
  const pts: Point[] = [];
  for (const c of candidates) {
    if (c.cycle_index == null) continue;
    const v = pick(c);
    if (v == null) continue;
    pts.push({ cycle: c.cycle_index, value: v });
  }
  // Sort by cycle, and on duplicate cycles keep the last (latest projection).
  pts.sort((a, b) => a.cycle - b.cycle);
  const byCycle = new Map<number, number>();
  for (const p of pts) byCycle.set(p.cycle, p.value);
  return [...byCycle.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cycle, value]) => ({ cycle, value }));
}

export function ObjectiveCurve({ candidates, className }: ObjectiveCurveProps) {
  const titleId = useId();
  const descId = useId();

  const heldOut = seriesFrom(candidates, (c) => c.score_held_out);
  const train = seriesFrom(candidates, (c) => c.score_train);
  const hasHeldOut = heldOut.length > 0;
  const hasTrain = train.length > 0;

  if (!hasHeldOut && !hasTrain) {
    return (
      <div
        className={className}
        style={{ color: 'var(--color-text-muted)' }}
      >
        <p className="text-2xs">No scored candidates yet — nothing to plot.</p>
      </div>
    );
  }

  const all = [...heldOut, ...train];
  const cycles = all.map((p) => p.cycle);
  const values = all.map((p) => p.value);
  const minCycle = Math.min(...cycles);
  const maxCycle = Math.max(...cycles);
  let minVal = Math.min(...values);
  let maxVal = Math.max(...values);
  // Pad the value range a touch so flat lines don't hug an edge.
  if (minVal === maxVal) {
    minVal -= 0.5;
    maxVal += 0.5;
  } else {
    const pad = (maxVal - minVal) * 0.08;
    minVal -= pad;
    maxVal += pad;
  }
  const cycleSpan = maxCycle - minCycle || 1;

  const x = (cycle: number) =>
    PAD_L + ((cycle - minCycle) / cycleSpan) * (VIEW_W - PAD_L - PAD_R);
  const y = (value: number) =>
    PAD_T + (1 - (value - minVal) / (maxVal - minVal)) * (VIEW_H - PAD_T - PAD_B);

  const toPath = (pts: Point[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.cycle).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');

  const label = hasHeldOut
    ? 'Objective over cycles: held-out (solid) vs train (dashed).'
    : 'Objective over cycles: single train score (no held-out split on this run).';

  return (
    <div className={className}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        width="100%"
        height={VIEW_H}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
      >
        <title id={titleId}>Objective curve</title>
        <desc id={descId}>{label}</desc>

        {/* Axes */}
        <line
          x1={PAD_L}
          y1={PAD_T}
          x2={PAD_L}
          y2={VIEW_H - PAD_B}
          stroke="var(--color-border-subtle)"
          strokeWidth={1}
        />
        <line
          x1={PAD_L}
          y1={VIEW_H - PAD_B}
          x2={VIEW_W - PAD_R}
          y2={VIEW_H - PAD_B}
          stroke="var(--color-border-subtle)"
          strokeWidth={1}
        />

        {/* y-axis min/max labels */}
        <text x={PAD_L - 6} y={PAD_T + 8} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">
          {maxVal.toFixed(2)}
        </text>
        <text x={PAD_L - 6} y={VIEW_H - PAD_B} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">
          {minVal.toFixed(2)}
        </text>
        <text x={PAD_L} y={VIEW_H - 6} textAnchor="start" fontSize={10} fill="var(--color-text-muted)">
          cycle {minCycle}
        </text>
        <text x={VIEW_W - PAD_R} y={VIEW_H - 6} textAnchor="end" fontSize={10} fill="var(--color-text-muted)">
          cycle {maxCycle}
        </text>

        {/* Train series (dashed) */}
        {hasTrain && (
          <>
            <path
              d={toPath(train)}
              fill="none"
              stroke="var(--color-text-muted)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            {train.map((p) => (
              <circle key={`t-${p.cycle}`} cx={x(p.cycle)} cy={y(p.value)} r={2.5} fill="var(--color-text-muted)" />
            ))}
          </>
        )}

        {/* Held-out series (solid, accent) */}
        {hasHeldOut && (
          <>
            <path
              d={toPath(heldOut)}
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2}
            />
            {heldOut.map((p) => (
              <circle key={`h-${p.cycle}`} cx={x(p.cycle)} cy={y(p.value)} r={2.5} fill="var(--color-accent)" />
            ))}
          </>
        )}
      </svg>

      {/* Legend */}
      <div className="mt-1 flex items-center gap-4 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
        {hasHeldOut && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4 rounded"
              style={{ backgroundColor: 'var(--color-accent)' }}
            />
            held-out
          </span>
        )}
        {hasTrain && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-0 w-4"
              style={{ borderTop: '1.5px dashed var(--color-text-muted)' }}
            />
            train
          </span>
        )}
        {!hasHeldOut && hasTrain && (
          <span className="italic">single-scalar (no held-out split)</span>
        )}
      </div>
    </div>
  );
}
