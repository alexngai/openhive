/**
 * ChatFab — Floating Action Button / Docked Sidebar for agent chat
 *
 * Two modes:
 * - `floating`: popup panel anchored bottom-right (default)
 * - `docked`: fixed sidebar on the right edge of the layout
 *
 * Close always collapses back to the FAB button.
 */

import { Bot, X, PanelRightOpen, PanelRightClose } from 'lucide-react';
import clsx from 'clsx';
import { useChatFabStore } from './ChatFabStore';
import { SessionPicker } from './SessionPicker';
import { ChatPanel } from './ChatPanel';

function ChatHeader({ isDocked }: { isDocked: boolean }) {
  const { sessionId, sessionLabel, clearSession, collapse, toggleMode } = useChatFabStore();

  return (
    <div
      className="flex items-center justify-between px-3 py-2 border-b shrink-0"
      style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-elevated)' }}
    >
      <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--color-text)' }}>
        <Bot className="h-4 w-4 text-honey-500" />
        <span className="font-medium truncate">
          {sessionId ? (sessionLabel ?? 'Agent') : 'Agent Chat'}
        </span>
      </div>
      <div className="flex items-center gap-1">
        {sessionId && (
          <button
            type="button"
            onClick={clearSession}
            className="px-2 py-0.5 rounded text-2xs hover:bg-white/10"
            style={{ color: 'var(--color-text-muted)' }}
            title="Switch session"
          >
            Switch
          </button>
        )}
        <button
          type="button"
          onClick={toggleMode}
          className="p-1 rounded hover:bg-white/10"
          style={{ color: 'var(--color-text-muted)' }}
          title={isDocked ? 'Undock to floating' : 'Dock as sidebar'}
        >
          {isDocked ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={collapse}
          className="p-1 rounded hover:bg-white/10"
          style={{ color: 'var(--color-text-muted)' }}
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function ChatBody() {
  const sessionId = useChatFabStore((s) => s.sessionId);
  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      {sessionId ? <ChatPanel /> : <SessionPicker />}
    </div>
  );
}

/**
 * Docked sidebar — rendered inside the Layout flex container.
 */
export function ChatSidebar() {
  const { open, mode } = useChatFabStore();
  if (!open || mode !== 'docked') return null;

  return (
    <aside
      className="w-96 shrink-0 border-l flex flex-col h-full"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-bg)',
      }}
    >
      <ChatHeader isDocked />
      <ChatBody />
    </aside>
  );
}

/**
 * Main ChatFab — FAB button when closed, floating panel when open in floating mode.
 * In docked mode, ChatSidebar (rendered by Layout) handles the panel.
 */
export function ChatFab() {
  const { open, mode, toggle } = useChatFabStore();

  // Collapsed — show FAB button
  if (!open) {
    return (
      <button
        type="button"
        onClick={toggle}
        className={clsx(
          'fixed bottom-6 right-6 z-50',
          'w-13 h-13 rounded-full',
          'flex items-center justify-center',
          'border border-white/10',
          'cursor-pointer transition-all hover:scale-105 active:scale-95',
        )}
        style={{
          backgroundColor: 'var(--color-elevated)',
          color: 'var(--color-text-secondary)',
          boxShadow: '0 4px 14px rgba(0,0,0,0.35), 0 1px 3px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06)',
        }}
        title="Open agent chat"
      >
        <Bot className="h-5 w-5" />
      </button>
    );
  }

  // Docked — sidebar rendered by Layout
  if (mode === 'docked') return null;

  // Floating panel
  return (
    <div
      className={clsx(
        'fixed z-50 shadow-xl border rounded-lg overflow-hidden flex flex-col',
        'bottom-4 right-4 left-4 top-16',
        'sm:left-auto sm:top-auto sm:bottom-6 sm:right-6 sm:w-96 sm:h-[32rem]',
      )}
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'var(--color-bg)',
      }}
    >
      <ChatHeader isDocked={false} />
      <ChatBody />
    </div>
  );
}
