/**
 * TaskKanban — Kanban board view for OpenTasks graph nodes.
 * Drag-and-drop cards between columns to change task status.
 */

import { useState } from 'react';
import {
  Circle, PlayCircle, AlertTriangle, CheckCircle2,
  Pencil, Check, X, Trash2,
} from 'lucide-react';
import clsx from 'clsx';
import {
  DndContext, DragOverlay, pointerWithin,
  useSensor, useSensors, PointerSensor,
  useDraggable, useDroppable,
  type DragStartEvent, type DragEndEvent, type DragOverEvent,
} from '@dnd-kit/core';
// @dnd-kit/utilities not needed — using useDraggable (not useSortable)
import { useOpenTasksGraph, useUpdateOpenTaskStatus, useUpdateOpenTask, useDeleteOpenTask } from '../../hooks/useApi';
import { applyTaskFilters } from './TaskFilterBar';
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
  statuses: string[];
  /** The status to set when a card is dropped here */
  dropStatus: string;
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
    dropStatus: 'open',
  },
  {
    key: 'in_progress',
    label: 'In Progress',
    icon: PlayCircle,
    color: 'text-blue-400',
    bgAccent: 'bg-blue-500/10',
    borderColor: '#3b82f6',
    statuses: ['in_progress'],
    dropStatus: 'in_progress',
  },
  {
    key: 'blocked',
    label: 'Blocked',
    icon: AlertTriangle,
    color: 'text-red-400',
    bgAccent: 'bg-red-500/10',
    borderColor: '#ef4444',
    statuses: ['blocked'],
    dropStatus: 'blocked',
  },
  {
    key: 'done',
    label: 'Done',
    icon: CheckCircle2,
    color: 'text-emerald-400',
    bgAccent: 'bg-emerald-500/10',
    borderColor: '#22c55e',
    statuses: ['closed', 'completed'],
    dropStatus: 'closed',
  },
];

const PRIORITY_LABELS: Record<number, string> = {
  0: 'Default',
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Critical',
};

// ============================================================================
// Draggable Task Card
// ============================================================================

function DraggableTaskCard({
  node,
  resourceId,
  isSelected,
  onSelect,
  isDragOverlay,
}: {
  node: OpenTasksGraphNode;
  resourceId: string;
  isSelected: boolean;
  onSelect: (node: OpenTasksGraphNode | null) => void;
  isDragOverlay?: boolean;
}) {
  const updateTask = useUpdateOpenTask(resourceId);
  const deleteTask = useDeleteOpenTask(resourceId);
  const [isEditing, setIsEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editTitle, setEditTitle] = useState(node.title || '');
  const [editDescription, setEditDescription] = useState(node.description || '');
  const [editAssignee, setEditAssignee] = useState((node as any).assignee || '');

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    isDragging,
  } = useDraggable({ id: node.id, disabled: isEditing, data: { node } });

  const cardStyle: React.CSSProperties = isDragOverlay
    ? { backgroundColor: 'var(--color-surface)' }
    : {
        transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
        opacity: isDragging ? 0.3 : 1,
        backgroundColor: 'var(--color-surface)',
      };

  const handleMove = (target: string) => {
    updateStatus.mutate({ nodeId: node.id, status: target });
  };

  return (
    <div
      ref={isDragOverlay ? undefined : setNodeRef}
      style={cardStyle}
      onClick={() => !isDragging && onSelect(isSelected ? null : node)}
      className={clsx(
        'rounded-lg p-3 cursor-grab active:cursor-grabbing touch-none transition-all duration-150',
        isDragOverlay && 'shadow-xl ring-1 ring-honey-500/50 rotate-1',
        isSelected && !isDragOverlay
          ? 'ring-1 ring-honey-500/50'
          : !isDragOverlay && 'hover:ring-1 hover:ring-white/10',
      )}
      {...attributes}
      {...listeners}
    >
      {isEditing ? (
        /* Inline edit form */
        <div
          className="space-y-2"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            className="input w-full text-sm"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setIsEditing(false); setEditTitle(node.title || ''); setEditDescription(node.description || ''); }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (editTitle.trim()) {
                  updateTask.mutate({ nodeId: node.id, title: editTitle.trim(), description: editDescription.trim() || null, assignee: editAssignee.trim() || null }, { onSuccess: () => setIsEditing(false) });
                }
              }
            }}
          />
          <textarea
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            className="input w-full text-2xs resize-none"
          />
          <input
            type="text"
            value={editAssignee}
            onChange={(e) => setEditAssignee(e.target.value)}
            placeholder="Assignee (optional)"
            className="input w-full text-2xs"
          />
          <div className="flex justify-end gap-1">
            <button
              onClick={() => { setIsEditing(false); setEditTitle(node.title || ''); setEditDescription(node.description || ''); }}
              className="p-1 rounded hover:bg-white/10"
            >
              <X className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
            </button>
            <button
              onClick={() => {
                if (editTitle.trim()) {
                  updateTask.mutate({ nodeId: node.id, title: editTitle.trim(), description: editDescription.trim() || null, assignee: editAssignee.trim() || null }, { onSuccess: () => setIsEditing(false) });
                }
              }}
              disabled={!editTitle.trim() || updateTask.isPending}
              className="p-1 rounded hover:bg-emerald-500/10"
            >
              <Check className={`w-3.5 h-3.5 ${updateTask.isPending ? 'animate-pulse' : 'text-emerald-400'}`} />
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Title + edit button */}
          <div className="flex items-start gap-2 group/card">
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
            {!isDragOverlay && node.type === 'task' && !confirmDelete && (
              <div className="flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 transition-opacity shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditTitle(node.title || '');
                    setEditDescription(node.description || '');
                    setEditAssignee((node as any).assignee || '');
                    setIsEditing(true);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="p-1 rounded hover:bg-white/10"
                  title="Edit task"
                >
                  <Pencil className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="p-1 rounded hover:bg-red-500/10"
                  title="Delete task"
                >
                  <Trash2 className="w-3 h-3 text-red-400/60 hover:text-red-400" />
                </button>
              </div>
            )}
            {confirmDelete && (
              <div
                className="flex items-center gap-1 shrink-0"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <span className="text-2xs text-red-400">Delete?</span>
                <button
                  onClick={() => deleteTask.mutate(node.id)}
                  disabled={deleteTask.isPending}
                  className="text-2xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                >
                  {deleteTask.isPending ? '...' : 'Yes'}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-2xs px-1.5 py-0.5 rounded hover:bg-white/10"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  No
                </button>
              </div>
            )}
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
        {(node as any).assignee && (
          <span className="text-2xs ml-auto" style={{ color: 'var(--color-text-muted)' }}>
            @{(node as any).assignee}
          </span>
        )}
      </div>

        </>
      )}
    </div>
  );
}

// ============================================================================
// Droppable Kanban Column
// ============================================================================

function DroppableColumn({
  column,
  nodes,
  resourceId,
  selectedNodeId,
  onSelectNode,
  isOver,
}: {
  column: KanbanColumn;
  nodes: OpenTasksGraphNode[];
  resourceId: string;
  selectedNodeId: string | null;
  onSelectNode: (node: OpenTasksGraphNode | null) => void;
  isOver: boolean;
}) {
  const Icon = column.icon;
  const { setNodeRef } = useDroppable({ id: column.key });

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

      {/* Cards (droppable area) */}
      <div
        ref={setNodeRef}
        className={clsx(
          'flex-1 space-y-2 p-2 rounded-lg overflow-y-auto transition-colors duration-200',
          isOver && 'ring-2 ring-honey-500/30',
        )}
        style={{
          backgroundColor: isOver ? 'var(--color-surface)' : 'var(--color-elevated)',
        }}
      >
        {nodes.length === 0 ? (
          <div className={clsx(
            'flex items-center justify-center py-8 rounded-lg transition-colors',
            isOver && 'bg-honey-500/5',
          )}>
            <Icon className={clsx('w-5 h-5 opacity-20', column.color)} />
          </div>
        ) : (
          nodes.map((node) => (
            <DraggableTaskCard
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
  filters?: import('./TaskFilterBar').TaskFilters;
}

export function TaskKanban({ resourceId, filters }: TaskKanbanProps) {
  const { data: graphData, isLoading } = useOpenTasksGraph(resourceId);
  const updateStatus = useUpdateOpenTaskStatus(resourceId);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeNode, setActiveNode] = useState<OpenTasksGraphNode | null>(null);
  const [overColumnKey, setOverColumnKey] = useState<string | null>(null);
  useTasksRealtime();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // 5px movement before drag starts — prevents accidental drags on click
      },
    }),
  );

  const allNodes = (graphData?.nodes || []).filter(
    (n) => n.type === 'task' && !n.archived,
  );

  // Apply filters
  const nodes = filters
    ? applyTaskFilters(allNodes as any[], filters) as typeof allNodes
    : allNodes;

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

  const handleDragStart = (event: DragStartEvent) => {
    const node = event.active.data.current?.node as OpenTasksGraphNode | undefined;
    if (node) {
      setActiveNode(node);
      setSelectedNodeId(null); // deselect on drag
    }
  };

  const handleDragOver = (event: DragOverEvent) => {
    const overId = event.over?.id as string | undefined;
    // overId could be a column key or a card id
    if (overId && COLUMNS.some(c => c.key === overId)) {
      setOverColumnKey(overId);
    } else if (overId) {
      // Hovering over a card — find which column it belongs to
      const overNode = nodes.find(n => n.id === overId);
      if (overNode) {
        const col = COLUMNS.find(c => c.statuses.includes(overNode.status || 'open'));
        setOverColumnKey(col?.key ?? null);
      }
    } else {
      setOverColumnKey(null);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveNode(null);
    setOverColumnKey(null);

    if (!over) return;

    const draggedNode = active.data.current?.node as OpenTasksGraphNode | undefined;
    if (!draggedNode) return;

    // Determine the target column
    let targetColumn: KanbanColumn | undefined;
    const overId = over.id as string;

    // Dropped on a column directly
    targetColumn = COLUMNS.find(c => c.key === overId);

    // Dropped on a card — find its column
    if (!targetColumn) {
      const overNode = nodes.find(n => n.id === overId);
      if (overNode) {
        targetColumn = COLUMNS.find(c => c.statuses.includes(overNode.status || 'open'));
      }
    }

    if (!targetColumn) return;

    // Only update if the status actually changes
    const currentStatus = draggedNode.status || 'open';
    if (targetColumn.statuses.includes(currentStatus)) return;

    updateStatus.mutate({ nodeId: draggedNode.id, status: targetColumn.dropStatus });
  };

  const handleDragCancel = () => {
    setActiveNode(null);
    setOverColumnKey(null);
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
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="h-full flex gap-3 p-4 overflow-x-auto">
        {columnData.map(({ column, nodes: colNodes }) => (
          <DroppableColumn
            key={column.key}
            column={column}
            nodes={colNodes}
            resourceId={resourceId}
            selectedNodeId={selectedNodeId}
            onSelectNode={handleSelectNode}
            isOver={overColumnKey === column.key}
          />
        ))}
      </div>

      {/* Drag overlay — floating card that follows the cursor */}
      <DragOverlay>
        {activeNode && (
          <div className="w-[280px]" style={{ backgroundColor: 'var(--color-surface)' }}>
            <DraggableTaskCard
              node={activeNode}
              resourceId={resourceId}
              isSelected={false}
              onSelect={() => {}}
              isDragOverlay
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
