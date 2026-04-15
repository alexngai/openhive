import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface SpecMarkdownProps {
  content: string;
  className?: string;
}

/**
 * Full-document markdown renderer for spec content. Read-only.
 * (Line-by-line rendering with feedback anchors lives in `MarkdownLine` and
 * is intentionally deferred — feedback anchoring is post-MVP per the spec
 * UI plan.)
 */
export function SpecMarkdown({ content, className = '' }: SpecMarkdownProps) {
  if (!content || content.trim() === '') {
    return (
      <div className={`text-sm italic ${className}`} style={{ color: 'var(--color-text-muted)' }}>
        No content
      </div>
    );
  }

  return (
    <div className={`spec-markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-2xl font-bold mt-6 mb-3" style={{ color: 'var(--color-text)' }}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-bold mt-5 mb-2" style={{ color: 'var(--color-text)' }}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-semibold mt-4 mb-2" style={{ color: 'var(--color-text)' }}>
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-base font-semibold mt-3 mb-1" style={{ color: 'var(--color-text)' }}>
              {children}
            </h4>
          ),
          p: ({ children }) => (
            <p className="my-2 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
              {children}
            </p>
          ),
          ul: ({ children }) => <ul className="list-disc pl-6 my-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-6 my-2 space-y-1">{children}</ol>,
          li: ({ children }) => (
            <li style={{ color: 'var(--color-text-secondary)' }}>{children}</li>
          ),
          code: ({ children, className }) => {
            const isBlock = className?.includes('language-');
            return isBlock ? (
              <code
                className={`block rounded px-3 py-2 my-2 font-mono text-sm overflow-x-auto ${className || ''}`}
                style={{ backgroundColor: 'var(--color-surface)' }}
              >
                {children}
              </code>
            ) : (
              <code
                className="rounded px-1 py-0.5 font-mono text-sm"
                style={{ backgroundColor: 'var(--color-surface)' }}
              >
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre className="my-2">{children}</pre>,
          blockquote: ({ children }) => (
            <blockquote
              className="border-l-2 pl-3 my-2 italic"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              className="underline hover:opacity-80"
              style={{ color: 'var(--color-honey-500, #f59e0b)' }}
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th
              className="border px-3 py-1 text-left text-sm font-semibold"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              className="border px-3 py-1 text-sm"
              style={{ borderColor: 'var(--color-border-subtle)' }}
            >
              {children}
            </td>
          ),
          hr: () => (
            <hr className="my-4" style={{ borderColor: 'var(--color-border-subtle)' }} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
