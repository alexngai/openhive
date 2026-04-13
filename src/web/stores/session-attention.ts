import { create } from 'zustand';

interface AttentionItem {
  swarmId: string;
  state: string;
  timestamp: number;
}

interface SessionAttentionState {
  sessions: Map<string, AttentionItem>;

  markNeedsAttention: (sessionId: string, swarmId: string, state: string) => void;
  clearAttention: (sessionId: string) => void;
  clearAll: () => void;
  hasAttention: (sessionId: string) => boolean;
  attentionCount: () => number;
}

export const useSessionAttentionStore = create<SessionAttentionState>((set, get) => ({
  sessions: new Map(),

  markNeedsAttention: (sessionId, swarmId, state) => {
    set((prev) => {
      const sessions = new Map(prev.sessions);
      sessions.set(sessionId, { swarmId, state, timestamp: Date.now() });
      return { sessions };
    });
  },

  clearAttention: (sessionId) => {
    set((prev) => {
      const sessions = new Map(prev.sessions);
      sessions.delete(sessionId);
      return { sessions };
    });
  },

  clearAll: () => {
    set({ sessions: new Map() });
  },

  hasAttention: (sessionId) => {
    return get().sessions.has(sessionId);
  },

  attentionCount: () => {
    return get().sessions.size;
  },
}));
