import { useMemo } from 'react';

interface HighlightProps {
  text: string;
  query: string;
  className?: string;
  highlightClassName?: string;
}

export function Highlight({
  text,
  query,
  className = '',
  highlightClassName = 'bg-honey-500/30 text-honey-400 px-0.5 rounded',
}: HighlightProps) {
  const parts = useMemo(() => {
    if (!query.trim()) {
      return [{ text, highlighted: false }];
    }

    // Escape special regex characters in query
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Split into words for multi-word highlighting
    const words = escapedQuery.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return [{ text, highlighted: false }];
    }

    // Create regex pattern that matches any of the query words
    const pattern = new RegExp(`(${words.join('|')})`, 'gi');

    const result: { text: string; highlighted: boolean }[] = [];
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      // Add text before the match
      if (match.index > lastIndex) {
        result.push({
          text: text.slice(lastIndex, match.index),
          highlighted: false,
        });
      }

      // Add the matched text
      result.push({
        text: match[0],
        highlighted: true,
      });

      lastIndex = pattern.lastIndex;
    }

    // Add remaining text after last match
    if (lastIndex < text.length) {
      result.push({
        text: text.slice(lastIndex),
        highlighted: false,
      });
    }

    return result.length > 0 ? result : [{ text, highlighted: false }];
  }, [text, query]);

  return (
    <span className={className}>
      {parts.map((part, index) =>
        part.highlighted ? (
          <mark key={index} className={highlightClassName}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </span>
  );
}
