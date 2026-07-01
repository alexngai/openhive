/**
 * MapControls — shared zoom/fit toolbar used by both the Network (sigma) and
 * Hierarchy (React Flow) views.
 *
 * Previously each view rendered its own controls — Network used custom icon
 * buttons, Hierarchy used React Flow's built-in `<Controls>`. Same position,
 * different visual weight. Sharing one component means switching views
 * doesn't change the chrome.
 */

import { memo } from 'react';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

export interface MapControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
}

function ButtonImpl({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="btn-ghost p-1.5 rounded"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      {children}
    </button>
  );
}

function MapControlsInner({ onZoomIn, onZoomOut, onFitView }: MapControlsProps) {
  return (
    <div
      className="absolute bottom-3 left-3 flex flex-col gap-1"
      style={{ zIndex: 5 }}
    >
      <ButtonImpl onClick={onZoomIn} title="Zoom in">
        <ZoomIn className="w-4 h-4" />
      </ButtonImpl>
      <ButtonImpl onClick={onZoomOut} title="Zoom out">
        <ZoomOut className="w-4 h-4" />
      </ButtonImpl>
      <ButtonImpl onClick={onFitView} title="Fit graph in view">
        <Maximize2 className="w-4 h-4" />
      </ButtonImpl>
    </div>
  );
}

export const MapControls = memo(MapControlsInner);
