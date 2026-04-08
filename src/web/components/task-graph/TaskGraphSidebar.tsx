/**
 * TaskGraphSidebar — Node detail panel shown when a graph node is clicked.
 * Includes status transition buttons for task nodes.
 */

import { useState } from 'react';
import { X, CheckCircle2, PlayCircle, AlertTriangle, XCircle, Circle, Trash2, Link2, Plus } from 'lucide-react';
import clsx from 'clsx';
import { useUpdateOpenTaskStatus, useDeleteOpenTask, useCreateTaskLink, useRemoveTaskLink } from '../../hooks/useApi';
import type { OpenTasksGraphNode, OpenTasksGraphEdge } from '../../lib/api';

const STATUS_ICONS: Record<string, React.ElementType> = {
  open: Circle,
  in_progress: PlayCircle,
  blocked: AlertTriangle,
  completed: CheckCircle2,
  closed: CheckCircle2,
  failed: XCircle,
};

const STATUS_STYLES: Record<string, string> = {
  open: 'text-gray-400',
  in_progress: 'text-blue-400',
  blocked: 'text-red-400',
  completed: 'text-emerald-400',
  closed: 'text-emerald-400',
  failed: 'text-red-400',
};

/** Valid transitions from each status */
const STATUS_ACTIONS: Record<string, Array<{ label: string; target: string; color: string }>> = {
  open: [
    { label: 'Start', target: 'in_progress', color: 'text-blue-400' },
    { label: 'Block', target: 'blocked', color: 'text-red-400' },
    { label: 'Close', target: 'closed', color: 'text-emerald-400' },
  ],
  in_progress: [
    { label: 'Complete', target: 'closed', color: 'text-emerald-400' },
    { label: 'Block', target: 'blocked', color: 'text-red-400' },
  ],
  blocked: [
    { label: 'Reopen', target: 'open', color: 'text-gray-400' },
    { label: 'Close', target: 'closed', color: 'text-emerald-400' },
  ],
  closed: [
    { label: 'Reopen', target: 'open', color: 'text-gray-400' },
  ],
  completed: [
    { label: 'Reopen', target: 'open', color: 'text-gray-400' },
  ],
  failed: [
    { label: 'Reopen', target: 'open', color: 'text-gray-400' },
  ],
};

interface Props {
  node: OpenTasksGraphNode | null;
  resourceId: string;
  onClose: () => void;
  edges?: OpenTasksGraphEdge[];
  allNodes?: OpenTasksGraphNode[];
}

export function TaskGraphSidebar({ node, resourceId, onClose, edges = [], allNodes = [] }: Props) {
  const updateStatus = useUpdateOpenTaskStatus(resourceId);
  const deleteTask = useDeleteOpenTask(resourceId);
  const createLink = useCreateTaskLink(resourceId);
  const removeLink = useRemoveTaskLink(resourceId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAddLink, setShowAddLink] = useState(false);
  const [linkTargetId, setLinkTargetId] = useState('');
  const [linkType, setLinkType] = useState('blocks');

  if (!node) return null;

  const status = node.status || 'open';
  const StatusIcon = STATUS_ICONS[status] || Circle;
  const actions = node.type === 'task' ? (STATUS_ACTIONS[status] || []) : [];

  const handleStatusChange = (targetStatus: string) => {
    updateStatus.mutate({ nodeId: node.id, status: targetStatus });
  };

  return (
    <div
      className="w-80 shrink-0 overflow-y-auto border-l"
      style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)' }}
    >
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold leading-tight">{node.title || node.id}</h3>
          <button onClick={onClose} className="btn-ghost p-1 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Status badge */}
        <div className="flex items-center gap-2">
          <StatusIcon className={clsx('w-4 h-4', STATUS_STYLES[status])} />
          <span className="text-xs capitalize">{status.replace('_', ' ')}</span>
          {node.priority != null && (
            <span className="text-2xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">
              P{node.priority}
            </span>
          )}
        </div>

        {/* Status actions */}
        {actions.length > 0 && (
          <div>
            <div className="text-2xs font-medium mb-1.5" style={{ color: 'var(--color-text-muted)' }}>
              Actions
            </div>
            <div className="flex flex-wrap gap-1.5">
              {actions.map((action) => (
                <button
                  key={action.target}
                  onClick={() => handleStatusChange(action.target)}
                  disabled={updateStatus.isPending}
                  className={clsx(
                    'btn-ghost text-2xs px-2 py-1 rounded border',
                    action.color,
                  )}
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  {updateStatus.isPending ? '...' : action.label}
                </button>
              ))}
            </div>
            {updateStatus.isError && (
              <p className="text-2xs text-red-400 mt-1">
                {updateStatus.error instanceof Error ? updateStatus.error.message : 'Update failed'}
              </p>
            )}
          </div>
        )}

        {/* Description */}
        {node.description && (
          <div>
            <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Description
            </div>
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              {node.description}
            </p>
          </div>
        )}

        {/* Metadata */}
        <div>
          <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
            Details
          </div>
          <div className="space-y-1">
            <DetailRow label="ID" value={node.id} mono />
            <DetailRow label="Type" value={node.type} />
            {(node as any).assignee && (
              <DetailRow label="Assignee" value={(node as any).assignee} />
            )}
            {node.created_at && (
              <DetailRow label="Created" value={new Date(node.created_at).toLocaleString()} />
            )}
            {node.updated_at && (
              <DetailRow label="Updated" value={new Date(node.updated_at).toLocaleString()} />
            )}
          </div>
        </div>

        {/* Dependencies */}
        {node.type === 'task' && edges.length > 0 || allNodes.length > 0 ? (
          <DependenciesSection
            node={node}
            edges={edges}
            allNodes={allNodes}
            resourceId={resourceId}
            createLink={createLink}
            removeLink={removeLink}
            showAddLink={showAddLink}
            setShowAddLink={setShowAddLink}
            linkTargetId={linkTargetId}
            setLinkTargetId={setLinkTargetId}
            linkType={linkType}
            setLinkType={setLinkType}
          />
        ) : null}

        {/* Delete */}
        {node.type === 'task' && (
          <div className="pt-3 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="btn-ghost text-2xs px-2 py-1 rounded text-red-400/60 hover:text-red-400 hover:bg-red-500/10 flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" />
                Delete task
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-2xs text-red-400">Delete this task?</span>
                <button
                  onClick={() => { deleteTask.mutate(node.id); onClose(); }}
                  disabled={deleteTask.isPending}
                  className="text-2xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
                >
                  {deleteTask.isPending ? '...' : 'Delete'}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-2xs px-2 py-0.5 rounded hover:bg-white/10"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DependenciesSection({
  node, edges, allNodes, resourceId, createLink, removeLink,
  showAddLink, setShowAddLink, linkTargetId, setLinkTargetId, linkType, setLinkType,
}: {
  node: OpenTasksGraphNode;
  edges: OpenTasksGraphEdge[];
  allNodes: OpenTasksGraphNode[];
  resourceId: string;
  createLink: ReturnType<typeof useCreateTaskLink>;
  removeLink: ReturnType<typeof useRemoveTaskLink>;
  showAddLink: boolean;
  setShowAddLink: (v: boolean) => void;
  linkTargetId: string;
  setLinkTargetId: (v: string) => void;
  linkType: string;
  setLinkType: (v: string) => void;
}) {
  const nodeEdges = edges.filter(e => e.from_id === node.id || e.to_id === node.id);
  const blocks = nodeEdges.filter(e => e.type === 'blocks' && e.from_id === node.id);
  const blockedBy = nodeEdges.filter(e => e.type === 'blocks' && e.to_id === node.id);
  const related = nodeEdges.filter(e => e.type !== 'blocks');

  const getNodeTitle = (id: string) => allNodes.find(n => n.id === id)?.title || id;
  const otherTasks = allNodes.filter(n => n.id !== node.id && n.type === 'task');

  const handleAddLink = () => {
    if (!linkTargetId) return;
    createLink.mutate(
      { nodeId: node.id, targetId: linkTargetId, type: linkType },
      { onSuccess: () => { setShowAddLink(false); setLinkTargetId(''); } },
    );
  };

  if (nodeEdges.length === 0 && !showAddLink) {
    return (
      <div className="pt-3 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Dependencies</div>
          <button
            onClick={() => setShowAddLink(true)}
            className="text-2xs flex items-center gap-0.5 hover:underline"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
        <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>No dependencies</p>
      </div>
    );
  }

  return (
    <div className="pt-3 border-t space-y-2" style={{ borderColor: 'var(--color-border-subtle)' }}>
      <div className="flex items-center justify-between">
        <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Dependencies</div>
        <button
          onClick={() => setShowAddLink(!showAddLink)}
          className="text-2xs flex items-center gap-0.5 hover:underline"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>

      {blocks.length > 0 && (
        <div>
          <span className="text-2xs text-red-400">Blocks</span>
          {blocks.map(e => (
            <div key={e.to_id} className="flex items-center justify-between text-2xs py-0.5">
              <span className="truncate">{getNodeTitle(e.to_id)}</span>
              <button
                onClick={() => removeLink.mutate({ nodeId: node.id, targetId: e.to_id, type: 'blocks' })}
                className="p-0.5 rounded hover:bg-red-500/10 shrink-0"
              >
                <X className="w-3 h-3 text-red-400/60" />
              </button>
            </div>
          ))}
        </div>
      )}

      {blockedBy.length > 0 && (
        <div>
          <span className="text-2xs text-amber-400">Blocked by</span>
          {blockedBy.map(e => (
            <div key={e.from_id} className="flex items-center justify-between text-2xs py-0.5">
              <span className="truncate">{getNodeTitle(e.from_id)}</span>
              <button
                onClick={() => removeLink.mutate({ nodeId: e.from_id, targetId: node.id, type: 'blocks' })}
                className="p-0.5 rounded hover:bg-red-500/10 shrink-0"
              >
                <X className="w-3 h-3 text-red-400/60" />
              </button>
            </div>
          ))}
        </div>
      )}

      {related.length > 0 && (
        <div>
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Related</span>
          {related.map(e => {
            const otherId = e.from_id === node.id ? e.to_id : e.from_id;
            return (
              <div key={otherId} className="flex items-center justify-between text-2xs py-0.5">
                <span className="truncate">{getNodeTitle(otherId)}</span>
                <button
                  onClick={() => removeLink.mutate({ nodeId: e.from_id, targetId: e.to_id, type: e.type || 'related' })}
                  className="p-0.5 rounded hover:bg-red-500/10 shrink-0"
                >
                  <X className="w-3 h-3 text-red-400/60" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {showAddLink && (
        <div className="space-y-1.5 p-2 rounded-lg bg-white/[0.02] border border-[var(--color-border-subtle)]">
          <select
            value={linkType}
            onChange={(e) => setLinkType(e.target.value)}
            className="input text-2xs w-full py-0.5"
          >
            <option value="blocks">Blocks</option>
            <option value="depends-on">Depends on</option>
            <option value="related">Related</option>
            <option value="parent-of">Parent of</option>
            <option value="implements">Implements</option>
          </select>
          <select
            value={linkTargetId}
            onChange={(e) => setLinkTargetId(e.target.value)}
            className="input text-2xs w-full py-0.5"
          >
            <option value="">Select task...</option>
            {otherTasks.map(t => (
              <option key={t.id} value={t.id}>{t.title || t.id}</option>
            ))}
          </select>
          <div className="flex gap-1">
            <button
              onClick={handleAddLink}
              disabled={!linkTargetId || createLink.isPending}
              className="btn-primary text-2xs px-2 py-0.5"
            >
              {createLink.isPending ? '...' : 'Add'}
            </button>
            <button
              onClick={() => { setShowAddLink(false); setLinkTargetId(''); }}
              className="btn-ghost text-2xs px-2 py-0.5"
            >
              Cancel
            </button>
          </div>
          {createLink.error && (
            <p className="text-2xs text-red-400">{(createLink.error as Error).message}</p>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span style={{ color: 'var(--color-text-muted)' }}>{label}</span>
      <span className={clsx('truncate', mono && 'font-mono text-2xs')}>{value}</span>
    </div>
  );
}
