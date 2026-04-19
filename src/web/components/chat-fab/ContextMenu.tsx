/**
 * ContextMenu — "Add context" dropdown for injecting page context into chat
 */

import { useState } from 'react';
import { Paperclip, ChevronUp } from 'lucide-react';
import { useChatFabContext, type ChatFabContextItem } from './ChatFabContext';
import { formatContextItem } from './ContextFormatter';

interface ContextMenuProps {
  onInject: (text: string) => void;
}

export function ContextMenu({ onInject }: ContextMenuProps) {
  const { items } = useChatFabContext();
  const [open, setOpen] = useState(false);

  if (items.length === 0) return null;

  const handleClick = (item: ChatFabContextItem) => {
    const formatted = formatContextItem(item);
    onInject(formatted);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2 py-1 text-2xs rounded hover:bg-white/5 transition-colors"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <Paperclip className="h-3 w-3" />
        Add context
        <ChevronUp className={`h-3 w-3 transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>

      {open && (
        <div
          className="absolute bottom-full left-0 mb-1 w-64 rounded-md border shadow-lg overflow-hidden"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'var(--color-elevated)',
          }}
        >
          {items.map((item, i) => (
            <button
              key={`${item.type}-${i}`}
              type="button"
              onClick={() => handleClick(item)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-white/5 transition-colors"
              style={{ color: 'var(--color-text)' }}
            >
              <span className="text-honey-500">+</span>
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
