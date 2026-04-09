/**
 * TiptapEditor — Lightweight rich text editor with markdown I/O.
 * Supports formatted (rich text) and markdown (plain textarea) views.
 */

import { useState, useEffect, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TurndownService from 'turndown';
import { Bold, Italic, Code, List, ListOrdered, Heading2 } from 'lucide-react';
import clsx from 'clsx';

// ── Markdown conversion ─────────────────────────────────────────────────────

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

function markdownToHtml(md: string): string {
  if (!md) return '';
  return md
    .split('\n\n')
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('### ')) return `<h3>${inlineFmt(trimmed.slice(4))}</h3>`;
      if (trimmed.startsWith('## ')) return `<h2>${inlineFmt(trimmed.slice(3))}</h2>`;
      if (trimmed.startsWith('# ')) return `<h1>${inlineFmt(trimmed.slice(2))}</h1>`;
      if (trimmed.startsWith('```')) {
        const lines = trimmed.split('\n');
        return `<pre><code>${esc(lines.slice(1, -1).join('\n'))}</code></pre>`;
      }
      if (trimmed.startsWith('- ')) {
        const items = trimmed.split('\n').map((l) => `<li>${inlineFmt(l.replace(/^- /, ''))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      if (trimmed.startsWith('> ')) return `<blockquote><p>${inlineFmt(trimmed.slice(2))}</p></blockquote>`;
      return `<p>${inlineFmt(trimmed)}</p>`;
    })
    .join('');
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineFmt(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

const VIEW_MODE_KEY = 'openhive-editor-view';

// ── View mode hook ──────────────────────────────────────────────────────────

export function useEditorViewMode() {
  const [mode, setMode] = useState<'formatted' | 'markdown'>(
    () => (localStorage.getItem(VIEW_MODE_KEY) as 'formatted' | 'markdown') || 'formatted',
  );
  const toggle = () => {
    const next = mode === 'formatted' ? 'markdown' : 'formatted';
    setMode(next);
    localStorage.setItem(VIEW_MODE_KEY, next);
  };
  return { mode, toggle };
}

// ── Component ───────────────────────────────────────────────────────────────

export interface TiptapEditorProps {
  content: string;
  editable?: boolean;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  showToolbar?: boolean;
  viewMode?: 'formatted' | 'markdown';
  minHeight?: string;
}

export function TiptapEditor({
  content,
  editable = true,
  onChange,
  placeholder = 'Write something...',
  showToolbar = true,
  viewMode = 'formatted',
  minHeight = '80px',
}: TiptapEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const suppressUpdate = useRef(false);
  const [rawMarkdown, setRawMarkdown] = useState(content);

  // ── Tiptap (formatted mode) ──

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder }),
    ],
    editable,
    content: markdownToHtml(content),
    onUpdate: ({ editor }) => {
      if (suppressUpdate.current) return;
      const md = htmlToMarkdown(editor.getHTML());
      setRawMarkdown(md);
      onChangeRef.current?.(md);
    },
  });

  // Keep editable in sync
  useEffect(() => {
    if (editor && editor.isEditable !== editable) {
      editor.setEditable(editable);
    }
  }, [editor, editable]);

  // When switching TO formatted, sync tiptap from raw markdown
  useEffect(() => {
    if (viewMode === 'formatted' && editor) {
      suppressUpdate.current = true;
      editor.commands.setContent(markdownToHtml(rawMarkdown));
      setTimeout(() => { suppressUpdate.current = false; }, 0);
    }
  }, [viewMode]);

  // ── Render ──

  if (viewMode === 'markdown') {
    return (
      <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <textarea
          value={rawMarkdown}
          onChange={(e) => {
            setRawMarkdown(e.target.value);
            onChangeRef.current?.(e.target.value);
          }}
          placeholder={placeholder}
          className="w-full bg-transparent text-2xs font-mono px-2.5 py-1.5 outline-none resize-none"
          style={{ minHeight, color: 'var(--color-text-secondary)' }}
          readOnly={!editable}
        />
      </div>
    );
  }

  return (
    <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--color-border-subtle)' }}>
      {showToolbar && editable && editor && (
        <div className="flex items-center gap-0.5 px-1.5 py-1 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <Btn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} title="Bold"><Bold className="w-3 h-3" /></Btn>
          <Btn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic"><Italic className="w-3 h-3" /></Btn>
          <Btn active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} title="Code"><Code className="w-3 h-3" /></Btn>
          <Btn active={editor.isActive('heading')} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading"><Heading2 className="w-3 h-3" /></Btn>
          <Btn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} title="List"><List className="w-3 h-3" /></Btn>
          <Btn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered"><ListOrdered className="w-3 h-3" /></Btn>
        </div>
      )}
      <div style={{ minHeight }}>
        <EditorContent
          editor={editor}
          className={clsx(
            'prose prose-invert prose-sm max-w-none px-2.5 py-1.5 text-sm',
            '[&_.tiptap]:outline-none [&_.tiptap]:min-h-[inherit]',
            '[&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_p]:text-sm [&_li]:text-sm',
            '[&_pre]:bg-black/20 [&_pre]:rounded [&_pre]:p-2 [&_pre]:text-sm',
            '[&_code]:bg-white/10 [&_code]:rounded [&_code]:px-1 [&_code]:text-sm',
            '[&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-2 [&_blockquote]:italic [&_blockquote]:text-sm',
            '[&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.is-editor-empty:first-child::before]:text-gray-600 [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:pointer-events-none',
            !editable && 'cursor-default',
          )}
        />
      </div>
    </div>
  );
}

function Btn({ active, onClick, title, children }: { active: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className={clsx('p-1 rounded', active ? 'bg-honey-500/20 text-honey-500' : 'hover:bg-white/10')} style={!active ? { color: 'var(--color-text-muted)' } : {}}>
      {children}
    </button>
  );
}
