/**
 * CreateTaskForm — Inline form for creating a new task in an OpenTasks resource.
 */

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useCreateOpenTask } from "../../hooks/useApi";
import { Dialog } from "../common/Dialog";

interface Props {
  resourceId: string;
  onCreated?: () => void;
}

export function CreateTaskForm({ resourceId, onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const [assignee, setAssignee] = useState("");

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
          setTitle("");
          setDescription("");
          setPriority(0);
          setAssignee("");
          setOpen(false);
          onCreated?.();
        },
      },
    );
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="btn btn-primary flex items-center gap-1.5 text-xs"
      >
        <Plus className="w-3 h-3" />
        New Task
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="max-w-md">
        <form onSubmit={handleSubmit}>
          <div className="flex items-center justify-between p-4 border-b border-[var(--color-border-subtle)]">
            <span className="text-sm font-semibold">New Task</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-1 rounded hover:bg-white/5"
            >
              <X
                className="w-4 h-4"
                style={{ color: "var(--color-text-muted)" }}
              />
            </button>
          </div>

          <div className="p-4 space-y-3">
            <div>
              <label className="text-xs font-medium block mb-1.5">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Task title"
                className="input text-sm w-full"
                autoFocus
              />
            </div>

            <div>
              <label className="text-xs font-medium block mb-1.5">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional"
                className="input text-sm w-full resize-none"
                rows={3}
              />
            </div>

            <div>
              <label className="text-xs font-medium block mb-1.5">
                Assignee
              </label>
              <input
                type="text"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="Optional"
                className="input text-sm w-full"
              />
            </div>

            <div>
              <label className="text-xs font-medium block mb-1.5">
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="input text-sm w-full"
              >
                <option value={0}>Default</option>
                <option value={1}>Low</option>
                <option value={2}>Medium</option>
                <option value={3}>High</option>
                <option value={4}>Critical</option>
              </select>
            </div>

            {createTask.isError && (
              <p className="text-xs text-red-400">
                {createTask.error instanceof Error
                  ? createTask.error.message
                  : "Failed to create task"}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 p-4 border-t border-[var(--color-border-subtle)]">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="btn btn-ghost text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || createTask.isPending}
              className="btn btn-primary text-xs"
            >
              {createTask.isPending ? "Creating..." : "Create Task"}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
