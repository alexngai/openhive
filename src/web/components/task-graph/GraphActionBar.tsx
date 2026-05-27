/**
 * GraphActionBar — Floating bottom-center action bar for the graph view.
 *
 * Actions: Add Task, Link Nodes (edge creation mode), Add Context.
 * When in link mode, click source → target to create a dependency edge.
 */

import { useState } from 'react';
import { CircleCheckBig, Link2, FileText, X } from 'lucide-react';
import clsx from 'clsx';
import { useCreateOpenTask, useCreateTaskLink, useCreateContext, useCreateContextFile } from '../../hooks/useApi';
import { Dialog } from '../common/Dialog';
import type { OpenTasksGraphNode } from '../../lib/api';

// ============================================================================
// Link mode state
// ============================================================================

export type LinkModeState =
  | { active: false }
  | { active: true; step: 'pick-source' }
  | { active: true; step: 'pick-target'; sourceNode: OpenTasksGraphNode };

const LINK_TYPES = [
  { value: 'blocks', label: 'Blocks' },
  { value: 'depends-on', label: 'Depends on' },
  { value: 'related', label: 'Related' },
  { value: 'parent-of', label: 'Parent of' },
  { value: 'implements', label: 'Implements' },
];

// ============================================================================
// Component
// ============================================================================

interface Props {
  resourceId: string;
  linkMode: LinkModeState;
  onLinkModeChange: (mode: LinkModeState) => void;
  linkType: string;
  onLinkTypeChange: (type: string) => void;
  /** Called after a task or context node is created, with the new node ID */
  onNodeCreated?: (nodeId: string) => void;
}

export function GraphActionBar({ resourceId, linkMode, onLinkModeChange, linkType, onLinkTypeChange, onNodeCreated }: Props) {
  // --- Create Task dialog ---
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDesc, setTaskDesc] = useState('');
  const [taskPriority, setTaskPriority] = useState(0);
  const [taskAssignee, setTaskAssignee] = useState('');
  const createTask = useCreateOpenTask(resourceId);

  const handleCreateTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskTitle.trim()) return;
    createTask.mutate(
      {
        title: taskTitle.trim(),
        description: taskDesc.trim() || undefined,
        priority: taskPriority,
        assignee: taskAssignee.trim() || undefined,
      },
      {
        onSuccess: (result) => {
          setTaskTitle('');
          setTaskDesc('');
          setTaskPriority(0);
          setTaskAssignee('');
          setTaskOpen(false);
          if (result?.node_id) onNodeCreated?.(result.node_id);
        },
      },
    );
  };

  // --- Create Context dialog ---
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxMode, setCtxMode] = useState<'inline' | 'file'>('inline');
  const [ctxTitle, setCtxTitle] = useState('');
  const [ctxContent, setCtxContent] = useState('');
  const [ctxFilePath, setCtxFilePath] = useState('');
  const createInlineCtx = useCreateContext(resourceId);
  const createFileCtx = useCreateContextFile(resourceId);
  const ctxPending = createInlineCtx.isPending || createFileCtx.isPending;

  const handleCreateContext = (e: React.FormEvent) => {
    e.preventDefault();
    const onSuccess = (result: any) => {
      setCtxTitle('');
      setCtxContent('');
      setCtxFilePath('');
      setCtxOpen(false);
      if (result?.node_id) onNodeCreated?.(result.node_id);
    };
    if (ctxMode === 'inline') {
      if (!ctxTitle.trim()) return;
      createInlineCtx.mutate({ title: ctxTitle.trim(), content: ctxContent.trim() || undefined }, { onSuccess });
    } else {
      if (!ctxFilePath.trim()) return;
      createFileCtx.mutate({ filePath: ctxFilePath.trim(), title: ctxTitle.trim() || undefined }, { onSuccess });
    }
  };

  // --- Link mode UI ---
  const handleStartLink = () => {
    onLinkModeChange({ active: true, step: 'pick-source' });
  };

  const handleCancelLink = () => {
    onLinkModeChange({ active: false });
  };

  return (
    <>
      {/* Floating action bar. Background + border use semantic tokens so the
          bar reads cleanly on both themes; action-tinted button accents are
          kept (translucent hex over neutral bg) since the color cue is the
          information channel — `var()` references won't work inside an SVG
          marker or canvas paint anyway. */}
      <div
        className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 p-1.5 rounded-lg shadow-lg"
        style={{
          backgroundColor: 'var(--color-surface)',
          border: '1px solid var(--color-border-subtle)',
        }}
      >
        {linkMode.active ? (
          /* --- Link mode indicator --- */
          <div className="flex items-center gap-2 px-2">
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: 'var(--color-accent)' }}
              />
              <span
                className="text-xs font-semibold"
                style={{ color: 'var(--color-accent)' }}
              >
                {linkMode.step === 'pick-source'
                  ? 'Select source node'
                  : 'Select target node'}
              </span>
            </div>
            {linkMode.step === 'pick-target' && (
              <span
                className="text-2xs px-2 py-0.5 rounded max-w-[160px] truncate"
                style={{
                  backgroundColor: 'var(--color-accent-bg, rgba(245, 158, 11, 0.12))',
                  color: 'var(--color-accent)',
                }}
              >
                from: {linkMode.sourceNode.title || linkMode.sourceNode.id}
              </span>
            )}
            <select
              value={linkType}
              onChange={(e) => onLinkTypeChange(e.target.value)}
              className="text-xs py-1 px-2 rounded border-0 cursor-pointer"
              style={{
                backgroundColor: 'var(--color-elevated)',
                color: 'var(--color-text)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {LINK_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            <button
              onClick={handleCancelLink}
              className="w-9 h-9 flex items-center justify-center rounded transition-all hover:scale-105 active:scale-95"
              style={{
                backgroundColor: 'var(--color-danger-bg, rgba(239, 68, 68, 0.1))',
                border: '1px solid var(--color-danger-border, rgba(239, 68, 68, 0.3))',
              }}
              title="Cancel"
              aria-label="Cancel link mode"
            >
              <X className="w-4 h-4" style={{ color: 'var(--color-danger)' }} />
            </button>
          </div>
        ) : (
          /* --- Square icon buttons. Each kept as a tinted chip so the color
              cue still distinguishes action type, but routed through tokens
              + low-alpha accent backgrounds that work on both themes. */
          <>
            <ActionPill
              accent="#3b82f6"
              icon={<CircleCheckBig className="w-5 h-5" />}
              label="New Task"
              onClick={() => setTaskOpen(true)}
            />
            <ActionPill
              accent="var(--color-accent)"
              icon={<Link2 className="w-5 h-5" />}
              label="Link Nodes"
              onClick={handleStartLink}
            />
            <ActionPill
              accent="#10b981"
              icon={<FileText className="w-5 h-5" />}
              label="Add Context"
              onClick={() => setCtxOpen(true)}
            />
          </>
        )}
      </div>

      {/* Create Task Dialog */}
      <Dialog open={taskOpen} onClose={() => setTaskOpen(false)} maxWidth="max-w-md">
        <form onSubmit={handleCreateTask}>
          <div className="flex items-center justify-between p-4 border-b border-[var(--color-border-subtle)]">
            <span className="text-sm font-semibold">New Task</span>
            <button type="button" onClick={() => setTaskOpen(false)} className="p-1 rounded hover:bg-hover">
              <X className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
            </button>
          </div>
          <div className="p-4 space-y-3">
            <div>
              <label className="text-xs font-medium block mb-1.5">Title</label>
              <input type="text" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} placeholder="Task title" className="input text-sm w-full" autoFocus />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5">Description</label>
              <textarea value={taskDesc} onChange={(e) => setTaskDesc(e.target.value)} placeholder="Optional" className="input text-sm w-full resize-none" rows={3} />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5">Assignee</label>
              <input type="text" value={taskAssignee} onChange={(e) => setTaskAssignee(e.target.value)} placeholder="Optional" className="input text-sm w-full" />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5">Priority</label>
              <select value={taskPriority} onChange={(e) => setTaskPriority(Number(e.target.value))} className="input text-sm w-full">
                <option value={0}>Default</option>
                <option value={1}>Low</option>
                <option value={2}>Medium</option>
                <option value={3}>High</option>
                <option value={4}>Critical</option>
              </select>
            </div>
            {createTask.isError && (
              <p className="text-xs">{createTask.error instanceof Error ? createTask.error.message : 'Failed to create task'}</p>
            )}
          </div>
          <div className="flex justify-end gap-2 p-4 border-t border-[var(--color-border-subtle)]">
            <button type="button" onClick={() => setTaskOpen(false)} className="btn btn-ghost text-xs">Cancel</button>
            <button type="submit" disabled={!taskTitle.trim() || createTask.isPending} className="btn btn-primary text-xs">
              {createTask.isPending ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      </Dialog>

      {/* Create Context Dialog */}
      <Dialog open={ctxOpen} onClose={() => setCtxOpen(false)} maxWidth="max-w-md">
        <form onSubmit={handleCreateContext}>
          <div className="flex items-center justify-between p-4 border-b border-[var(--color-border-subtle)]">
            <span className="text-sm font-semibold flex items-center gap-2">
              <FileText className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
              New Context
            </span>
            <button type="button" onClick={() => setCtxOpen(false)} className="p-1 rounded hover:bg-hover">
              <X className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
            </button>
          </div>
          <div className="p-4 space-y-4">
            <div className="flex gap-1 text-xs">
              <button type="button" onClick={() => setCtxMode('inline')} className={`px-3 py-1 rounded-md transition-colors ${ctxMode === 'inline' ? 'bg-accent/15 text-accent' : 'hover:bg-hover'}`} style={ctxMode !== 'inline' ? { color: 'var(--color-text-muted)' } : {}}>Inline</button>
              <button type="button" onClick={() => setCtxMode('file')} className={`px-3 py-1 rounded-md transition-colors ${ctxMode === 'file' ? 'bg-accent/15 text-accent' : 'hover:bg-hover'}`} style={ctxMode !== 'file' ? { color: 'var(--color-text-muted)' } : {}}>File</button>
            </div>
            {ctxMode === 'inline' ? (
              <>
                <div>
                  <label className="text-xs font-medium block mb-1.5">Title</label>
                  <input type="text" value={ctxTitle} onChange={(e) => setCtxTitle(e.target.value)} placeholder="Context title" className="input text-sm w-full" autoFocus />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5">Content</label>
                  <textarea value={ctxContent} onChange={(e) => setCtxContent(e.target.value)} placeholder="Markdown content" className="input text-sm w-full resize-none" rows={8} />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="text-xs font-medium block mb-1.5">File Path</label>
                  <input type="text" value={ctxFilePath} onChange={(e) => setCtxFilePath(e.target.value)} placeholder="src/path/to/file.ts" className="input text-sm w-full font-mono" autoFocus />
                  <p className="text-2xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>Content resolved on access. Drift detection tracks file changes.</p>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5">Title</label>
                  <input type="text" value={ctxTitle} onChange={(e) => setCtxTitle(e.target.value)} placeholder="Optional — defaults to filename" className="input text-sm w-full" />
                </div>
              </>
            )}
            {(createInlineCtx.error || createFileCtx.error) && (
              <p className="text-xs">{((createInlineCtx.error || createFileCtx.error) as Error)?.message || 'Failed to create context'}</p>
            )}
          </div>
          <div className="flex justify-end gap-2 p-4 border-t border-[var(--color-border-subtle)]">
            <button type="button" onClick={() => setCtxOpen(false)} className="btn btn-ghost text-xs">Cancel</button>
            <button type="submit" disabled={(ctxMode === 'inline' ? !ctxTitle.trim() : !ctxFilePath.trim()) || ctxPending} className="btn btn-primary text-xs">
              {ctxPending ? 'Creating...' : 'Create Context'}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/** Action button used by GraphActionBar — flat tinted chip with theme-token
 *  background + neutral border, the action accent restricted to the icon and
 *  the hover tint. Works on both light and dark themes since the action
 *  color is only applied at low alpha to text/border. */
function ActionPill({
  accent,
  icon,
  label,
  onClick,
}: {
  accent: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <div className="relative group/btn">
      <button
        onClick={onClick}
        className="w-11 h-11 flex items-center justify-center rounded-md transition-all hover:scale-105 active:scale-95"
        style={{
          backgroundColor: 'var(--color-elevated)',
          border: `1px solid ${accent}40`,
          color: accent,
        }}
        title={label}
        aria-label={label}
      >
        {icon}
      </button>
      <span
        className="absolute -top-8 left-1/2 -translate-x-1/2 text-2xs font-medium px-2 py-0.5 rounded whitespace-nowrap opacity-0 group-hover/btn:opacity-100 transition-opacity pointer-events-none"
        style={{
          backgroundColor: 'var(--color-elevated)',
          border: '1px solid var(--color-border-subtle)',
          color: 'var(--color-text)',
        }}
      >
        {label}
      </span>
    </div>
  );
}

/** Exported getter for the current link type selection (used by parent) */
export { LINK_TYPES };
