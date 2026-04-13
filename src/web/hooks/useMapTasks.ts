/**
 * Tasks Real-time Hook
 *
 * Subscribes to live task events via WebSocket and invalidates
 * React Query caches so the frontend stays up to date.
 */

import { useCallback } from 'react';
import { useSubscribe, useWSEvent } from './useWebSocket.js';
import { useQueryClient } from '@tanstack/react-query';

// ============================================================================
// Real-time Hook
// ============================================================================

/**
 * Subscribe to live task events via WebSocket.
 * Automatically invalidates React Query caches on task changes.
 */
export function useTasksRealtime() {
  const queryClient = useQueryClient();

  useSubscribe(['map:tasks']);

  const handleTaskEvent = useCallback(
    () => {
      queryClient.invalidateQueries({ queryKey: ['opentasks-summary'] });
      queryClient.invalidateQueries({ queryKey: ['opentasks-ready'] });
      queryClient.invalidateQueries({ queryKey: ['opentasks-graph'] });
    },
    [queryClient],
  );

  useWSEvent('task.created', handleTaskEvent);
  useWSEvent('task.assigned', handleTaskEvent);
  useWSEvent('task.status', handleTaskEvent);
  useWSEvent('task.completed', handleTaskEvent);
  useWSEvent('task.deleted', handleTaskEvent);
  useWSEvent('task.linked', handleTaskEvent);
  useWSEvent('task.unlinked', handleTaskEvent);
}

/** @deprecated Use useTasksRealtime instead */
export const useMapTasksRealtime = useTasksRealtime;
