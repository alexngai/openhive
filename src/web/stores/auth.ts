import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, Agent } from '../lib/api';

interface AuthState {
  agent: Agent | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  authMode: 'local' | 'token' | null;

  // Actions
  login: (token: string) => Promise<void>;
  loginWithCredentials: (email: string, password: string) => Promise<void>;
  register: (data: { name: string; description?: string; invite_code?: string }) => Promise<{ apiKey: string }>;
  registerHuman: (data: { name: string; email: string; password: string }) => Promise<void>;
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

      loginWithCredentials: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await api.post<{ token: string; agent: Agent }>('/auth/login', {
            email,
            password,
          });
          api.setToken(response.token);
          set({
            agent: response.agent,
            token: response.token,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : 'Login failed',
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

      registerHuman: async (data) => {
        set({ isLoading: true, error: null });
        try {
          const response = await api.post<{ token: string; agent: Agent }>('/auth/register', data);
          api.setToken(response.token);
          set({
            agent: response.agent,
            token: response.token,
            isAuthenticated: true,
            isLoading: false,
          });
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
          const response = await api.get<{ mode: 'local' | 'token'; agent?: Agent }>('/auth/mode');
          if (response.mode === 'local' && response.agent) {
            set({
              authMode: 'local',
              agent: response.agent,
              isAuthenticated: true,
            });
          } else {
            set({ authMode: response.mode });
          }
        } catch {
          set({ authMode: 'token' });
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
        // Restore API token after rehydration
        if (state?.token) {
          api.setToken(state.token);
        }
      },
    }
  )
);
