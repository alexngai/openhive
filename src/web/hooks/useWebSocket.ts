import { useEffect, useRef, useCallback, useState } from 'react';
import { create } from 'zustand';
import { useAuthStore } from '../stores/auth';

interface WSMessage {
  type: string;
  channel?: string;
  data?: unknown;
}

interface WSState {
  isConnected: boolean;
  channels: Set<string>;
  /** Reference counts for channel subscriptions (multiple hooks can subscribe to same channel) */
  channelRefs: Map<string, number>;
  listeners: Map<string, Set<(data: unknown) => void>>;
  setConnected: (connected: boolean) => void;
  addChannel: (channel: string) => void;
  removeChannel: (channel: string) => void;
  addListener: (event: string, callback: (data: unknown) => void) => void;
  removeListener: (event: string, callback: (data: unknown) => void) => void;
  emit: (event: string, data: unknown) => void;
}

export const useWSStore = create<WSState>((set, get) => ({
  isConnected: false,
  channels: new Set(),
  channelRefs: new Map(),
  listeners: new Map(),

  setConnected: (connected) => set({ isConnected: connected }),

  addChannel: (channel) =>
    set((state) => {
      const refs = new Map(state.channelRefs);
      refs.set(channel, (refs.get(channel) ?? 0) + 1);
      return { channels: new Set([...state.channels, channel]), channelRefs: refs };
    }),

  removeChannel: (channel) =>
    set((state) => {
      const refs = new Map(state.channelRefs);
      const count = (refs.get(channel) ?? 1) - 1;
      if (count > 0) {
        // Other subscribers still active — keep channel, update refcount
        refs.set(channel, count);
        return { channelRefs: refs };
      }
      // Last subscriber — actually remove channel
      refs.delete(channel);
      const channels = new Set(state.channels);
      channels.delete(channel);
      return { channels, channelRefs: refs };
    }),

  addListener: (event, callback) => {
    const { listeners } = get();
    const eventListeners = listeners.get(event) || new Set();
    eventListeners.add(callback);
    listeners.set(event, eventListeners);
    set({ listeners: new Map(listeners) });
  },

  removeListener: (event, callback) => {
    const { listeners } = get();
    const eventListeners = listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(callback);
      if (eventListeners.size === 0) {
        listeners.delete(event);
      }
      set({ listeners: new Map(listeners) });
    }
  },

  emit: (event, data) => {
    const { listeners } = get();
    const eventListeners = listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach((callback) => callback(data));
    }
  },
}));

let globalWs: WebSocket | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 1000;

/**
 * Vite HMR cleanup. Without this, hot-reloading this module leaves the live
 * WebSocket alive with its `onmessage` handler bound to the old module's
 * `emit` closure — but the old module's store instance has no listeners
 * (children re-register on the NEW module's store). Result: broadcasts
 * silently vanish into a dead store and the UI stops receiving WS events
 * until a full page reload. Disposing on module swap forces a clean
 * reconnect bound to the fresh module's `emit`/store pair.
 *
 * Only fires in dev — `import.meta.hot` is stripped from production builds.
 */
if (typeof import.meta !== 'undefined' && import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (globalWs) {
      try { globalWs.close(); } catch { /* ignore */ }
      globalWs = null;
    }
    reconnectAttempts = 0;
  });
}

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const { token } = useAuthStore();
  // Select `setConnected` directly — selecting the whole store (as this hook
  // originally did) causes a re-render on EVERY field change (listeners map,
  // channels set, refcounts) and churned the `connect` useCallback identity,
  // which in turn re-ran the connect effect and caused a cascade of
  // duplicate subscribe messages at boot.
  const setConnected = useWSStore((s) => s.setConnected);

  const connect = useCallback(() => {
    if (globalWs?.readyState === WebSocket.OPEN || globalWs?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = token
      ? `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`
      : `${protocol}//${host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      globalWs = ws;
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WS] Connected');
        setConnected(true);
        reconnectAttempts = 0;

        // Resubscribe to channels. Read from live store state rather than
        // a captured closure — channels may have been added AFTER connect()
        // was called (children mount + subscribe during boot).
        const { channels } = useWSStore.getState();
        if (channels.size > 0) {
          ws.send(JSON.stringify({
            type: 'subscribe',
            channels: Array.from(channels),
          }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data);

          // Handle different message types
          switch (message.type) {
            case 'subscribed':
              console.log('[WS] Subscribed to channels:', message.data);
              break;
            case 'error':
              console.error('[WS] Error:', message.data);
              break;
            case 'pong':
              // Heartbeat response
              break;
            default:
              // Emit the event to listeners via a FRESH getState() call.
              // Previously this closed over a destructured `emit` from the
              // enclosing hook render, which meant after an HMR swap the
              // handler still dispatched into the OLD module's store —
              // and the new module's children had registered their
              // listeners on a different store instance. All broadcast
              // events silently dropped until a full page reload.
              useWSStore.getState().emit(message.type, message);
              break;
          }
        } catch (error) {
          console.error('[WS] Failed to parse message:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('[WS] Error:', error);
      };

      ws.onclose = (event) => {
        console.log('[WS] Disconnected:', event.code, event.reason);
        setConnected(false);
        // Only clear globalWs if THIS socket is still the active one. An
        // HMR dispose may have already replaced it; clobbering the new one
        // to null would break the fresh connect's bookkeeping.
        if (globalWs === ws) {
          globalWs = null;
          wsRef.current = null;
        }

        // Attempt to reconnect
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = RECONNECT_DELAY * Math.pow(2, reconnectAttempts);
          reconnectAttempts++;
          console.log(`[WS] Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
          reconnectTimeout = setTimeout(connect, delay);
        }
      };
    } catch (error) {
      console.error('[WS] Failed to connect:', error);
    }
  }, [token, setConnected]);

  const disconnect = useCallback(() => {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (globalWs) {
      globalWs.close();
      globalWs = null;
    }
    setConnected(false);
  }, [setConnected]);

  useEffect(() => {
    connect();
    return () => {
      // Don't disconnect on unmount, keep connection alive
    };
  }, [connect]);

  return {
    isConnected: useWSStore((state) => state.isConnected),
    disconnect,
    reconnect: connect,
  };
}

export function useSubscribe(channels: string[]) {
  const addChannel = useWSStore((s) => s.addChannel);
  const removeChannel = useWSStore((s) => s.removeChannel);

  useEffect(() => {
    // Add channels to store
    channels.forEach((channel) => addChannel(channel));

    // Subscribe via WebSocket
    if (globalWs?.readyState === WebSocket.OPEN) {
      globalWs.send(JSON.stringify({
        type: 'subscribe',
        channels,
      }));
    }

    return () => {
      // Remove channels from store (ref-counted)
      channels.forEach((channel) => removeChannel(channel));

      // Only send unsubscribe for channels that were actually removed (refcount hit 0)
      const { channelRefs } = useWSStore.getState();
      const toUnsub = channels.filter((ch) => !channelRefs.has(ch));
      if (toUnsub.length > 0 && globalWs?.readyState === WebSocket.OPEN) {
        globalWs.send(JSON.stringify({
          type: 'unsubscribe',
          channels: toUnsub,
        }));
      }
    };
  }, [channels.join(','), addChannel, removeChannel]);
}

export function useWSEvent<T = unknown>(event: string, callback: (data: T) => void) {
  const addListener = useWSStore((s) => s.addListener);
  const removeListener = useWSStore((s) => s.removeListener);
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    const handler = (data: unknown) => cbRef.current(data as T);
    addListener(event, handler);
    return () => removeListener(event, handler);
  }, [event, addListener, removeListener]);
}
