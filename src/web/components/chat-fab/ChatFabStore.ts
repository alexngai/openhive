/**
 * ChatFab Zustand Store
 *
 * Global state for the floating chat widget. Persists across page
 * navigation since it's mounted at Layout level.
 */

import { create } from 'zustand';
import { api } from '../../lib/api';

export type ChatFabMode = 'floating' | 'docked';

export interface ChatFabState {
  /** FAB expanded or collapsed */
  open: boolean;
  /** Active chat session ID (null = show picker) */
  sessionId: string | null;
  /** Swarm the active session is on */
  swarmId: string | null;
  /** Display name for the active session/swarm */
  sessionLabel: string | null;
  /** Display mode: floating popup or docked sidebar */
  mode: ChatFabMode;

  /** True while connectAndOpen is creating an ACP session */
  connecting: boolean;
  connectError: string | null;

  // Actions
  toggle: () => void;
  collapse: () => void;
  setSession: (sessionId: string, swarmId: string, label: string) => void;
  clearSession: () => void;
  setMode: (mode: ChatFabMode) => void;
  toggleMode: () => void;
  /**
   * Create an ACP session on a swarm and open the chat.
   * Used by SwarmCraft's onStartChat to bridge agent selection → ChatFab.
   */
  connectAndOpen: (swarmId: string, agentId: string, label?: string) => Promise<void>;
}

export const useChatFabStore = create<ChatFabState>((set) => ({
  open: false,
  sessionId: null,
  swarmId: null,
  sessionLabel: null,
  mode: 'floating',
  connecting: false,
  connectError: null,

  toggle: () => set((s) => ({ open: !s.open })),
  collapse: () => set({ open: false }),

  setSession: (sessionId, swarmId, label) =>
    set({ sessionId, swarmId, sessionLabel: label, connectError: null }),

  clearSession: () =>
    set({ sessionId: null, swarmId: null, sessionLabel: null, connectError: null }),

  setMode: (mode) => set({ mode }),
  toggleMode: () => set((s) => ({ mode: s.mode === 'floating' ? 'docked' : 'floating' })),

  connectAndOpen: async (swarmId, agentId, label) => {
    set({ connecting: true, connectError: null, open: true });
    try {
      const result = await api.post<{
        session_resource_id: string;
        acp_session_id: string;
        acp_stream_id: string;
        created: boolean;
      }>('/sessions/acp-connect', {
        swarm_id: swarmId,
        agent_id: agentId,
      });
      set({
        sessionId: result.session_resource_id,
        swarmId,
        sessionLabel: label ?? swarmId,
        connecting: false,
      });
    } catch (err) {
      set({
        connecting: false,
        connectError: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));
