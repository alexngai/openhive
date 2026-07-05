/**
 * Multi-hub connection store (Approach A2 of docs/design/remote-control.md).
 *
 * Holds the user's saved hub connections and which one is active. The A1
 * `lib/hub.ts` module is still the low-level source of truth for the *active*
 * origin + token (everything — REST, WS, ACP — reads from it); this store adds
 * the saved list, labels, and the switch action on top.
 *
 * Relationship to the single-session auth store (stores/auth.ts):
 *   - The auth store remains "the current session" the whole app gates on
 *     (isAuthenticated / agent / authMode).
 *   - This store owns per-connection credentials and, on switch, *drives* the
 *     auth store to reflect the new hub (cached identity, no network) plus
 *     re-points `lib/hub.ts`.
 *   - `syncActiveFromAuth` mirrors live auth changes (login/logout on the
 *     active hub) back into the active connection so the credential is
 *     remembered. Only the *active* connection is touched, so switching to a
 *     remote hub never overwrites the same-origin one.
 *
 * Token-at-rest is plaintext localStorage — same posture as the pre-existing
 * `openhive-auth` token; A4 upgrades to Electron safeStorage / mobile keychain.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Agent } from '../lib/api';
import {
  getActiveOrigin,
  normalizeOrigin,
  setActiveOrigin,
  setActiveToken,
} from '../lib/hub';
import { useAuthStore } from './auth';

export type HubAuthMode = 'local' | 'swarmhub' | null;

export interface HubConnection {
  id: string;
  /** User-facing name; defaults to the instance name or host. */
  label: string;
  /** '' = same-origin (this hub); otherwise a full origin like `https://mini:7836`. */
  origin: string;
  token: string | null;
  /** Cached identity for an instant switch + display; refreshed on (re)auth. */
  agent: Agent | null;
  authMode: HubAuthMode;
  /** Instance name from `/.well-known/openhive.json`, best-effort. */
  instanceName?: string;
  addedAt: number;
  lastUsedAt: number | null;
}

interface AuthView {
  token: string | null;
  agent: Agent | null;
  authMode: HubAuthMode;
}

interface HubsState {
  connections: HubConnection[];
  activeHubId: string | null;

  /** Guarantee a same-origin "this hub" connection and reconcile `activeHubId`
   *  to whatever `lib/hub.ts` is actually pointed at (source of truth on boot). */
  ensureSeed: (current: AuthView) => void;
  /** Validate a credential against a remote hub, then save it. Throws on failure. */
  addConnection: (input: {
    label?: string;
    origin: string;
    token: string | null;
  }) => Promise<HubConnection>;
  removeConnection: (id: string) => void;
  renameConnection: (id: string, label: string) => void;
  /** Point the client at a saved hub (optimistic; drives hub.ts + auth view). */
  switchTo: (id: string) => void;
  /** Mirror live auth-store changes into the *active* connection. */
  syncActiveFromAuth: (view: AuthView) => void;
}

function hostLabel(origin: string): string {
  if (!origin) return 'This hub';
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** Drive the single-session auth store to reflect a connection (no network). */
function applyAuthView(view: AuthView): void {
  useAuthStore.setState({
    token: view.token,
    agent: view.agent,
    authMode: view.authMode,
    isAuthenticated: view.authMode === 'local' ? true : !!view.token,
    isLoading: false,
    error: null,
  });
}

export const useHubsStore = create<HubsState>()(
  persist(
    (set, get) => ({
      connections: [],
      activeHubId: null,

      ensureSeed: (current) => {
        const origin = getActiveOrigin();
        set((state) => {
          let connections = state.connections;
          let sameOrigin = connections.find((c) => c.origin === '');
          if (!sameOrigin) {
            // Cached auth is meaningful only if we're actually on same-origin
            // right now (on a remote hub, the live session belongs to it).
            const onSameOrigin = origin === '';
            const conn: HubConnection = {
              id: crypto.randomUUID(),
              label: 'This hub',
              origin: '',
              token: onSameOrigin ? current.token : null,
              agent: onSameOrigin ? current.agent : null,
              authMode: onSameOrigin ? current.authMode : null,
              addedAt: Date.now(),
              lastUsedAt: onSameOrigin ? Date.now() : null,
            };
            connections = [conn, ...connections];
            sameOrigin = conn;
          }
          const activeByOrigin = connections.find((c) => c.origin === origin);
          return { connections, activeHubId: activeByOrigin?.id ?? sameOrigin.id };
        });
      },

      addConnection: async ({ label, origin, token }) => {
        const o = normalizeOrigin(origin);
        if (!o) throw new Error('Enter a full hub URL, e.g. https://mini:7836');
        try {
          new URL(o);
        } catch {
          throw new Error(`Invalid hub URL: ${origin}`);
        }
        if (get().connections.some((c) => c.origin === o)) {
          throw new Error('A connection to that hub already exists.');
        }

        const authHeaders: Record<string, string> = token
          ? { Authorization: `Bearer ${token}` }
          : {};
        // `/agents/me` is the authoritative "this credential works here" check —
        // in local mode it returns the auto-auth agent even without a token.
        const meRes = await fetch(`${o}/api/v1/agents/me`, { headers: authHeaders });
        if (!meRes.ok) {
          throw new Error(
            meRes.status === 401 || meRes.status === 403
              ? 'Authentication failed — check the API key.'
              : `Could not reach the hub (HTTP ${meRes.status}).`,
          );
        }
        const meBody = (await meRes.json().catch(() => ({}))) as { data?: Agent } & Partial<Agent>;
        const agent = (meBody.data ?? (meBody as Agent)) ?? null;

        // Best-effort auth mode + instance name (non-fatal decoration).
        let authMode: HubAuthMode = null;
        try {
          const mode = await fetch(`${o}/api/v1/auth/mode`, { headers: authHeaders }).then((r) =>
            r.ok ? (r.json() as Promise<{ mode?: string }>) : null,
          );
          if (mode?.mode === 'local' || mode?.mode === 'swarmhub') authMode = mode.mode;
        } catch {
          /* ignore */
        }
        let instanceName: string | undefined;
        try {
          const wk = await fetch(`${o}/.well-known/openhive.json`).then((r) =>
            r.ok ? (r.json() as Promise<{ name?: string }>) : null,
          );
          instanceName = wk?.name;
        } catch {
          /* ignore */
        }

        const conn: HubConnection = {
          id: crypto.randomUUID(),
          label: label?.trim() || instanceName || hostLabel(o),
          origin: o,
          token,
          agent,
          authMode,
          instanceName,
          addedAt: Date.now(),
          lastUsedAt: null,
        };
        set((state) => ({ connections: [...state.connections, conn] }));
        return conn;
      },

      removeConnection: (id) => {
        const state = get();
        const conn = state.connections.find((c) => c.id === id);
        if (!conn || conn.origin === '') return; // never remove "this hub"
        const remaining = state.connections.filter((c) => c.id !== id);
        set({ connections: remaining });
        if (state.activeHubId === id) {
          const fallback = remaining.find((c) => c.origin === '') ?? remaining[0];
          if (fallback) get().switchTo(fallback.id);
        }
      },

      renameConnection: (id, label) => {
        const trimmed = label.trim();
        if (!trimmed) return;
        set((state) => ({
          connections: state.connections.map((c) =>
            c.id === id ? { ...c, label: trimmed } : c,
          ),
        }));
      },

      switchTo: (id) => {
        const conn = get().connections.find((c) => c.id === id);
        if (!conn) return;
        setActiveOrigin(conn.origin);
        setActiveToken(conn.token);
        applyAuthView({ token: conn.token, agent: conn.agent, authMode: conn.authMode });
        set((state) => ({
          activeHubId: id,
          connections: state.connections.map((c) =>
            c.id === id ? { ...c, lastUsedAt: Date.now() } : c,
          ),
        }));
      },

      syncActiveFromAuth: (view) => {
        const { activeHubId, connections } = get();
        if (!activeHubId) return;
        const active = connections.find((c) => c.id === activeHubId);
        if (!active) return;
        // Compare by agent id (object identity churns on every fetch).
        if (
          active.token === view.token &&
          (active.agent?.id ?? null) === (view.agent?.id ?? null) &&
          active.authMode === view.authMode
        ) {
          return;
        }
        set({
          connections: connections.map((c) =>
            c.id === activeHubId
              ? { ...c, token: view.token, agent: view.agent, authMode: view.authMode }
              : c,
          ),
        });
      },
    }),
    {
      name: 'openhive-hubs',
      partialize: (state) => ({
        connections: state.connections,
        activeHubId: state.activeHubId,
      }),
    },
  ),
);
