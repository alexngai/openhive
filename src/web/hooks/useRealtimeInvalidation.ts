/**
 * Realtime Invalidation Hooks
 *
 * Per-domain hooks that subscribe to WebSocket channels and invalidate
 * React Query caches when server-side events arrive. This replaces
 * refetchInterval polling with instant, event-driven updates.
 */

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSubscribe, useWSEvent } from './useWebSocket';

// ── Swarms ──

/**
 * Invalidates hosted-swarms, map-swarms, and map-stats queries
 * when swarm lifecycle events arrive on `map:discovery`.
 */
export function useSwarmRealtime() {
  const queryClient = useQueryClient();

  useSubscribe(['map:discovery']);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['hosted-swarms'] });
    queryClient.invalidateQueries({ queryKey: ['map-swarms'] });
    queryClient.invalidateQueries({ queryKey: ['map-stats'] });
  }, [queryClient]);

  useWSEvent('swarm_registered', invalidate);
  useWSEvent('swarm_offline', invalidate);
  useWSEvent('swarm_spawned', invalidate);
  useWSEvent('swarm_stopped', invalidate);
  useWSEvent('swarm_heartbeat', invalidate);
}

// ── Resources & Sync ──

/**
 * Invalidates resources, resource-events, and sync-status queries
 * when resource or sync events arrive.
 */
export function useResourcesRealtime() {
  const queryClient = useQueryClient();

  useSubscribe(['global']);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['resources'] });
    queryClient.invalidateQueries({ queryKey: ['resource-events'] });
    queryClient.invalidateQueries({ queryKey: ['sync-status'] });
  }, [queryClient]);

  useWSEvent('resource_updated', invalidate);
  useWSEvent('resource_created', invalidate);
  useWSEvent('resource_synced', invalidate);
}

// ── Sessions ──

/**
 * Invalidates sessions-overview and session-checkpoints queries
 * when trajectory sync events arrive.
 */
export function useSessionsRealtime() {
  const queryClient = useQueryClient();

  useSubscribe(['global']);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['sessions-overview'] });
    queryClient.invalidateQueries({ queryKey: ['session-checkpoints'] });
  }, [queryClient]);

  useWSEvent('trajectory:sync', invalidate);
}
