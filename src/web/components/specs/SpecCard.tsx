import { useCallback, useState } from 'react';
import { Copy, Check, Zap } from 'lucide-react';
import clsx from 'clsx';
import type { Spec } from '../../hooks/useSpecs';
import { StatusChip } from '../common/StatusChip';
import { PRIORITY_MAP } from './specPriority';

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
      className={clsx('card card-hover cursor-pointer', spec.archived && 'opacity-60')}
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
          {spec.priority !== undefined && PRIORITY_MAP[spec.priority] && (
            <StatusChip
              tone={PRIORITY_MAP[spec.priority].tone}
              label={PRIORITY_MAP[spec.priority].label}
            />
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
