/**
 * MarkdownContent — Renders markdown text with syntax-highlighted code blocks.
 *
 * Uses react-markdown + remark-gfm for GFM support (tables, strikethrough, etc.)
 * and rehype-highlight (lowlight / highlight.js) for code block syntax highlighting.
 *
 * Styled to match OpenHive's CSS variable system.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import './markdown.css';

interface MarkdownContentProps {
  children: string;
  className?: string;
}

export function MarkdownContent({ children, className = '' }: MarkdownContentProps) {
  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Open links in new tab
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
