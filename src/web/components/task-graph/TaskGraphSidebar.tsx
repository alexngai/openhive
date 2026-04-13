/**
 * TaskGraphSidebar — Detail panel shown when a graph node or edge is clicked.
 * Includes status transition buttons for task nodes and edge management.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { X, CheckCircle2, PlayCircle, AlertTriangle, XCircle, Circle, Trash2, Link2, Plus, ArrowDown } from 'lucide-react';
import { TiptapEditor, useEditorViewMode } from '../common/TiptapEditor';
import { FileText, Eye } from 'lucide-react';
import clsx from 'clsx';
import { useUpdateOpenTaskStatus, useUpdateOpenTask, useDeleteOpenTask, useCreateTaskLink, useRemoveTaskLink, useResolveContextFile, useCheckContextDrift, useSyncContextFile } from '../../hooks/useApi';
import type { OpenTasksGraphNode, OpenTasksGraphEdge } from '../../lib/api';

// ============================================================================
// Resizable sidebar wrapper
// ============================================================================

const MIN_WIDTH = 280;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;
const STORAGE_KEY = 'openhive-sidebar-width';

function ResizableSidebar({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = useState(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parseInt(stored, 10)));
    } catch {}
    return DEFAULT_WIDTH;
  });
  const widthRef = useRef(width);
  widthRef.current = width;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = startX - e.clientX;
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta));
      setWidth(newWidth);
      widthRef.current = newWidth;
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(STORAGE_KEY, String(widthRef.current));
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  return (
    <div
      className="shrink-0 overflow-y-auto border-l relative flex"
      style={{ width, borderColor: 'var(--color-border)', backgroundColor: 'var(--color-surface)' }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className="absolute left-0 top-0 bottom-0 w-[3px] cursor-col-resize hover:bg-honey-500/30 transition-colors z-10"
      />
      <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-white/10 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-white/20">
        {children}
      </div>
    </div>
  );
}

/** Selected edge info passed from the graph viewer */
export interface SelectedEdge {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
}

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
  selectedEdge?: SelectedEdge | null;
  resourceId: string;
  onClose: () => void;
  onSelectNode?: (node: OpenTasksGraphNode) => void;
  edges?: OpenTasksGraphEdge[];
  allNodes?: OpenTasksGraphNode[];
}

export function TaskGraphSidebar({ node, selectedEdge, resourceId, onClose, onSelectNode, edges = [], allNodes = [] }: Props) {
  const updateStatus = useUpdateOpenTaskStatus(resourceId);
  const updateTask = useUpdateOpenTask(resourceId);
  const deleteTask = useDeleteOpenTask(resourceId);
  const createLink = useCreateTaskLink(resourceId);
  const removeLink = useRemoveTaskLink(resourceId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editorView = useEditorViewMode();
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-save helper — debounces 1s
  const autoSave = useCallback((updates: Record<string, unknown>) => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      updateTask.mutate({ nodeId: node?.id || '', ...updates } as any);
    }, 1000);
  }, [updateTask, node?.id]);
  const [showAddLink, setShowAddLink] = useState(false);
  const [linkTargetId, setLinkTargetId] = useState('');
  const [linkType, setLinkType] = useState('blocks');

  // Edge detail view
  if (selectedEdge) {
    return (
      <EdgeDetailSidebar
        edge={selectedEdge}
        resourceId={resourceId}
        allNodes={allNodes}
        onClose={onClose}
        onSelectNode={onSelectNode}
      />
    );
  }

  if (!node) return null;

  const status = node.status || 'open';
  const StatusIcon = STATUS_ICONS[status] || Circle;
  const actions = node.type === 'task' ? (STATUS_ACTIONS[status] || []) : [];

  const handleStatusChange = (targetStatus: string) => {
    updateStatus.mutate({ nodeId: node.id, status: targetStatus });
  };

  return (
    <ResizableSidebar>
      <div className="p-4 space-y-4">
        {/* Header — title is inline-editable for tasks */}
        <div className="flex items-start justify-between gap-2">
          {node.type === 'task' ? (
            <input
              type="text"
              defaultValue={node.title || ''}
              key={node.id + '-title'}
              onBlur={(e) => {
                const newTitle = e.target.value.trim();
                if (newTitle && newTitle !== node.title) {
                  updateTask.mutate({ nodeId: node.id, title: newTitle });
                }
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              className="text-base font-semibold leading-tight flex-1 bg-transparent border-none outline-none hover:bg-white/5 focus:bg-white/5 rounded px-1 -ml-1 transition-colors"
              style={{ color: 'inherit' }}
            />
          ) : (
            <h3 className="text-base font-semibold leading-tight flex-1">{node.title || node.id}</h3>
          )}
          <button onClick={onClose} className="btn-ghost p-1 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Assignee — inline editable for tasks */}
        {node.type === 'task' && (
          <div>
            <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>Assignee</div>
            <input
              type="text"
              defaultValue={(node as any).assignee || ''}
              key={node.id + '-assignee'}
              onBlur={(e) => {
                const newAssignee = e.target.value.trim();
                if (newAssignee !== ((node as any).assignee || '')) {
                  updateTask.mutate({ nodeId: node.id, assignee: newAssignee || null });
                }
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              placeholder="Unassigned"
              className="text-xs w-full bg-transparent border-none outline-none hover:bg-white/5 focus:bg-white/5 rounded px-1 -ml-1 py-0.5 transition-colors"
              style={{ color: 'var(--color-text-secondary)' }}
            />
          </div>
        )}

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

        {/* Description / Content — tiptap editor for tasks, pre for contexts */}
        {node.type === 'task' ? (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Description</span>
              <button
                onClick={editorView.toggle}
                className="flex items-center gap-0.5 text-2xs px-1 py-0.5 rounded hover:bg-white/5 transition-colors"
                style={{ color: 'var(--color-text-muted)' }}
                title={editorView.mode === 'formatted' ? 'Switch to markdown' : 'Switch to formatted'}
              >
                {editorView.mode === 'markdown' ? <FileText className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
                {editorView.mode === 'markdown' ? 'Raw' : 'Rich'}
              </button>
            </div>
            <TiptapEditor
              content={node.description || node.content || ''}
              editable
              placeholder="Add a description..."
              showToolbar={false}
              viewMode={editorView.mode}
              minHeight="60px"
              onChange={(markdown) => {
                autoSave({ description: markdown || null });
              }}
            />
          </div>
        ) : node.type === 'context' ? (
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Content</span>
              <button
                onClick={editorView.toggle}
                className="flex items-center gap-0.5 text-2xs px-1 py-0.5 rounded hover:bg-white/5 transition-colors"
                style={{ color: 'var(--color-text-muted)' }}
                title={editorView.mode === 'markdown' ? 'Switch to rich text' : 'Switch to markdown'}
              >
                {editorView.mode === 'markdown' ? <FileText className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
                {editorView.mode === 'markdown' ? 'Raw' : 'Rich'}
              </button>
            </div>
            <TiptapEditor
              content={node.content || node.description || ''}
              editable
              placeholder="Add content..."
              showToolbar={editorView.mode === 'formatted'}
              viewMode={editorView.mode}
              minHeight="200px"
              onChange={(markdown) => {
                autoSave({ description: markdown || null });
              }}
            />
          </div>
        ) : node.description ? (
          <div>
            <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>Description</div>
            <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>{node.description}</p>
          </div>
        ) : null}

        {/* File-backed context — source info, drift, resolved content */}
        {node.type === 'context' && node.metadata?.context_file && (
          <FileContextSection nodeId={node.id} metadata={node.metadata} resourceId={resourceId} />
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
    </ResizableSidebar>
  );
}

function FileContextSection({
  nodeId,
  metadata,
  resourceId,
}: {
  nodeId: string;
  metadata: Record<string, unknown>;
  resourceId: string;
}) {
  const { data: resolved, isLoading: resolving } = useResolveContextFile(resourceId, nodeId);
  const { data: drift } = useCheckContextDrift(resourceId, nodeId);
  const syncFile = useSyncContextFile(resourceId);

  const filePath = metadata.context_file_path as string;
  const commit = metadata.context_file_commit as string | undefined;
  const lineStart = metadata.context_line_start as number | undefined;
  const lineEnd = metadata.context_line_end as number | undefined;

  return (
    <div className="space-y-2">
      <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
        Source File
      </div>
      <div className="text-xs font-mono p-2 rounded-lg" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}>
        <p className="truncate">{filePath}</p>
        <div className="flex items-center gap-2 mt-1 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {commit && <span>commit: {commit.slice(0, 8)}</span>}
          {lineStart != null && lineEnd != null && (
            <span>lines {lineStart}-{lineEnd}</span>
          )}
        </div>
      </div>

      {/* Drift warning */}
      {drift?.drifted && (
        <div className="flex items-center justify-between p-2 rounded-lg bg-amber-500/10">
          <span className="text-2xs text-amber-400">File has changed since captured</span>
          <button
            onClick={() => syncFile.mutate(nodeId)}
            disabled={syncFile.isPending}
            className="text-2xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30"
          >
            {syncFile.isPending ? '...' : 'Sync to HEAD'}
          </button>
        </div>
      )}

      {syncFile.isSuccess && (
        <p className="text-2xs text-emerald-400">Synced to HEAD</p>
      )}

      {/* Resolved file content */}
      <div>
        <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
          Content
        </div>
        {resolving ? (
          <div className="text-2xs p-3 rounded-lg" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
            Loading file content...
          </div>
        ) : resolved?.content ? (
          <pre
            className="text-xs p-3 rounded-lg overflow-auto max-h-64 whitespace-pre-wrap break-words"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
          >
            {resolved.content}
          </pre>
        ) : (
          <div className="text-2xs p-3 rounded-lg" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
            Could not resolve file content
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

// ============================================================================
// Edge Detail Sidebar
// ============================================================================

const EDGE_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  blocks: { label: 'Blocks', color: 'text-red-400' },
  'depends-on': { label: 'Depends on', color: 'text-amber-400' },
  related: { label: 'Related', color: 'text-gray-400' },
  'parent-of': { label: 'Parent of', color: 'text-blue-400' },
  implements: { label: 'Implements', color: 'text-emerald-400' },
};

function EdgeDetailSidebar({
  edge,
  resourceId,
  allNodes,
  onClose,
  onSelectNode,
}: {
  edge: SelectedEdge;
  resourceId: string;
  allNodes: OpenTasksGraphNode[];
  onClose: () => void;
  onSelectNode?: (node: OpenTasksGraphNode) => void;
}) {
  const removeLink = useRemoveTaskLink(resourceId);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const stripPrefix = (id: string) => id.includes(':') ? id.split(':').pop()! : id;
  const sourceNode = allNodes.find((n) => stripPrefix(n.id) === stripPrefix(edge.from_id));
  const targetNode = allNodes.find((n) => stripPrefix(n.id) === stripPrefix(edge.to_id));
  const typeInfo = EDGE_TYPE_LABELS[edge.type] || { label: edge.type.replace(/-/g, ' '), color: 'text-gray-400' };

  const handleDelete = () => {
    removeLink.mutate(
      { nodeId: stripPrefix(edge.from_id), targetId: stripPrefix(edge.to_id), type: edge.type },
      { onSuccess: () => onClose() },
    );
  };

  const NodeButton = ({ node, label }: { node?: OpenTasksGraphNode; label: string }) => {
    if (!node) return <span className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>{label}</span>;
    const status = node.status || 'open';
    const StatusIcon = STATUS_ICONS[status] || Circle;
    return (
      <button
        onClick={() => onSelectNode?.(node)}
        className="flex items-center gap-2 w-full p-2 rounded-lg text-left hover:bg-white/5 transition-colors group"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <StatusIcon className={clsx('w-3.5 h-3.5 shrink-0', STATUS_STYLES[status])} />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate group-hover:text-honey-500 transition-colors">{node.title || node.id}</p>
          <p className="text-2xs capitalize" style={{ color: 'var(--color-text-muted)' }}>{node.type}</p>
        </div>
      </button>
    );
  };

  return (
    <ResizableSidebar>
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link2 className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold">Edge</h3>
          </div>
          <button onClick={onClose} className="btn-ghost p-1 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Type badge */}
        <div className="flex items-center gap-2">
          <span className={clsx('text-xs font-medium capitalize', typeInfo.color)}>
            {typeInfo.label}
          </span>
        </div>

        {/* Source → Target */}
        <div className="space-y-2">
          <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Source</div>
          <NodeButton node={sourceNode} label={edge.from_id} />

          <div className="flex justify-center">
            <ArrowDown className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          </div>

          <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Target</div>
          <NodeButton node={targetNode} label={edge.to_id} />
        </div>

        {/* Details */}
        <div>
          <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>Details</div>
          <div className="space-y-1">
            <DetailRow label="Edge ID" value={edge.id} mono />
            <DetailRow label="Type" value={edge.type} />
            <DetailRow label="From" value={stripPrefix(edge.from_id)} mono />
            <DetailRow label="To" value={stripPrefix(edge.to_id)} mono />
          </div>
        </div>

        {/* Delete */}
        <div className="pt-3 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              className="btn-ghost text-2xs px-2 py-1 rounded text-red-400/60 hover:text-red-400 hover:bg-red-500/10 flex items-center gap-1"
            >
              <Trash2 className="w-3 h-3" />
              Remove edge
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-2xs text-red-400">Remove this edge?</span>
              <button
                onClick={handleDelete}
                disabled={removeLink.isPending}
                className="text-2xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30"
              >
                {removeLink.isPending ? '...' : 'Remove'}
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
          {removeLink.isError && (
            <p className="text-2xs text-red-400 mt-1">
              {removeLink.error instanceof Error ? removeLink.error.message : 'Failed to remove'}
            </p>
          )}
        </div>
      </div>
    </ResizableSidebar>
  );
}
