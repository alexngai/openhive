/**
 * ChatFab — Floating Action Button / Docked Sidebar for agent chat
 *
 * Two modes:
 * - `floating`: popup panel anchored bottom-right (default)
 * - `docked`: fixed sidebar on the right edge of the layout
 *
 * Close always collapses back to the FAB button.
 */

import { Bot, X, PanelRightOpen, PanelRightClose, Loader2, AlertCircle, ChevronLeft } from 'lucide-react';
import clsx from 'clsx';
import { useLocation } from 'react-router-dom';
import { useChatFabStore, type ChatFabAgentRef } from './ChatFabStore';
import { SessionPicker } from './SessionPicker';
import { ChatPanel } from './ChatPanel';
import { useMapSwarm } from '../../hooks/useApi';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useSubscribe, useWSEvent } from '../../hooks/useWebSocket';
import { AgentAvatar } from '../common/AgentAvatar';

/**
 * Suppress the FAB whenever the user is on a Threads page — Threads *is*
 * the chat surface, so the FAB would duplicate it. Matches any path under
 * `/threads` (list, session detail, mail detail) and the legacy `/sessions`
 * that redirects there.
 */
function useFabSuppressedOnMatchingRoute(): boolean {
  const { pathname } = useLocation();
  return pathname === '/threads'
    || pathname.startsWith('/threads/')
    || pathname === '/sessions'
    || pathname.startsWith('/sessions/');
}

/**
 * Keep the single-swarm query fresh while an agent-scoped chat is open.
 * The ChatFab is mounted at Layout level, so pages that don't otherwise
 * run `useSwarmRealtime` (Dashboard, Home, settings, etc.) would stall
 * on the initial `registered_agents` snapshot — missing the agent name
 * for a freshly-spawned coordinator until the 30s staleTime elapses or
 * the user navigates to a page that does invalidate. Subscribing here
 * bridges that gap: map:discovery events nudge `['map-swarm', id]` to
 * refetch as soon as the hub publishes the registration.
 */
function useLiveSwarmRefresh(swarmId: string | null) {
  const qc = useQueryClient();
  useSubscribe(swarmId ? ['map:discovery'] : []);
  const invalidate = useCallback(() => {
    if (!swarmId) return;
    qc.invalidateQueries({ queryKey: ['map-swarm', swarmId] });
  }, [qc, swarmId]);
  useWSEvent('node_registered', invalidate);
  useWSEvent('swarm.status_changed', invalidate);
  useWSEvent('swarm_spawned', invalidate);
  useWSEvent('swarm_registered', invalidate);
}

/**
 * MAP agent state colours. Mirrors swarmcraft's AGENT_STATE_COLORS so the
 * dot on the chat header matches the dot on the AgentPortrait grid.
 */
const STATE_COLORS: Record<string, string> = {
  registered: '#9ca3af',
  active: '#22c55e',
  busy: '#3b82f6',
  idle: '#6b7280',
  suspended: '#f59e0b',
  stopping: '#f97316',
  stopped: '#9ca3af',
  failed: '#ef4444',
  orphaned: '#f97316',
};

interface LiveAgentInfo {
  /** Agent's current display name from the MAP registry. */
  name: string | null;
  /** Current MAP state (e.g. 'idle', 'active', 'busy'). */
  state: string | null;
  /** Agent role (e.g. 'coordinator', 'worker'). */
  role: string | null;
  /** Parent swarm's display name — shown as a subtle byline so users
   *  know which swarm/conversation they're in. */
  swarmName: string | null;
  /** Swarm reachability — derives the small status dot on the avatar. */
  swarmStatus: string | null;
}

/**
 * Resolve the agent's current display name + state from the live MAP
 * registry. Returns nulls for fields that haven't resolved yet — callers
 * fall back to `sessionLabel` seeded at connect time. Matches against both
 * the hub agent id and `metadata.peerMapId`, since callers stash either.
 */
function useLiveAgent(agentRef: ChatFabAgentRef | null): LiveAgentInfo {
  const { data: swarm } = useMapSwarm(agentRef?.swarmId ?? '');
  if (!agentRef || !swarm) {
    return { name: null, state: null, role: null, swarmName: null, swarmStatus: null };
  }
  const agents = (swarm as { registered_agents?: Array<{
    id: string;
    name?: string;
    role?: string;
    state?: string;
    metadata?: Record<string, unknown> | null;
  }> }).registered_agents ?? [];
  const match = agents.find((a) => {
    if (a.id === agentRef.agentId) return true;
    const peerId = (a.metadata as { peerMapId?: string } | null | undefined)?.peerMapId;
    return peerId === agentRef.agentId;
  });
  return {
    name: match?.name ?? null,
    state: match?.state ?? null,
    role: match?.role ?? null,
    swarmName: (swarm as { name?: string }).name ?? null,
    swarmStatus: (swarm as { status?: string }).status ?? null,
  };
}

function ChatHeader({ isDocked }: { isDocked: boolean }) {
  const { view, sessionId, sessionLabel, agentRef, clearSession, collapse, toggleMode } = useChatFabStore();
  useLiveSwarmRefresh(agentRef?.swarmId ?? null);
  const live = useLiveAgent(agentRef);
  const headerName = live.name ?? sessionLabel ?? 'Agent';
  const swarmReachable = live.swarmStatus === 'online' || live.swarmStatus === null;
  const stateColor = !swarmReachable
    ? '#6b7280'
    : (live.state ? STATE_COLORS[live.state] ?? STATE_COLORS.registered : STATE_COLORS.registered);
  const isWorking = swarmReachable && (live.state === 'active' || live.state === 'busy');

  // View-specific header titles and subtitles
  const viewMeta: Record<string, { title: string; subtitle?: string }> = {
    picker: { title: 'Agent Chat', subtitle: 'Pick an agent to chat with' },
  };
  const currentMeta = viewMeta[view];

  // Whether this view has a back button to the picker
  const hasBack = view === 'chat' && !!sessionId;

  return (
    <div
      className="flex items-center justify-between px-3 py-2 border-b shrink-0"
      style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-elevated)' }}
    >
      <div className="flex items-center gap-2 text-sm min-w-0" style={{ color: 'var(--color-text)' }}>
        {hasBack && (
          <button
            type="button"
            onClick={clearSession}
            className="p-0.5 -ml-0.5 rounded hover:bg-white/10 shrink-0"
            style={{ color: 'var(--color-text-muted)' }}
            title="Back"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        {view === 'chat' && sessionId ? (
          <div className="relative shrink-0">
            <AgentAvatar
              name={headerName}
              size={26}
              borderColor={stateColor}
            />
            <span
              className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ${isWorking ? 'animate-pulse' : ''}`}
              style={{
                backgroundColor: stateColor,
                boxShadow: '0 0 0 1.5px var(--color-elevated)',
              }}
              title={live.state ?? 'unknown state'}
            />
          </div>
        ) : (
          <Bot className="h-4 w-4 text-honey-500" />
        )}
        <div className="flex flex-col min-w-0">
          <span className="font-medium truncate leading-tight">
            {view === 'chat' && sessionId ? headerName : (currentMeta?.title ?? 'Agent Chat')}
          </span>
          {view === 'chat' && sessionId && (live.role || live.swarmName) ? (
            <span
              className="text-2xs truncate leading-tight"
              style={{ color: 'var(--color-text-muted)' }}
              title={live.swarmName ?? undefined}
            >
              {live.role ? <span className="capitalize">{live.role}</span> : null}
              {live.role && live.swarmName ? <span> · </span> : null}
              {live.swarmName}
            </span>
          ) : currentMeta?.subtitle ? (
            <span
              className="text-2xs truncate leading-tight"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {currentMeta.subtitle}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
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
  const view = useChatFabStore((s) => s.view);
  const sessionId = useChatFabStore((s) => s.sessionId);
  const connecting = useChatFabStore((s) => s.connecting);
  const connectError = useChatFabStore((s) => s.connectError);
  const sessionLabel = useChatFabStore((s) => s.sessionLabel);
  const clearError = useChatFabStore((s) => s.clearSession);

  // Mid-flight connect (no session yet) — show a clean spinner so the user
  // sees we acted on their click. Without this the picker re-appears for a
  // beat which is jarring.
  if (view === 'chat' && !sessionId && connecting) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-xs"
        style={{ color: 'var(--color-text-muted)' }}>
        <Loader2 className="h-5 w-5 animate-spin" style={{ color: 'var(--color-accent)' }} />
        <span>Connecting{sessionLabel ? ` to ${sessionLabel}` : ''}…</span>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
      {/* Failed connect surface */}
      {!sessionId && connectError && (
        <div className="px-3 py-2 border-b flex items-start gap-2 text-xs"
          style={{
            borderColor: 'var(--color-border-subtle)',
            backgroundColor: 'rgb(239 68 68 / 0.1)',
            color: 'rgb(248 113 113)',
          }}>
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">Couldn't open chat</div>
            <div className="opacity-80 break-words">{connectError}</div>
          </div>
          <button
            type="button"
            onClick={clearError}
            className="opacity-60 hover:opacity-100 shrink-0"
            title="Dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {view === 'chat' && sessionId ? <ChatPanel /> : <SessionPicker />}
    </div>
  );
}

/**
 * Docked sidebar — rendered inside the Layout flex container.
 */
export function ChatSidebar() {
  const { open, mode } = useChatFabStore();
  const suppressed = useFabSuppressedOnMatchingRoute();
  if (!open || mode !== 'docked' || suppressed) return null;

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
  const suppressed = useFabSuppressedOnMatchingRoute();

  // Suppress entirely on the Threads surface — that page is the canonical
  // chat view, so a FAB would duplicate it. Re-appears on navigation away.
  if (suppressed) return null;

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
