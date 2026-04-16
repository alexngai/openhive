import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownLineProps {
  content: string;
  className?: string;
  onClick?: () => void;
  onMouseUp?: () => void;
}

/**
 * Renders a single line of markdown content. Intended for line-by-line
 * rendering where each line keeps its own identity (e.g. anchored selection).
 */
export function MarkdownLine({ content, className = '', onClick, onMouseUp }: MarkdownLineProps) {
  if (!content || content.trim() === '') {
    return (
      <div className={`min-h-[1.5rem] ${className}`} onClick={onClick} onMouseUp={onMouseUp}>
        &nbsp;
      </div>
    );
  }

  return (
    <div className={`markdown-line ${className}`} onClick={onClick} onMouseUp={onMouseUp}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <span>{children}</span>,
          h1: ({ children }) => <span className="text-2xl font-bold">{children}</span>,
          h2: ({ children }) => <span className="text-xl font-bold">{children}</span>,
          h3: ({ children }) => <span className="text-lg font-bold">{children}</span>,
          h4: ({ children }) => <span className="text-base font-bold">{children}</span>,
          h5: ({ children }) => <span className="text-sm font-bold">{children}</span>,
          h6: ({ children }) => <span className="text-xs font-bold">{children}</span>,
          code: ({ children, className }) => (
            <code className={`rounded bg-white/5 px-1 py-0.5 font-mono text-sm ${className || ''}`}>
              {children}
            </code>
          ),
          strong: ({ children }) => <strong className="font-bold">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-honey-500 underline hover:text-honey-400"
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
