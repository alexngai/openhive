/**
 * StreamNodeCard — React Flow custom node renderer for cascade streams.
 *
 * Fixed-size card (matches CARD_WIDTH/HEIGHT in dagreLayout.ts so the layout
 * pass knows what to plan around). Click selection is handled at the
 * `<ReactFlow onNodeClick>` level, not here, so the card has no `onClick`.
 */

import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { AlertTriangle, GitCommit, ListChecks, User } from 'lucide-react';
import type { StreamDAGNode } from '../../hooks/useApi';
import { TimeAgo } from '../common/TimeAgo';
import { STATUS_COLORS, STATUS_LABELS, StreamStatusDot } from './shared';
import { CARD_WIDTH, CARD_HEIGHT } from './layout/dagreLayout';

function StreamNodeCardInner({ data, selected }: NodeProps<StreamDAGNode>) {
  const node = data;
  const isConflicted =
    node.status === 'conflicted' || node.open_conflict_count > 0;
  const isTerminal = node.status === 'merged' || node.status === 'abandoned';

  return (
    <div
      className="rounded-md border text-2xs flex flex-col"
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        background: 'var(--color-surface)',
        borderColor: selected
          ? 'var(--color-accent)'
          : isConflicted
            ? 'var(--color-danger-border, var(--color-danger))'
            : 'var(--color-border)',
        borderWidth: selected ? 2 : 1,
        opacity: isTerminal ? 0.7 : 1,
        boxShadow: selected ? '0 0 0 2px var(--color-accent)' : undefined,
      }}
    >
      {/* Invisible handles so React Flow can attach edges. */}
      <Handle
        type="target"
        position={Position.Left}
        style={{ opacity: 0, background: 'transparent', border: 'none' }}
        isConnectable={false}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{ opacity: 0, background: 'transparent', border: 'none' }}
        isConnectable={false}
      />

      {/* Row 1 — status dot · name · age */}
      <div className="flex items-center gap-1.5 px-2 pt-1.5 min-w-0">
        <StreamStatusDot status={node.status} />
        <span
          className="font-medium truncate"
          style={{ color: 'var(--color-text)' }}
        >
          {node.name || node.stream_id}
        </span>
        <span
          className="ml-auto shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <TimeAgo date={node.last_event_at} />
        </span>
      </div>

      {/* Row 2 — short id · status pill · commits */}
      <div className="flex items-center gap-1.5 px-2 pt-0.5 min-w-0">
        <code
          className="font-mono px-1 py-0.5 rounded shrink-0"
          style={{
            background: 'var(--color-elevated)',
            color: 'var(--color-text-muted)',
            fontSize: '0.65rem',
          }}
        >
          {node.stream_id.slice(0, 7)}
        </code>
        <span
          className="px-1 py-0.5 rounded shrink-0"
          style={{
            background: 'var(--color-elevated)',
            color: STATUS_COLORS[node.status] ?? 'var(--color-text-muted)',
            fontSize: '0.65rem',
          }}
        >
          {STATUS_LABELS[node.status] ?? node.status}
        </span>
        <span
          className="ml-auto flex items-center gap-1 shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <GitCommit className="w-3 h-3" />
          {node.commit_count}
        </span>
        {isConflicted && (
          <span
            className="flex items-center gap-0.5 shrink-0"
            style={{ color: 'var(--color-danger)' }}
            title={`${node.open_conflict_count} open conflict(s)`}
          >
            <AlertTriangle className="w-3 h-3" />
            {node.open_conflict_count}
          </span>
        )}
      </div>

      {/* Divider */}
      <div
        className="mx-2 mt-1 mb-1 border-t"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      />

      {/* Row 3 — task chip · agent chip */}
      <div
        className="flex items-center gap-1.5 px-2 pb-1.5 min-w-0"
        style={{ color: 'var(--color-text-muted)' }}
      >
        {node.task_node_id ? (
          <span
            className="flex items-center gap-1 truncate"
            title={`task ${node.task_node_id}`}
          >
            <ListChecks className="w-3 h-3 shrink-0" />
            <span className="truncate font-mono" style={{ fontSize: '0.65rem' }}>
              {node.task_node_id.slice(0, 10)}
            </span>
          </span>
        ) : (
          <span
            className="italic"
            style={{ fontSize: '0.65rem' }}
          >
            no task
          </span>
        )}
        <span
          className="ml-auto flex items-center gap-1 truncate"
          title={`agent ${node.source_agent_id}`}
        >
          <User className="w-3 h-3 shrink-0" />
          <span className="truncate" style={{ fontSize: '0.65rem' }}>
            {node.source_agent_id}
          </span>
        </span>
      </div>
    </div>
  );
}

export const StreamNodeCard = memo(StreamNodeCardInner);
