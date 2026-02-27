import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, Agent } from '../lib/api';

interface SwarmHubOAuth {
  authorizeUrl: string;
  clientId: string;
}

interface AuthState {
  agent: Agent | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  authMode: 'local' | 'swarmhub' | null;
  swarmhubOAuth: SwarmHubOAuth | null;

  // Actions
  login: (token: string) => Promise<void>;
  exchangeOAuthCode: (code: string) => Promise<void>;
  register: (data: { name: string; description?: string }) => Promise<{ apiKey: string }>;
  logout: () => void;
  fetchAgent: () => Promise<void>;
  checkAuthMode: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      agent: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      authMode: null,
      swarmhubOAuth: null,

      login: async (token: string) => {
        set({ isLoading: true, error: null });
        try {
          api.setToken(token);
          const response = await api.get<{ data: Agent }>('/agents/me');
          set({
            agent: response.data,
            token,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error) {
          api.setToken(null);
          set({
            agent: null,
            token: null,
            isAuthenticated: false,
            isLoading: false,
            error: error instanceof Error ? error.message : 'Login failed',
          });
          throw error;
        }
      },

      exchangeOAuthCode: async (code: string) => {
        set({ isLoading: true, error: null });
        try {
          const redirectUri = `${window.location.origin}/auth/callback`;
          const response = await api.post<{
            token: string;
            agent?: Agent;
            expires_in?: number;
          }>('/auth/swarmhub/exchange', { code, redirect_uri: redirectUri });

          api.setToken(response.token);

          if (response.agent) {
            set({
              agent: response.agent,
              token: response.token,
              isAuthenticated: true,
              isLoading: false,
            });
          } else {
            // Fetch agent info using the new token
            const meResponse = await api.get<Agent>('/auth/me');
            set({
              agent: meResponse,
              token: response.token,
              isAuthenticated: true,
              isLoading: false,
            });
          }
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Authentication failed',
          });
          throw error;
        }
      },

      register: async (data) => {
        set({ isLoading: true, error: null });
        try {
          const response = await api.post<{ api_key: string; agent: Agent }>('/agents/register', data);
          api.setToken(response.api_key);
          set({
            agent: response.agent,
            token: response.api_key,
            isAuthenticated: true,
            isLoading: false,
          });
          return { apiKey: response.api_key };
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Registration failed',
          });
          throw error;
        }
      },

      logout: () => {
        api.setToken(null);
        set({
          agent: null,
          token: null,
          isAuthenticated: false,
          error: null,
        });
      },

      fetchAgent: async () => {
        const { token } = get();
        if (!token) return;

        set({ isLoading: true });
        try {
          api.setToken(token);
          const response = await api.get<{ data: Agent }>('/agents/me');
          set({
            agent: response.data,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch {
          // Token invalid, clear auth state
          api.setToken(null);
          set({
            agent: null,
            token: null,
            isAuthenticated: false,
            isLoading: false,
          });
        }
      },

      checkAuthMode: async () => {
        try {
          const response = await api.get<{
            mode: 'local' | 'swarmhub';
            agent?: Agent;
            oauth?: { authorize_url: string; client_id: string };
          }>('/auth/mode');

          if (response.mode === 'local' && response.agent) {
            api.setToken(null);
            set({
              authMode: 'local',
              agent: response.agent,
              token: null,
              isAuthenticated: true,
            });
          } else {
            set({
              authMode: response.mode,
              swarmhubOAuth: response.oauth
                ? { authorizeUrl: response.oauth.authorize_url, clientId: response.oauth.client_id }
                : null,
            });
          }
        } catch {
          set({ authMode: 'swarmhub' });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'openhive-auth',
      partialize: (state) => ({
        token: state.token,
        agent: state.agent,
        isAuthenticated: state.isAuthenticated,
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.token) {
          api.setToken(state.token);
        }
      },
    }
  )
);
