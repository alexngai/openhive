/**
 * useSessionChatRealtime — Subscribes to mail conversation WebSocket events
 * for a session's linked conversation and invalidates relevant caches.
 */

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSubscribe, useWSEvent } from './useWebSocket';

export function useSessionChatRealtime(
  sessionId?: string,
  conversationId?: string | null,
): void {
  const queryClient = useQueryClient();

  // Subscribe to the conversation's WebSocket channel
  useSubscribe(
    conversationId ? [`mail:conversation:${conversationId}`] : [],
  );

  // When a new turn is added, invalidate session events so the merged view updates
  useWSEvent('mail.turn.added', useCallback(() => {
    if (sessionId) {
      queryClient.invalidateQueries({ queryKey: ['session-events', sessionId] });
    }
    if (conversationId) {
      queryClient.invalidateQueries({ queryKey: ['mail-turns', conversationId] });
    }
  }, [queryClient, sessionId, conversationId]));
}
