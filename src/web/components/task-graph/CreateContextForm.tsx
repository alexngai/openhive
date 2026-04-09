/**
 * CreateContextForm — Inline form for creating context nodes (inline or file-backed).
 */

import { useState } from 'react';
import { X, FileText, FileCode } from 'lucide-react';
import { useCreateContext, useCreateContextFile } from '../../hooks/useApi';
import { Dialog } from '../common/Dialog';

interface Props {
  resourceId: string;
  onCreated?: () => void;
}

type ContextMode = 'inline' | 'file';

export function CreateContextForm({ resourceId, onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ContextMode>('inline');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [filePath, setFilePath] = useState('');

  const createInline = useCreateContext(resourceId);
  const createFile = useCreateContextFile(resourceId);
  const isPending = createInline.isPending || createFile.isPending;
  const error = createInline.error || createFile.error;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const onSuccess = () => {
      setTitle('');
      setContent('');
      setFilePath('');
      setOpen(false);
      onCreated?.();
    };

    if (mode === 'inline') {
      if (!title.trim()) return;
      createInline.mutate(
        { title: title.trim(), content: content.trim() || undefined },
        { onSuccess },
      );
    } else {
      if (!filePath.trim()) return;
      createFile.mutate(
        { filePath: filePath.trim(), title: title.trim() || undefined },
        { onSuccess },
      );
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs flex items-center gap-1.5 px-2 py-1 rounded-md border cursor-pointer hover:bg-white/5 transition-colors"
        style={{ borderColor: 'var(--color-border)' }}
      >
        <FileText className="w-3 h-3" />
        Context
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="max-w-md">
        <form onSubmit={handleSubmit}>
          <div className="flex items-center justify-between p-4 border-b border-[var(--color-border-subtle)]">
            <span className="text-sm font-semibold flex items-center gap-2">
              <FileText className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
              New Context
            </span>
            <button type="button" onClick={() => setOpen(false)} className="p-1 rounded hover:bg-white/5">
              <X className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
            </button>
          </div>

          <div className="p-4 space-y-4">
            {/* Mode tabs */}
            <div className="flex gap-1 text-xs">
              <button
                type="button"
                onClick={() => setMode('inline')}
                className={`px-3 py-1 rounded-md transition-colors ${mode === 'inline' ? 'bg-honey-500/15 text-honey-500' : 'hover:bg-white/5'}`}
                style={mode !== 'inline' ? { color: 'var(--color-text-muted)' } : {}}
              >
                <FileText className="w-3.5 h-3.5 inline mr-1.5" />
                Inline
              </button>
              <button
                type="button"
                onClick={() => setMode('file')}
                className={`px-3 py-1 rounded-md transition-colors ${mode === 'file' ? 'bg-honey-500/15 text-honey-500' : 'hover:bg-white/5'}`}
                style={mode !== 'file' ? { color: 'var(--color-text-muted)' } : {}}
              >
                <FileCode className="w-3.5 h-3.5 inline mr-1.5" />
                File
              </button>
            </div>

            {mode === 'inline' ? (
              <>
                <div>
                  <label className="text-xs font-medium block mb-1.5">Title</label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Context title"
                    className="input text-sm w-full"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5">Content</label>
                  <textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Markdown content"
                    className="input text-sm w-full resize-none"
                    rows={8}
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="text-xs font-medium block mb-1.5">File Path</label>
                  <input
                    type="text"
                    value={filePath}
                    onChange={(e) => setFilePath(e.target.value)}
                    placeholder="src/path/to/file.ts"
                    className="input text-sm w-full font-mono"
                    autoFocus
                  />
                  <p className="text-2xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
                    Content resolved on access. Drift detection tracks file changes.
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium block mb-1.5">Title</label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Optional — defaults to filename"
                    className="input text-sm w-full"
                  />
                </div>
              </>
            )}

            {error && (
              <p className="text-xs text-red-400">
                {error instanceof Error ? error.message : 'Failed to create context'}
              </p>
            )}
          </div>

          <div className="flex justify-end gap-2 p-4 border-t border-[var(--color-border-subtle)]">
            <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost text-xs">
              Cancel
            </button>
            <button
              type="submit"
              disabled={(mode === 'inline' ? !title.trim() : !filePath.trim()) || isPending}
              className="btn btn-primary text-xs"
            >
              {isPending ? 'Creating...' : 'Create Context'}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
