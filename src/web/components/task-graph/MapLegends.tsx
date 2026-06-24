/**
 * MapLegends — small reusable legend components used by both the Network
 * (sigma) and Hierarchy (React Flow) views.
 *
 * Keeps the legend visuals identical across views so users switching tabs
 * don't get a different decoder for the same status / source-graph color.
 */

import type { ReactNode } from 'react';
import { STATUS_COLORS } from './useTaskGraph';

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function LegendFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div
      className="p-2 rounded text-2xs space-y-1"
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-border-subtle)',
      }}
    >
      <div
        className="text-2xs font-medium mb-1"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

export function StatusLegend() {
  return (
    <LegendFrame title="Status">
      {Object.entries(STATUS_COLORS).map(([status, color]) => (
        <div key={status} className="flex items-center gap-1.5">
          <div
            className="w-2.5 h-2.5 rounded-full"
            style={{
              backgroundColor: color,
              boxShadow: `0 0 6px ${hexToRgba(color, 0.5)}`,
            }}
          />
          <span style={{ color: 'var(--color-text-muted)' }}>
            {status.replace('_', ' ')}
          </span>
        </div>
      ))}
    </LegendFrame>
  );
}

export function GraphSourcesLegend({
  graphSources,
}: {
  graphSources: Map<string, { name: string; color: string }>;
}) {
  return (
    <LegendFrame title="Graphs">
      {Array.from(graphSources.entries()).map(([id, { name, color }]) => (
        <div key={id} className="flex items-center gap-1.5">
          <div
            className="w-2.5 h-2.5 rounded-full border-2"
            style={{ borderColor: color, backgroundColor: 'transparent' }}
          />
          <span
            className="truncate max-w-[120px]"
            style={{ color: 'var(--color-text-muted)' }}
          >
            {name}
          </span>
        </div>
      ))}
    </LegendFrame>
  );
}
