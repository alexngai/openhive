import { useState } from 'react';
import clsx from 'clsx';
import { Plus, X, Loader2 } from 'lucide-react';
import type { LinkedNode, EdgeType } from '../../hooks/useSpecs';
import { EDGE_TYPES } from '../../hooks/useSpecs';

interface LinkedNodesPanelProps {
  title: string;
  icon?: React.ReactNode;
  nodes: LinkedNode[];
  emptyMessage?: string;
  variant?: 'task' | 'context' | 'feedback' | 'spec' | 'issue' | 'other';
  onNodeClick?: (node: LinkedNode) => void;
  onLink?: (targetId: string, edgeType: EdgeType, direction: 'inbound' | 'outbound') => Promise<void>;
  onUnlink?: (targetId: string, edgeType: EdgeType) => Promise<void>;
  /** Edges connecting through this spec — used to find the edge type for unlink. */
  edges?: Array<{ from_id: string; to_id: string; type: string }>;
  specId?: string;
}

const STATUS_COLORS: Record<string, string> = {
  open: 'text-blue-400',
  in_progress: 'text-amber-400',
  blocked: 'text-red-400',
  completed: 'text-emerald-400',
  closed: 'text-emerald-400',
  failed: 'text-red-400',
};

const DEFAULT_EDGE_TYPE: Record<string, EdgeType> = {
  task: 'implements',
  context: 'references',
  feedback: 'references',
  spec: 'related',
  issue: 'implements',
  other: 'references',
};

export function LinkedNodesPanel({
  title,
  icon,
  nodes,
  emptyMessage,
  variant = 'other',
  onNodeClick,
  onLink,
  onUnlink,
  edges,
  specId,
}: LinkedNodesPanelProps) {
  const [showForm, setShowForm] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [edgeType, setEdgeType] = useState<EdgeType>(DEFAULT_EDGE_TYPE[variant] ?? 'references');
  const [direction, setDirection] = useState<'inbound' | 'outbound'>(variant === 'task' ? 'inbound' : 'outbound');
  const [linking, setLinking] = useState(false);
  const [unlinking, setUnlinking] = useState<string | null>(null);

  const handleLink = async () => {
    if (!targetId.trim() || !onLink) return;
    setLinking(true);
    try {
      await onLink(targetId.trim(), edgeType, direction);
      setTargetId('');
      setShowForm(false);
    } catch { /* error handled by caller */ }
    setLinking(false);
  };

  const handleUnlink = async (nodeId: string) => {
    if (!onUnlink) return;
    // Find the edge type from edges data
    const edge = edges?.find(
      (e) => (e.from_id === nodeId && e.to_id === specId) || (e.from_id === specId && e.to_id === nodeId),
    );
    const type = (edge?.type as EdgeType) ?? DEFAULT_EDGE_TYPE[variant] ?? 'references';
    setUnlinking(nodeId);
    try {
      await onUnlink(nodeId, type);
    } catch { /* error handled by caller */ }
    setUnlinking(null);
  };

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
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {nodes.length}
          </span>
          {onLink && (
            <button
              type="button"
              onClick={() => setShowForm(!showForm)}
              className="p-0.5 rounded hover:bg-white/10"
              style={{ color: 'var(--color-text-muted)' }}
              title={`Link ${variant}`}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {showForm && onLink && (
        <div
          className="px-3 py-2 border-b flex flex-wrap gap-2 items-end"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <div className="flex-1 min-w-[100px]">
            <label className="block text-2xs mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Node ID</label>
            <input
              type="text"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="t-xxxx"
              className="w-full px-2 py-1 rounded border bg-transparent text-xs outline-none"
              style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
            />
          </div>
          <div>
            <label className="block text-2xs mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Edge type</label>
            <select
              value={edgeType}
              onChange={(e) => setEdgeType(e.target.value as EdgeType)}
              className="px-2 py-1 rounded border bg-transparent text-xs outline-none"
              style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
            >
              {EDGE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-2xs mb-0.5" style={{ color: 'var(--color-text-muted)' }}>Direction</label>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'inbound' | 'outbound')}
              className="px-2 py-1 rounded border bg-transparent text-xs outline-none"
              style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text)' }}
            >
              <option value="inbound">target → spec</option>
              <option value="outbound">spec → target</option>
            </select>
          </div>
          <button
            type="button"
            onClick={handleLink}
            disabled={linking || !targetId.trim()}
            className="px-2 py-1 rounded bg-honey-500 text-black text-xs font-medium disabled:opacity-50"
          >
            {linking ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Link'}
          </button>
        </div>
      )}

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
                  'px-3 py-2 text-sm group',
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
                      <div className="flex items-center gap-1.5 shrink-0">
                        {status && (
                          <span className={clsx('text-xs', statusClass)}>{status}</span>
                        )}
                        {onUnlink && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleUnlink(node.id); }}
                            disabled={unlinking === node.id}
                            className="p-0.5 rounded hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                            style={{ color: 'var(--color-text-muted)' }}
                            title="Unlink"
                          >
                            {unlinking === node.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                          </button>
                        )}
                      </div>
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
