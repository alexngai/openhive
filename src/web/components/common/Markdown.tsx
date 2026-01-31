import { useMemo } from 'react';
import { marked } from 'marked';
import clsx from 'clsx';

interface MarkdownProps {
  content: string;
  className?: string;
  inline?: boolean;
}

// Configure marked for security
marked.setOptions({
  gfm: true,
  breaks: true,
});

// Sanitize HTML to prevent XSS
function sanitizeHtml(html: string): string {
  // Basic sanitization - remove script tags and event handlers
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .replace(/javascript:/gi, '');
}

export function Markdown({ content, className, inline = false }: MarkdownProps) {
  const html = useMemo(() => {
    try {
      const parsed = inline
        ? marked.parseInline(content)
        : marked.parse(content);
      return sanitizeHtml(parsed as string);
    } catch {
      return content;
    }
  }, [content, inline]);

  if (inline) {
    return (
      <span
        className={clsx('markdown-inline', className)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }

  return (
    <div
      className={clsx('markdown-content prose prose-invert max-w-none', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
