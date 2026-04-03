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

// ── Memory Content ──

/**
 * Invalidates memory content queries (files, search, knowledge)
 * when memory:sync events arrive for a specific resource.
 * Subscribe to the resource-specific channel for targeted updates.
 */
export function useMemoryRealtime(resourceId: string) {
  const queryClient = useQueryClient();

  useSubscribe([`resource:memory_bank:${resourceId}`]);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['memory-files', resourceId] });
    queryClient.invalidateQueries({ queryKey: ['memory-search', resourceId] });
    queryClient.invalidateQueries({ queryKey: ['memory-file', resourceId] });
    queryClient.invalidateQueries({ queryKey: ['knowledge', resourceId] });
  }, [queryClient, resourceId]);

  useWSEvent('memory:sync', invalidate);
}

// ── Skill Content ──

/**
 * Invalidates skill content queries when skill:sync events arrive.
 */
export function useSkillRealtime(resourceId: string) {
  const queryClient = useQueryClient();

  useSubscribe([`resource:skill:${resourceId}`]);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['skills-list', resourceId] });
    queryClient.invalidateQueries({ queryKey: ['skill-detail', resourceId] });
    queryClient.invalidateQueries({ queryKey: ['skill-graph', resourceId] });
    queryClient.invalidateQueries({ queryKey: ['loadout-state', resourceId] });
    queryClient.invalidateQueries({ queryKey: ['loadout-render', resourceId] });
  }, [queryClient, resourceId]);

  useWSEvent('skill:sync', invalidate);
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

// ── Learning Engine ──

/**
 * Invalidates learning-related queries when learning events arrive.
 * Subscribes to the `learning` channel for instant/batch/maintenance events.
 */
export function useLearningRealtime() {
  const queryClient = useQueryClient();

  useSubscribe(['learning']);

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['learning-stats'] });
    queryClient.invalidateQueries({ queryKey: ['learning-health'] });
    queryClient.invalidateQueries({ queryKey: ['learning-playbooks'] });
    queryClient.invalidateQueries({ queryKey: ['learning-experiences'] });
    queryClient.invalidateQueries({ queryKey: ['learning-knowledge'] });
    queryClient.invalidateQueries({ queryKey: ['learning-activity'] });
  }, [queryClient]);

  const invalidateStats = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['learning-stats'] });
    queryClient.invalidateQueries({ queryKey: ['learning-health'] });
    queryClient.invalidateQueries({ queryKey: ['learning-experiences'] });
    queryClient.invalidateQueries({ queryKey: ['learning-activity'] });
  }, [queryClient]);

  useWSEvent('learning:instant', invalidateStats);
  useWSEvent('learning:batch', invalidateAll);
  useWSEvent('learning:maintenance', invalidateAll);
}
