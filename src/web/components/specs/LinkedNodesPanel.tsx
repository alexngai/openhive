import clsx from 'clsx';
import type { LinkedNode } from '../../hooks/useSpecs';

interface LinkedNodesPanelProps {
  title: string;
  icon?: React.ReactNode;
  nodes: LinkedNode[];
  emptyMessage?: string;
  variant?: 'task' | 'context' | 'feedback' | 'spec' | 'issue' | 'other';
  onNodeClick?: (node: LinkedNode) => void;
}

const STATUS_COLORS: Record<string, string> = {
  open: 'text-blue-400',
  in_progress: 'text-amber-400',
  blocked: 'text-red-400',
  completed: 'text-emerald-400',
  closed: 'text-emerald-400',
  failed: 'text-red-400',
};

export function LinkedNodesPanel({
  title,
  icon,
  nodes,
  emptyMessage,
  variant = 'other',
  onNodeClick,
}: LinkedNodesPanelProps) {
  return (
    <div
      className="rounded-md border"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-surface)',
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
            {title}
          </h3>
        </div>
        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {nodes.length}
        </span>
      </div>

      {nodes.length === 0 ? (
        <div className="px-3 py-4 text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {emptyMessage ?? 'None'}
        </div>
      ) : (
        <ul className="divide-y" style={{ borderColor: 'var(--color-border-subtle)' }}>
          {nodes.map((node) => {
            const status = node.status || (variant === 'task' ? 'open' : null);
            const statusClass = status ? STATUS_COLORS[status] || 'text-gray-400' : '';
            const preview =
              variant === 'feedback' && node.content
                ? node.content.slice(0, 120) + (node.content.length > 120 ? '…' : '')
                : null;

            return (
              <li
                key={node.id}
                className={clsx(
                  'px-3 py-2 text-sm',
                  onNodeClick && 'cursor-pointer hover:bg-white/5',
                )}
                onClick={onNodeClick ? () => onNodeClick(node) : undefined}
                style={{
                  borderColor: 'var(--color-border-subtle)',
                }}
              >
                <div className="flex items-start gap-2">
                  <span
                    className="font-mono text-xs shrink-0 mt-0.5"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {node.id}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span
                        className="truncate"
                        style={{ color: 'var(--color-text)' }}
                      >
                        {node.title || 'Untitled'}
                      </span>
                      {status && (
                        <span className={clsx('text-xs shrink-0', statusClass)}>{status}</span>
                      )}
                    </div>
                    {preview && (
                      <div
                        className="mt-1 text-xs line-clamp-2"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        {preview}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
