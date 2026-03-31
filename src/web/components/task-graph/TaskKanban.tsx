/**
 * TaskKanban — Kanban board view for OpenTasks graph nodes.
 * Shows columns for each status with draggable-style task cards.
 */

import { useState } from 'react';
import {
  Circle, PlayCircle, AlertTriangle, CheckCircle2, XCircle,
  GripVertical, ChevronRight,
} from 'lucide-react';
import clsx from 'clsx';
import { useOpenTasksGraph, useUpdateOpenTaskStatus } from '../../hooks/useApi';
import { useTasksRealtime } from '../../hooks/useMapTasks';
import type { OpenTasksGraphNode } from '../../lib/api';

// ============================================================================
// Column definitions
// ============================================================================

interface KanbanColumn {
  key: string;
  label: string;
  icon: React.ElementType;
  color: string;
  bgAccent: string;
  borderColor: string;
  statuses: string[]; // which statuses go in this column
}

const COLUMNS: KanbanColumn[] = [
  {
    key: 'open',
    label: 'Open',
    icon: Circle,
    color: 'text-gray-400',
    bgAccent: 'bg-gray-500/10',
    borderColor: '#6b7280',
    statuses: ['open'],
  },
  {
    key: 'in_progress',
    label: 'In Progress',
    icon: PlayCircle,
    color: 'text-blue-400',
    bgAccent: 'bg-blue-500/10',
    borderColor: '#3b82f6',
    statuses: ['in_progress'],
  },
  {
    key: 'blocked',
    label: 'Blocked',
    icon: AlertTriangle,
    color: 'text-red-400',
    bgAccent: 'bg-red-500/10',
    borderColor: '#ef4444',
    statuses: ['blocked'],
  },
  {
    key: 'done',
    label: 'Done',
    icon: CheckCircle2,
    color: 'text-emerald-400',
    bgAccent: 'bg-emerald-500/10',
    borderColor: '#22c55e',
    statuses: ['closed', 'completed'],
  },
];

/** Valid moves from each status */
const MOVE_TARGETS: Record<string, Array<{ label: string; target: string }>> = {
  open: [
    { label: 'Start', target: 'in_progress' },
    { label: 'Block', target: 'blocked' },
    { label: 'Close', target: 'closed' },
  ],
  in_progress: [
    { label: 'Complete', target: 'closed' },
    { label: 'Block', target: 'blocked' },
  ],
  blocked: [
    { label: 'Reopen', target: 'open' },
    { label: 'Close', target: 'closed' },
  ],
  closed: [{ label: 'Reopen', target: 'open' }],
  completed: [{ label: 'Reopen', target: 'open' }],
  failed: [{ label: 'Reopen', target: 'open' }],
};

const PRIORITY_LABELS: Record<number, string> = {
  0: 'Default',
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Critical',
};

// ============================================================================
// Task Card
// ============================================================================

function TaskCard({
  node,
  resourceId,
  isSelected,
  onSelect,
}: {
  node: OpenTasksGraphNode;
  resourceId: string;
  isSelected: boolean;
  onSelect: (node: OpenTasksGraphNode | null) => void;
}) {
  const updateStatus = useUpdateOpenTaskStatus(resourceId);
  const status = node.status || 'open';
  const moves = node.type === 'task' ? (MOVE_TARGETS[status] || []) : [];

  const handleMove = (target: string) => {
    updateStatus.mutate({ nodeId: node.id, status: target });
  };

  return (
    <div
      onClick={() => onSelect(isSelected ? null : node)}
      className={clsx(
        'rounded-lg p-3 cursor-pointer transition-all duration-150',
        isSelected
          ? 'ring-1 ring-honey-500/50'
          : 'hover:ring-1 hover:ring-white/10',
      )}
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      {/* Drag handle + title */}
      <div className="flex items-start gap-2">
        <GripVertical
          className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-30"
          style={{ color: 'var(--color-text-muted)' }}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-snug">{node.title || node.id}</p>
          {node.description && (
            <p
              className="text-2xs mt-1 line-clamp-2 leading-relaxed"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {node.description}
            </p>
          )}
        </div>
      </div>

      {/* Priority + meta */}
      <div className="flex items-center gap-2 mt-2">
        {node.priority != null && node.priority > 0 && (
          <span
            className={clsx(
              'text-2xs px-1.5 py-0.5 rounded font-medium',
              node.priority >= 3
                ? 'bg-red-500/10 text-red-400'
                : node.priority >= 2
                  ? 'bg-amber-500/10 text-amber-400'
                  : 'bg-gray-500/10 text-gray-400',
            )}
          >
            {PRIORITY_LABELS[node.priority] || `P${node.priority}`}
          </span>
        )}
        <span className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
          {node.id.length > 12 ? node.id.slice(-8) : node.id}
        </span>
      </div>

      {/* Quick move actions (shown when selected) */}
      {isSelected && moves.length > 0 && (
        <div
          className="flex items-center gap-1 mt-2.5 pt-2.5 border-t"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <span className="text-2xs mr-1" style={{ color: 'var(--color-text-muted)' }}>
            Move:
          </span>
          {moves.map((move) => (
            <button
              key={move.target}
              onClick={(e) => {
                e.stopPropagation();
                handleMove(move.target);
              }}
              disabled={updateStatus.isPending}
              className="btn-ghost text-2xs px-2 py-0.5 rounded border flex items-center gap-1"
              style={{ borderColor: 'var(--color-border)' }}
            >
              {move.label}
              <ChevronRight className="w-3 h-3" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Kanban Column
// ============================================================================

function KanbanColumnView({
  column,
  nodes,
  resourceId,
  selectedNodeId,
  onSelectNode,
}: {
  column: KanbanColumn;
  nodes: OpenTasksGraphNode[];
  resourceId: string;
  selectedNodeId: string | null;
  onSelectNode: (node: OpenTasksGraphNode | null) => void;
}) {
  const Icon = column.icon;

  return (
    <div className="flex flex-col min-w-[280px] max-w-[320px] flex-1">
      {/* Column header */}
      <div className="flex items-center gap-2 px-3 py-2 mb-2">
        <div
          className="w-2 h-2 rounded-full"
          style={{ backgroundColor: column.borderColor }}
        />
        <span className="text-xs font-semibold">{column.label}</span>
        <span
          className="text-2xs px-1.5 py-0.5 rounded-full"
          style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
        >
          {nodes.length}
        </span>
      </div>

      {/* Cards */}
      <div
        className="flex-1 space-y-2 p-2 rounded-lg overflow-y-auto"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        {nodes.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Icon
              className={clsx('w-5 h-5 opacity-20', column.color)}
            />
          </div>
        ) : (
          nodes.map((node) => (
            <TaskCard
              key={node.id}
              node={node}
              resourceId={resourceId}
              isSelected={selectedNodeId === node.id}
              onSelect={onSelectNode}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ============================================================================
// TaskKanban (main export)
// ============================================================================

interface TaskKanbanProps {
  resourceId: string;
}

export function TaskKanban({ resourceId }: TaskKanbanProps) {
  const { data: graphData, isLoading } = useOpenTasksGraph(resourceId);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  useTasksRealtime();

  const nodes = (graphData?.nodes || []).filter(
    (n) => n.type === 'task' && !n.archived,
  );

  // Group nodes into columns
  const columnData = COLUMNS.map((col) => ({
    column: col,
    nodes: nodes
      .filter((n) => col.statuses.includes(n.status || 'open'))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
  }));

  const handleSelectNode = (node: OpenTasksGraphNode | null) => {
    setSelectedNodeId(node?.id ?? null);
  };

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-gray-500/30 animate-pulse" />
          <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Loading tasks...</span>
        </div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-2">
          <Circle className="w-8 h-8 mx-auto" style={{ color: 'var(--color-text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>No tasks yet</p>
          <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            Create a task to see it on the board
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex gap-3 p-4 overflow-x-auto">
      {columnData.map(({ column, nodes: colNodes }) => (
        <KanbanColumnView
          key={column.key}
          column={column}
          nodes={colNodes}
          resourceId={resourceId}
          selectedNodeId={selectedNodeId}
          onSelectNode={handleSelectNode}
        />
      ))}
    </div>
  );
}
