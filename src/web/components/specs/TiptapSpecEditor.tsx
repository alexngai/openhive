import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Placeholder from '@tiptap/extension-placeholder';
import TableOfContents from '@tiptap/extension-table-of-contents';
import { common, createLowlight } from 'lowlight';
import { useEffect, useRef, useState } from 'react';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import TurndownService from 'turndown';
import './tiptap.css';

export interface TocItem {
  id: string;
  level: number;
  textContent: string;
  isActive: boolean;
  isScrolledOver: boolean;
}

const lowlight = createLowlight(common);

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    hr: '---',
    emDelimiter: '_',
    strongDelimiter: '**',
  });

  td.addRule('strikethrough', {
    filter: ['del', 's'] as any,
    replacement: (content) => `~~${content}~~`,
  });

  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      content = content.trim().replace(/\n\n/g, '\n');
      const parent = node.parentNode;
      if (!parent) return content;
      const prefix = /ol/i.test(parent.nodeName) ? '1. ' : '- ';
      return prefix + content.replace(/\n/g, '\n  ') + '\n';
    },
  });

  return td;
}

function editorToMarkdown(editor: ReturnType<typeof useEditor>): string {
  if (!editor) return '';
  return createTurndown().turndown(editor.getHTML());
}

interface TiptapSpecEditorProps {
  content: string;
  editable?: boolean;
  onChange?: (markdown: string) => void;
  placeholder?: string;
  onTocUpdate?: (items: TocItem[]) => void;
  className?: string;
}

/**
 * Inherently-editable spec editor backed by Tiptap. Markdown in → HTML for
 * editing → markdown back out via Turndown. Parent owns debounced auto-save;
 * this component fires `onChange` on every keystroke with round-tripped MD
 * and guards against re-emitting identical content to avoid save oscillation
 * from the lossy HTML↔MD conversion (sudocode pattern).
 */
export function TiptapSpecEditor({
  content,
  editable = true,
  onChange,
  placeholder = 'Start writing the spec...',
  onTocUpdate,
  className = '',
}: TiptapSpecEditorProps) {
  const [htmlContent, setHtmlContent] = useState('');
  const isLoadingContentRef = useRef(false);
  const lastContentRef = useRef<string>('');

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        codeBlock: false,
      }),
      CodeBlockLowlight.configure({ lowlight }),
      Placeholder.configure({ placeholder, emptyEditorClass: 'is-editor-empty' }),
      TableOfContents.configure({
        onUpdate: (items) => {
          if (onTocUpdate) onTocUpdate(items as TocItem[]);
        },
      }),
    ],
    editable,
    content: htmlContent,
    onUpdate: ({ editor }) => {
      if (isLoadingContentRef.current) return;
      if (!onChange) return;
      const md = editorToMarkdown(editor);
      if (md !== lastContentRef.current) {
        lastContentRef.current = md;
        onChange(md);
      }
    },
  });

  useEffect(() => {
    if (!content) {
      setHtmlContent('');
      return;
    }
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeStringify, { allowDangerousHtml: true })
      .process(content)
      .then((file) => setHtmlContent(String(file)))
      .catch((err) => {
        console.error('Failed to convert markdown to HTML:', err);
        setHtmlContent(`<pre>${content}</pre>`);
      });
  }, [content]);

  useEffect(() => {
    if (editor && htmlContent && !editor.isFocused) {
      isLoadingContentRef.current = true;
      editor.commands.setContent(htmlContent, { emitUpdate: true });
      // Baseline lastContentRef against round-tripped markdown so the first
      // onUpdate after programmatic load doesn't trigger a false-positive save.
      lastContentRef.current = editorToMarkdown(editor);
      const t = setTimeout(() => {
        isLoadingContentRef.current = false;
      }, 100);
      return () => clearTimeout(t);
    }
  }, [htmlContent, editor]);

  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editable, editor]);

  if (!editor) {
    return (
      <div className={className}>
        <div className="animate-pulse space-y-2">
          <div className="h-4 w-3/4 rounded bg-white/10" />
          <div className="h-4 w-1/2 rounded bg-white/10" />
          <div className="h-4 w-5/6 rounded bg-white/10" />
        </div>
      </div>
    );
  }

  return (
    <div className={className}>
      <EditorContent
        editor={editor}
        className="tiptap-spec-editor prose prose-sm dark:prose-invert max-w-none"
      />
    </div>
  );
}
