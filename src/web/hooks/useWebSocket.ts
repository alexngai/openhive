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
  listeners: new Map(),

  setConnected: (connected) => set({ isConnected: connected }),

  addChannel: (channel) =>
    set((state) => ({
      channels: new Set([...state.channels, channel]),
    })),

  removeChannel: (channel) =>
    set((state) => {
      const channels = new Set(state.channels);
      channels.delete(channel);
      return { channels };
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

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const { token, isAuthenticated } = useAuthStore();
  const { setConnected, channels, emit } = useWSStore();

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

        // Resubscribe to channels
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
              // Emit the event to listeners
              emit(message.type, message);
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
        globalWs = null;
        wsRef.current = null;

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
  }, [token, channels, setConnected, emit]);

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
  const { addChannel, removeChannel } = useWSStore();
  const wsRef = useRef<WebSocket | null>(globalWs);

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
      // Remove channels from store
      channels.forEach((channel) => removeChannel(channel));

      // Unsubscribe via WebSocket
      if (globalWs?.readyState === WebSocket.OPEN) {
        globalWs.send(JSON.stringify({
          type: 'unsubscribe',
          channels,
        }));
      }
    };
  }, [channels.join(','), addChannel, removeChannel]);
}

export function useWSEvent<T = unknown>(event: string, callback: (data: T) => void) {
  const { addListener, removeListener } = useWSStore();

  useEffect(() => {
    const handler = (data: unknown) => callback(data as T);
    addListener(event, handler);
    return () => removeListener(event, handler);
  }, [event, callback, addListener, removeListener]);
}
