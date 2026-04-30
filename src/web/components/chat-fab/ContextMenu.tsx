/**
 * ContextMenu — "Add context" dropdown for injecting page context into chat.
 *
 * Clicking an item stages a chip via `useChatFabStagedChipsStore.addChip`.
 * The menu closes; nothing is sent until the user presses Send on the
 * composer. Primary item (§6.1) renders at the top with `@Current page`
 * prefix and is separated from the rest. The parent ChatPanel forwards the
 * textarea `@` keystroke via the exposed `openWithPrimary()` handle.
 *
 * Rendered only when `CHAT_CONTEXT_CHIPS` is enabled (the default). When the
 * `VITE_CHAT_CONTEXT_CHIPS=false` escape hatch is set, ChatPanel renders the
 * plain `ChatInput` without a context menu at all.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Paperclip, ChevronUp } from 'lucide-react';
import type { ChatFabContextItem } from './chat-fab-item';
import { usePageContextStore } from './page-context-store';
import { useChatFabStagedChipsStore } from './chat-fab-staged-chips-store';

export interface ContextMenuHandle {
  /**
   * Open the menu with the primary item preselected. Pressing Enter stages
   * the primary as a chip. A no-op if no primary item exists on the current
   * page.
   */
  openWithPrimary: () => boolean;
}

export const ContextMenu = forwardRef<ContextMenuHandle, Record<string, never>>(
  function ContextMenu(_props, ref) {
    const items = usePageContextStore((s) => s.items);
    const addChip = useChatFabStagedChipsStore((s) => s.addChip);
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState<number>(-1);
    const menuRef = useRef<HTMLDivElement>(null);
    const rootRef = useRef<HTMLDivElement>(null);

    // Primary first, then rest in registration order. Same primary enforcement
    // runs in the store; here we just consume.
    const primary = items.find((i) => i.primary) ?? null;
    const rest = items.filter((i) => !i.primary);
    const ordered: ChatFabContextItem[] = primary ? [primary, ...rest] : rest;

    useImperativeHandle(
      ref,
      () => ({
        openWithPrimary: () => {
          if (!primary) return false;
          setOpen(true);
          setActiveIndex(0);
          // Focus the list so Enter works.
          setTimeout(() => menuRef.current?.focus(), 0);
          return true;
        },
      }),
      [primary],
    );

    // Close on outside click.
    useEffect(() => {
      if (!open) return;
      const onDown = (e: MouseEvent) => {
        if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
          setOpen(false);
        }
      };
      window.addEventListener('mousedown', onDown);
      return () => window.removeEventListener('mousedown', onDown);
    }, [open]);

    if (items.length === 0) return null;

    const doSelect = (item: ChatFabContextItem) => {
      addChip(item);
      setOpen(false);
      setActiveIndex(-1);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(ordered.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = ordered[activeIndex] ?? ordered[0];
        if (target) doSelect(target);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
      }
    };

    return (
      <div className="relative" ref={rootRef}>
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 px-2 py-1 text-2xs rounded hover:bg-white/5 transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Paperclip className="h-3 w-3" />
          Add context
          <ChevronUp
            className={`h-3 w-3 transition-transform ${open ? '' : 'rotate-180'}`}
          />
        </button>

        {open && (
          <div
            ref={menuRef}
            tabIndex={-1}
            role="menu"
            onKeyDown={onKeyDown}
            className="absolute bottom-full left-0 mb-1 w-64 rounded-md border shadow-lg overflow-hidden outline-none"
            style={{
              borderColor: 'var(--color-border-subtle)',
              backgroundColor: 'var(--color-elevated)',
            }}
          >
            {primary && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  aria-label={`@Current page: ${primary.label}`}
                  data-testid="context-menu-primary"
                  onClick={() => doSelect(primary)}
                  onMouseEnter={() => setActiveIndex(0)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${
                    activeIndex === 0 ? 'bg-white/10' : 'hover:bg-white/5'
                  }`}
                  style={{
                    color: 'var(--color-text)',
                    backgroundColor:
                      activeIndex === 0
                        ? 'rgba(255,255,255,0.08)'
                        : 'var(--color-surface-raised, transparent)',
                  }}
                >
                  <span className="text-honey-500 font-medium">@Current page</span>
                  <span className="truncate flex-1">{primary.label}</span>
                </button>
                {rest.length > 0 && (
                  <div
                    role="separator"
                    className="border-t"
                    style={{ borderColor: 'var(--color-border-subtle)' }}
                  />
                )}
              </>
            )}
            {rest.map((item, iRest) => {
              const idx = primary ? iRest + 1 : iRest;
              return (
                <button
                  key={`${item.type}-${iRest}`}
                  type="button"
                  role="menuitem"
                  onClick={() => doSelect(item)}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-left transition-colors ${
                    activeIndex === idx ? 'bg-white/10' : 'hover:bg-white/5'
                  }`}
                  style={{ color: 'var(--color-text)' }}
                >
                  <span className="text-honey-500">+</span>
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  },
);
