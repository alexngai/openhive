import { useCallback, useState } from 'react';
import { Copy, Check, Zap } from 'lucide-react';
import clsx from 'clsx';
import type { Spec } from '../../hooks/useSpecs';

const PRIORITY_COLORS: Record<number, string> = {
  0: 'bg-red-600',
  1: 'bg-orange-600',
  2: 'bg-yellow-600',
  3: 'bg-blue-600',
  4: 'bg-gray-600',
};

const PRIORITY_LABELS: Record<number, string> = {
  0: 'P0',
  1: 'P1',
  2: 'P2',
  3: 'P3',
  4: 'P4',
};

interface SpecCardProps {
  spec: Spec;
  onClick?: (spec: Spec) => void;
}

export function SpecCard({ spec, onClick }: SpecCardProps) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(() => {
    onClick?.(spec);
  }, [spec, onClick]);

  const handleCopyId = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(spec.id);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy id:', err);
      }
    },
    [spec.id],
  );

  const preview = spec.content
    ? spec.content.slice(0, 200) + (spec.content.length > 200 ? '…' : '')
    : '';

  return (
    <div
      onClick={handleClick}
      className={clsx(
        'cursor-pointer rounded-lg border p-4 transition-shadow hover:shadow-md',
        spec.archived && 'opacity-60',
      )}
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      <div className="flex flex-col gap-3">
        {/* Header: id, priority */}
        <div className="flex items-center justify-between gap-2">
          <div className="group flex items-center gap-1 min-w-0">
            <span
              className="font-mono text-xs truncate"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {spec.id}
            </span>
            <button
              type="button"
              onClick={handleCopyId}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-white/10"
              title={copied ? 'Copied' : 'Copy ID'}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </button>
          </div>
          {spec.priority !== undefined && spec.priority <= 3 && (
            <span
              className={clsx(
                'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-white',
                PRIORITY_COLORS[spec.priority],
              )}
            >
              {PRIORITY_LABELS[spec.priority]}
            </span>
          )}
        </div>

        {/* Title */}
        <h3
          className="line-clamp-2 text-base font-semibold"
          style={{ color: 'var(--color-text)' }}
        >
          {spec.title || 'Untitled spec'}
        </h3>

        {/* Preview */}
        {preview && (
          <p
            className="line-clamp-3 text-sm"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            {preview}
          </p>
        )}

        {/* Footer: source chip */}
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          <span className="truncate">{spec.resource_name}</span>
          {spec.swarm_name && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1 truncate">
                <Zap className="h-3 w-3 text-honey-500" />
                {spec.swarm_name}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
