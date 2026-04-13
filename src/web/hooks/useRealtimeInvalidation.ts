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
import { useSessionAttentionStore } from '../stores/session-attention';
import { toast } from '../stores/toast';
import type { SessionListItem } from '../lib/api';

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
  // Note: swarm_heartbeat intentionally omitted — it fires every ~30s per swarm
  // and causes excessive refetch storms. Swarm status updates from heartbeats
  // are cosmetic; lifecycle events above cover meaningful state changes.

  // Connection health events — only invalidate connection-specific queries
  const invalidateConnections = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['connections'] });
    queryClient.invalidateQueries({ queryKey: ['connection-health'] });
  }, [queryClient]);

  useWSEvent('connection_degraded', invalidateConnections);
  useWSEvent('connection_recovered', invalidateConnections);
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
// Toast deduplication: don't re-toast the same session within 30s
const _toastCooldowns = new Map<string, number>();

function shouldToast(sessionId: string): boolean {
  const now = Date.now();
  const last = _toastCooldowns.get(sessionId);
  if (last && now - last < 30_000) return false;
  _toastCooldowns.set(sessionId, now);
  return true;
}

export function useSessionsRealtime() {
  const queryClient = useQueryClient();
  const { markNeedsAttention } = useSessionAttentionStore();

  useSubscribe(['global']);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['sessions-overview'] });
    queryClient.invalidateQueries({ queryKey: ['session-checkpoints'] });
  }, [queryClient]);

  // Resolve swarmId → session(s) from the React Query cache
  const findSessionsBySwarm = useCallback((swarmId: string): SessionListItem[] => {
    const cached = queryClient.getQueriesData<{ data: SessionListItem[] }>({ queryKey: ['sessions-overview'] });
    const sessions: SessionListItem[] = [];
    for (const [, data] of cached) {
      if (!data?.data) continue;
      for (const s of data.data) {
        if (s.source_swarm_id === swarmId || s.source_swarm_ids?.includes(swarmId)) {
          sessions.push(s);
        }
      }
    }
    return sessions;
  }, [queryClient]);

  // trajectory:sync — invalidate caches + detect idle agent via two signals:
  // 1. agent_state from MAP node DB (set by agent.state_changed eventBus handler)
  // 2. checkpoint_phase from sessionlog metadata (idle = turn complete, ended = session done)
  useWSEvent('trajectory:sync', useCallback((data: any) => {
    invalidate();
    const isIdle = data?.agent_state === 'idle' || data?.checkpoint_phase === 'idle' || data?.checkpoint_phase === 'ended';
    if (isIdle && data.resource_id) {
      markNeedsAttention(data.resource_id, data.source_swarm_id || '', 'idle');
      const sessions = findSessionsBySwarm(data.source_swarm_id || '');
      const session = sessions.find(s => s.id === data.resource_id);
      if (session && shouldToast(data.resource_id)) {
        toast.info(session.name, 'Agent is awaiting input');
      }
    }
  }, [invalidate, markNeedsAttention, findSessionsBySwarm]));

  // node_state_changed — mark sessions needing attention
  useWSEvent('node_state_changed', useCallback((data: any) => {
    if (!data?.needs_attention || !data.swarm_id) return;
    const sessions = findSessionsBySwarm(data.swarm_id);
    for (const session of sessions) {
      markNeedsAttention(session.id, data.swarm_id, data.new_state);
      if (shouldToast(session.id)) {
        toast.info(session.name, `Agent is ${data.new_state}`);
      }
    }
  }, [markNeedsAttention, findSessionsBySwarm]));
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
