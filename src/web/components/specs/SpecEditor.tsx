import { useState, useCallback } from 'react';
import clsx from 'clsx';
import { Eye, Pencil, Trash2, Save, X } from 'lucide-react';
import { SpecMarkdown } from './SpecMarkdown';

export interface SpecDraft {
  title: string;
  content: string;
  priority?: number;
}

interface SpecEditorProps {
  initial?: Partial<SpecDraft>;
  /** Show "Discard draft" button (compose mode only). */
  showDiscard?: boolean;
  /** Disable Save while in flight. */
  saving?: boolean;
  saveLabel?: string;
  cancelLabel?: string;
  onSave: (draft: SpecDraft) => void | Promise<void>;
  onCancel?: () => void;
  onDiscardDraft?: () => void;
  /** Called with current draft on every change — for autosave. */
  onChange?: (draft: SpecDraft) => void;
  errorMessage?: string | null;
}

export function SpecEditor({
  initial,
  showDiscard = false,
  saving = false,
  saveLabel = 'Save',
  cancelLabel = 'Cancel',
  onSave,
  onCancel,
  onDiscardDraft,
  onChange,
  errorMessage,
}: SpecEditorProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [priority, setPriority] = useState<number | undefined>(initial?.priority);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');

  const propagate = useCallback(
    (next: Partial<SpecDraft>) => {
      onChange?.({ title, content, priority, ...next });
    },
    [title, content, priority, onChange],
  );

  const updateTitle = (v: string) => {
    setTitle(v);
    propagate({ title: v });
  };
  const updateContent = (v: string) => {
    setContent(v);
    propagate({ content: v });
  };
  const updatePriority = (v: number | undefined) => {
    setPriority(v);
    propagate({ priority: v });
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    await onSave({ title: title.trim(), content, priority });
  };

  return (
    <div className="space-y-3">
      {/* Title */}
      <div>
        <label className="block text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
          Title
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => updateTitle(e.target.value)}
          placeholder="What is this spec for?"
          className="w-full px-3 py-2 rounded-md border bg-transparent outline-none focus:ring-1 focus:ring-honey-500"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text)',
          }}
          maxLength={500}
        />
      </div>

      {/* Priority */}
      <div className="flex items-center gap-2">
        <label className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Priority
        </label>
        <select
          value={priority === undefined ? '' : String(priority)}
          onChange={(e) =>
            updatePriority(e.target.value === '' ? undefined : Number(e.target.value))
          }
          className="px-2 py-1 rounded-md border bg-transparent text-sm outline-none"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text)',
          }}
        >
          <option value="">—</option>
          <option value="0">P0</option>
          <option value="1">P1</option>
          <option value="2">P2</option>
          <option value="3">P3</option>
          <option value="4">P4</option>
        </select>
      </div>

      {/* Editor / preview tabs */}
      <div className="flex gap-1 text-xs">
        <button
          type="button"
          onClick={() => setTab('edit')}
          className={clsx(
            'flex items-center gap-1 px-3 py-1.5 rounded-md transition-colors',
            tab === 'edit' ? 'bg-white/10' : 'hover:bg-white/5',
          )}
          style={{ color: 'var(--color-text)' }}
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
        <button
          type="button"
          onClick={() => setTab('preview')}
          className={clsx(
            'flex items-center gap-1 px-3 py-1.5 rounded-md transition-colors',
            tab === 'preview' ? 'bg-white/10' : 'hover:bg-white/5',
          )}
          style={{ color: 'var(--color-text)' }}
        >
          <Eye className="h-3 w-3" />
          Preview
        </button>
      </div>

      {/* Editor / preview body */}
      <div
        className="rounded-md border"
        style={{
          borderColor: 'var(--color-border-subtle)',
          backgroundColor: 'var(--color-surface)',
        }}
      >
        {tab === 'edit' ? (
          <textarea
            value={content}
            onChange={(e) => updateContent(e.target.value)}
            placeholder="Write the spec in markdown. Goals, acceptance criteria, out-of-scope, anything that frames the work."
            className="w-full min-h-[400px] px-4 py-3 bg-transparent font-mono text-sm leading-6 outline-none resize-y"
            style={{ color: 'var(--color-text)' }}
            maxLength={50_000}
          />
        ) : (
          <div className="px-4 py-3 min-h-[400px]">
            <SpecMarkdown content={content} />
          </div>
        )}
      </div>

      {/* Error */}
      {errorMessage && (
        <div
          className="rounded-md border p-3 text-sm"
          style={{
            borderColor: 'var(--color-border-subtle)',
            color: 'var(--color-text)',
          }}
        >
          {errorMessage}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between gap-2">
        <div>
          {showDiscard && onDiscardDraft && (content || title) && (
            <button
              type="button"
              onClick={onDiscardDraft}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/5"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <Trash2 className="h-3 w-3" />
              Discard draft
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded hover:bg-white/5"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <X className="h-4 w-4" />
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !title.trim()}
            className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded bg-honey-500 text-black font-medium hover:bg-honey-400 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving…' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
