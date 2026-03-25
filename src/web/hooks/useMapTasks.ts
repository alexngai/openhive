/**
 * MAP Tasks Hooks
 *
 * React Query hooks for fetching MAP task state from connected agents,
 * plus real-time subscriptions for live task updates.
 */

import { useQuery } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../lib/api.js';
import { useSubscribe, useWSEvent } from './useWebSocket.js';
import { useQueryClient } from '@tanstack/react-query';

// ============================================================================
// Types
// ============================================================================

export type MAPTaskStatus = 'open' | 'in_progress' | 'blocked' | 'completed' | 'failed';

export interface MAPTask {
  id: string;
  title?: string;
  status?: MAPTaskStatus;
  description?: string;
  assignee?: string | null;
  meta?: Record<string, unknown>;
}

interface TasksListResponse {
  tasks: MAPTask[];
  hasMore: boolean;
  nextCursor?: string;
}

interface TasksSummaryResponse {
  total: number;
  byStatus: Record<string, number>;
  bySwarm: Record<string, number>;
}

interface TaskDetailResponse {
  task: MAPTask;
  swarm_id?: string;
}

// ============================================================================
// Query Hooks
// ============================================================================

export function useMapTasks(options?: {
  status?: string;
  assignee?: string;
  swarmId?: string;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (options?.status) params.set('status', options.status);
  if (options?.assignee) params.set('assignee', options.assignee);
  if (options?.swarmId) params.set('swarm_id', options.swarmId);
  if (options?.limit) params.set('limit', String(options.limit));

  const qs = params.toString();
  return useQuery({
    queryKey: ['map-tasks', options],
    queryFn: () => api.get<TasksListResponse>(`/map/tasks${qs ? `?${qs}` : ''}`),
  });
}

export function useMapTasksSummary() {
  return useQuery({
    queryKey: ['map-tasks-summary'],
    queryFn: () => api.get<TasksSummaryResponse>('/map/tasks/summary'),
  });
}

export function useMapTask(taskId: string | undefined) {
  return useQuery({
    queryKey: ['map-task', taskId],
    queryFn: () => api.get<TaskDetailResponse>(`/map/tasks/${taskId}`),
    enabled: !!taskId,
  });
}

// ============================================================================
// Real-time Hook
// ============================================================================

/**
 * Subscribe to live MAP task events via WebSocket.
 * Automatically invalidates React Query caches on task changes.
 */
export function useMapTasksRealtime() {
  const queryClient = useQueryClient();

  useSubscribe(['map:tasks', 'map:opentasks']);

  const handleTaskEvent = useCallback(
    () => {
      queryClient.invalidateQueries({ queryKey: ['map-tasks'] });
      queryClient.invalidateQueries({ queryKey: ['map-tasks-summary'] });
      // Also invalidate OpenTasks queries since the bridge syncs both directions
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
}
