/**
 * CreateTaskForm — Inline form for creating a new task in an OpenTasks resource.
 */

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useCreateOpenTask } from '../../hooks/useApi';

interface Props {
  resourceId: string;
  onCreated?: () => void;
}

export function CreateTaskForm({ resourceId, onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(0);
  const [assignee, setAssignee] = useState('');

  const createTask = useCreateOpenTask(resourceId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    createTask.mutate(
      {
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        assignee: assignee.trim() || undefined,
      },
      {
        onSuccess: () => {
          setTitle('');
          setDescription('');
          setPriority(0);
          setAssignee('');
          setOpen(false);
          onCreated?.();
        },
      },
    );
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="btn-ghost text-xs flex items-center gap-1.5 px-2 py-1"
      >
        <Plus className="w-3 h-3" />
        New Task
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">New Task</span>
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost p-0.5">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title"
        className="input text-xs w-full"
        autoFocus
      />

      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        className="input text-xs w-full resize-none"
        rows={2}
      />

      <input
        type="text"
        value={assignee}
        onChange={(e) => setAssignee(e.target.value)}
        placeholder="Assignee (optional)"
        className="input text-xs w-full"
      />

      <div className="flex items-center gap-2">
        <label className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Priority</label>
        <select
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
          className="input text-2xs px-1.5 py-0.5"
        >
          <option value={0}>Default (0)</option>
          <option value={1}>Low (1)</option>
          <option value={2}>Medium (2)</option>
          <option value={3}>High (3)</option>
          <option value={4}>Critical (4)</option>
        </select>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="btn-ghost text-2xs px-2 py-1"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!title.trim() || createTask.isPending}
          className="btn-primary text-2xs px-3 py-1"
        >
          {createTask.isPending ? 'Creating...' : 'Create'}
        </button>
      </div>

      {createTask.isError && (
        <p className="text-2xs text-red-400">
          {createTask.error instanceof Error ? createTask.error.message : 'Failed to create task'}
        </p>
      )}
    </form>
  );
}
