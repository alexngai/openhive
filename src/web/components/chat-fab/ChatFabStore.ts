/**
 * ChatFab Zustand Store
 *
 * Global state for the floating chat widget. Persists across page
 * navigation since it's mounted at Layout level.
 */

import { create } from 'zustand';
import { api } from '../../lib/api';
import { useChatFabStagedChipsStore } from './chat-fab-staged-chips-store';

export type ChatFabMode = 'floating' | 'docked';
export type ChatTransportMode = 'acp' | 'mail' | 'hosted';

/**
 * Which view the ChatFab body is showing. Drives both the body content and
 * the header title / back-button behaviour.
 *
 * - `picker`: agent/session picker (default when no session)
 * - `chat`: active chat session
 */
export type ChatFabView = 'picker' | 'chat';

const MODE_STORAGE_KEY = 'chat-fab-mode';
const OPEN_STORAGE_KEY = 'chat-fab-open';
const CONNECT_TIMEOUT_MS = 25_000;

let activeConnectAbort: AbortController | null = null;
let activeConnectTimeout: ReturnType<typeof setTimeout> | null = null;

function loadMode(): ChatFabMode {
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    return stored === 'docked' || stored === 'floating' ? stored : 'floating';
  } catch {
    return 'floating';
  }
}

function saveMode(mode: ChatFabMode) {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch { /* ignore */ }
}

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, String(open));
  } catch { /* ignore */ }
}

/**
 * Resume descriptor for the active ACP session. Stored alongside the
 * session id so re-mounts of ChatPanel (e.g. when the user toggles
 * between floating and docked mode) can call `loadSession()` on the
 * existing stream instead of creating a fresh one. Without this, every
 * mode switch would tear down the server-side ACP stream and lose the
 * chat history.
 */
export interface ChatFabResume {
  acpStreamId: string;
  acpSessionId: string;
  providerSessionId?: string;
}

/**
 * A lookup hint for the ChatHeader to live-resolve the agent's current name
 * from `GET /map/swarms/:swarmId` rather than holding a stale snapshot.
 * Set at connect time; the header matches against `registered_agents[].id`
 * (or `metadata.peerMapId`, for peer-namespaced ids).
 */
export interface ChatFabAgentRef {
  swarmId: string;
  agentId: string;
}

export interface ChatFabState {
  /** FAB expanded or collapsed */
  open: boolean;
  /** Which panel view is active */
  view: ChatFabView;
  /** Active chat session ID (null = show picker) */
  sessionId: string | null;
  /** Swarm the active session is on */
  swarmId: string | null;
  /**
   * Seeded display name for the active session/swarm. Used as the fallback
   * for the ChatHeader — it prefers a live-resolved name from `agentRef`
   * against the MAP registry so renames / late-arriving registrations
   * update in place.
   */
  sessionLabel: string | null;
  /**
   * Lookup hint so the ChatHeader can live-resolve the agent's current
   * name from the MAP registry instead of relying on a snapshot. See
   * `ChatFabAgentRef`.
   */
  agentRef: ChatFabAgentRef | null;
  /** ACP resume descriptor — set whenever we created/loaded a stream */
  resume: ChatFabResume | null;
  /** Visible transport mode for the active chat surface. */
  transportMode: ChatTransportMode | null;
  /** Display mode: floating popup or docked sidebar */
  mode: ChatFabMode;

  /** True while connectAndOpen is creating an ACP session */
  connecting: boolean;
  connectError: string | null;

  // Actions
  toggle: () => void;
  collapse: () => void;
  /** Navigate to a specific view within the panel. */
  navigate: (view: ChatFabView) => void;
  setSession: (
    sessionId: string,
    swarmId: string,
    label: string,
    resume?: ChatFabResume | null,
    agentRef?: ChatFabAgentRef | null,
    transportMode?: ChatTransportMode | null,
  ) => void;
  clearSession: () => void;
  cancelConnect: () => void;
  setMode: (mode: ChatFabMode) => void;
  toggleMode: () => void;
  /**
   * Create an ACP session on a swarm and open the chat.
   * Used by SwarmCraft's onStartChat to bridge agent selection → ChatFab.
   *
   * `peerMapId` is the raw MAP agent id as registered on the swarm's own
   * MAP server (the value stored in `stateMetadata.agentMetadata.peerMapId`
   * by the swarmcraft bridge). Pass it when `agentId` is OpenHive's
   * projection id (e.g. `oh-node-{swarmId}-{mapAgentId}`) — the hub's
   * registry routes ACP by the raw id and 404s on the projection.
   */
  connectAndOpen: (
    swarmId: string,
    agentId: string,
    label?: string,
    peerMapId?: string,
    cwd?: string,
  ) => Promise<void>;
}

export const useChatFabStore = create<ChatFabState>((set) => ({
  open: loadOpen(),
  view: 'picker',
  sessionId: null,
  swarmId: null,
  sessionLabel: null,
  agentRef: null,
  resume: null,
  transportMode: null,
  mode: loadMode(),
  connecting: false,
  connectError: null,

  toggle: () =>
    set((s) => {
      const next = !s.open;
      saveOpen(next);
      return { open: next };
    }),
  collapse: () => {
    saveOpen(false);
    set({ open: false });
  },

  navigate: (view) => set({ view }),

  setSession: (sessionId, swarmId, label, resume, agentRef, transportMode) => {
    // Session swap clears staged chips — composition state belongs to the
    // active composer, not to a history. Avoids "agent A's context bled
    // into agent B" when switching sessions. Only clears on actual id
    // changes so noop re-sets (same id + updated label) don't wipe drafts.
    set((s) => {
      if (s.sessionId && s.sessionId !== sessionId) {
        useChatFabStagedChipsStore.getState().clearChips();
      }
      return {
        sessionId,
        swarmId,
        sessionLabel: label,
        agentRef: agentRef ?? null,
        resume: resume ?? null,
        transportMode: transportMode ?? (resume ? 'acp' : 'mail'),
        connectError: null,
        view: 'chat',
      };
    });
  },

  clearSession: () => {
    useChatFabStagedChipsStore.getState().clearChips();
    set({
      sessionId: null,
      swarmId: null,
      sessionLabel: null,
      agentRef: null,
      resume: null,
      transportMode: null,
      connectError: null,
      view: 'picker',
    });
  },

  cancelConnect: () => {
    activeConnectAbort?.abort();
    if (activeConnectTimeout) {
      clearTimeout(activeConnectTimeout);
      activeConnectTimeout = null;
    }
    activeConnectAbort = null;
    set((s) => ({
      connecting: false,
      connectError: null,
      view: s.sessionId ? 'chat' : 'picker',
    }));
  },

  setMode: (mode) => {
    saveMode(mode);
    set({ mode });
  },
  toggleMode: () =>
    set((s) => {
      const next: ChatFabMode = s.mode === 'floating' ? 'docked' : 'floating';
      saveMode(next);
      return { mode: next };
    }),

  connectAndOpen: async (swarmId, agentId, label, peerMapId, cwd) => {
    activeConnectAbort?.abort();
    if (activeConnectTimeout) clearTimeout(activeConnectTimeout);
    const controller = new AbortController();
    activeConnectAbort = controller;
    activeConnectTimeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

    saveOpen(true);
    set({
      connecting: true,
      connectError: null,
      open: true,
      view: 'chat',
      sessionLabel: label ?? 'Agent',
      transportMode: 'acp',
    });
    try {
      const result = await api.post<{
        session_resource_id: string;
        acp_session_id: string;
        acp_stream_id: string;
        created: boolean;
      }>(
        '/sessions/acp-connect',
        {
          swarm_id: swarmId,
          agent_id: agentId,
          ...(peerMapId ? { peer_map_id: peerMapId } : {}),
          ...(cwd ? { cwd } : {}),
        },
        { signal: controller.signal },
      );

      // Seed sessionLabel with the best label we have *right now* —
      // `label` (passed from SessionPicker's spawn response), else 'Agent'
      // — but also stash `agentRef` so the ChatHeader can live-resolve
      // the name from the MAP registry as it arrives. This fixes the
      // race where the agent is spawned and connected to faster than the
      // hub publishes its registration back through `registered_agents`.
      set((s) => {
        if (s.sessionId && s.sessionId !== result.session_resource_id) {
          useChatFabStagedChipsStore.getState().clearChips();
        }
        return {
          sessionId: result.session_resource_id,
          swarmId,
          sessionLabel: label ?? 'Agent',
          agentRef: { swarmId, agentId },
          resume: {
            acpStreamId: result.acp_stream_id,
            acpSessionId: result.acp_session_id,
          },
          transportMode: 'acp',
          connecting: false,
        };
      });
    } catch (err) {
      if (activeConnectAbort !== controller && controller.signal.aborted) return;
      set({
        connecting: false,
        connectError: controller.signal.aborted
          ? 'Connection timed out or was cancelled.'
          : err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (activeConnectAbort === controller) {
        activeConnectAbort = null;
        if (activeConnectTimeout) {
          clearTimeout(activeConnectTimeout);
          activeConnectTimeout = null;
        }
      }
    }
  },
}));
