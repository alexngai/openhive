/**
 * useGlobalAttention — single app-wide listener that feeds the session
 * attention store (idle + permission items) from WebSocket events, so the
 * cockpit surfaces (sidebar badge, attention queue, thread rows) stay
 * accurate without any chat surface being mounted.
 *
 * Mounted exactly once in Layout. Sources:
 *
 * - `trajectory:sync` (global)        → idle detection (agent awaiting input)
 * - `node_state_changed` (global)     → needs_attention states per swarm
 * - `acp.permission.request` (global) → ACP tool-approval pending; the
 *   streamId is mapped to a session via the sessions-overview cache
 *   (`acp_stream_id`), falling back to a `stream:<id>` thread key when the
 *   cache hasn't loaded that session yet
 * - `acp.permission.resolved` (global) → answered in any tab; drop the item
 * - `hosted-chat.event` (`hosted-chat:<id>` channels, one per running
 *   rpc-mode hosted swarm) → codex permission request/resolve
 *
 * Query invalidation stays in `useSessionsRealtime`; this hook owns only
 * attention state + user-facing toasts (previously per-page, now app-wide).
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscribe, useWSEvent } from './useWebSocket';
import { useHostedSwarms } from './useApi';
import {
  useSessionAttentionStore,
  sessionThreadKey,
  hostedChatThreadKey,
  streamThreadKey,
} from '../stores/session-attention';
import { toast } from '../stores/toast';
import { api } from '../lib/api';
import type { PendingAttentionItem, SessionListItem } from '../lib/api';

// Toast deduplication: don't re-toast the same thread within 30s.
const _toastCooldowns = new Map<string, number>();

function shouldToast(key: string): boolean {
  const now = Date.now();
  const last = _toastCooldowns.get(key);
  if (last && now - last < 30_000) return false;
  _toastCooldowns.set(key, now);
  return true;
}

/** Unwrap the WS envelope (`{type, channel, data}`) the store emits. */
function unwrap<T>(raw: unknown): T {
  const envelope = raw as { data?: T } | undefined;
  return (envelope?.data ?? raw) as T;
}

export function useGlobalAttention() {
  const queryClient = useQueryClient();
  const markIdle = useSessionAttentionStore((s) => s.markIdle);
  const markPermission = useSessionAttentionStore((s) => s.markPermission);
  const resolvePermission = useSessionAttentionStore((s) => s.resolvePermission);

  useSubscribe(['global']);

  // Subscribe to per-swarm hosted-chat channels for every running rpc-mode
  // hosted swarm so codex permission events arrive even when no chat surface
  // is open. Channels are ref-counted, so overlap with HostedChat is safe.
  const { data: hostedSwarms } = useHostedSwarms({ state: 'running' });
  const hostedChannels = useMemo(
    () =>
      (hostedSwarms ?? [])
        .filter((h) => h.mode === 'rpc')
        .map((h) => `hosted-chat:${h.id}`),
    [hostedSwarms],
  );
  useSubscribe(hostedChannels);

  // ── Hydration (reload correctness) ──
  //
  // Pending-permission state is in-memory server-side; without this a hard
  // refresh shows an empty queue while agents sit blocked. Seed once —
  // live WS events keep the store current from then on (markPermission is
  // an idempotent upsert keyed by requestId, so overlap is harmless).
  const { data: pendingSnapshot } = useQuery({
    queryKey: ['pending-attention'],
    queryFn: () => api.get<{ items: PendingAttentionItem[] }>('/sessions/pending-attention'),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !pendingSnapshot?.items) return;
    hydrated.current = true;
    for (const item of pendingSnapshot.items) {
      const threadKey =
        item.source === 'hosted' && item.hosted_swarm_id
          ? hostedChatThreadKey(item.hosted_swarm_id)
          : item.session_resource_id
            ? sessionThreadKey(item.session_resource_id)
            : item.stream_id
              ? streamThreadKey(item.stream_id)
              : null;
      if (!threadKey) continue;
      markPermission({
        threadKey,
        requestId: item.request_id,
        description: item.description,
        swarmId: item.swarm_id ?? undefined,
        streamId: item.stream_id,
        hostedSwarmId: item.hosted_swarm_id,
      });
    }
  }, [pendingSnapshot, markPermission]);

  const findSessionsInCache = useCallback((): SessionListItem[] => {
    const cached = queryClient.getQueriesData<{ data: SessionListItem[] }>({
      queryKey: ['sessions-overview'],
    });
    const sessions: SessionListItem[] = [];
    for (const [, data] of cached) {
      if (data?.data) sessions.push(...data.data);
    }
    return sessions;
  }, [queryClient]);

  // ── Idle attention ──

  useWSEvent('trajectory:sync', useCallback((raw: unknown) => {
    const data = unwrap<{
      resource_id?: string;
      source_swarm_id?: string;
      agent_state?: string;
      checkpoint_phase?: string;
    }>(raw);
    const isIdle =
      data?.agent_state === 'idle' ||
      data?.checkpoint_phase === 'idle' ||
      data?.checkpoint_phase === 'ended';
    if (!isIdle || !data.resource_id) return;
    const key = sessionThreadKey(data.resource_id);
    markIdle(key, data.source_swarm_id || '', 'idle');
    if (shouldToast(key)) {
      const session = findSessionsInCache().find((s) => s.id === data.resource_id);
      toast.info(session?.name ?? 'Session', 'Agent is awaiting input');
    }
  }, [markIdle, findSessionsInCache]));

  useWSEvent('node_state_changed', useCallback((raw: unknown) => {
    const data = unwrap<{
      swarm_id?: string;
      new_state?: string;
      needs_attention?: boolean;
    }>(raw);
    if (!data?.needs_attention || !data.swarm_id) return;
    const sessions = findSessionsInCache().filter(
      (s) => s.source_swarm_id === data.swarm_id || s.source_swarm_ids?.includes(data.swarm_id!),
    );
    for (const session of sessions) {
      const key = sessionThreadKey(session.id);
      markIdle(key, data.swarm_id, data.new_state ?? 'idle');
      if (shouldToast(key)) {
        toast.info(session.name, `Agent is ${data.new_state}`);
      }
    }
  }, [markIdle, findSessionsInCache]));

  // ── ACP permissions ──

  useWSEvent('acp.permission.request', useCallback((raw: unknown) => {
    const data = unwrap<{
      streamId?: string;
      requestId?: string;
      id?: string;
      description?: string;
      toolCall?: { name?: string };
    }>(raw);
    const streamId = data?.streamId;
    if (!streamId) return;
    const requestId = data.requestId ?? data.id ?? `perm-${Date.now()}`;
    const description =
      data.description ?? String(data.toolCall?.name ?? 'Tool approval');
    const session = findSessionsInCache().find((s) => s.acp_stream_id === streamId);
    const threadKey = session ? sessionThreadKey(session.id) : streamThreadKey(streamId);
    markPermission({
      threadKey,
      requestId,
      description,
      swarmId: session?.source_swarm_id ?? undefined,
      streamId,
    });
    toast.info(session?.name ?? 'Agent session', `Permission requested: ${description}`);
  }, [markPermission, findSessionsInCache]));

  useWSEvent('acp.permission.resolved', useCallback((raw: unknown) => {
    const data = unwrap<{ requestId?: string }>(raw);
    if (data?.requestId) resolvePermission(data.requestId);
  }, [resolvePermission]));

  // ── Hosted (codex rpc) permissions ──

  useWSEvent('hosted-chat.event', useCallback((raw: unknown) => {
    const payload = unwrap<{
      hosted_swarm_id?: string;
      event?:
        | { kind: 'permission.request'; request: { requestId: string; summary?: string; reason?: string } }
        | { kind: 'permission.resolved'; requestId: string }
        | { kind: string };
    }>(raw);
    const hostedSwarmId = payload?.hosted_swarm_id;
    const event = payload?.event;
    if (!hostedSwarmId || !event) return;
    if (event.kind === 'permission.request' && 'request' in event) {
      const description = event.request.summary ?? event.request.reason ?? 'Tool approval';
      markPermission({
        threadKey: hostedChatThreadKey(hostedSwarmId),
        requestId: event.request.requestId,
        description,
        hostedSwarmId,
      });
      const name = (hostedSwarms ?? []).find((h) => h.id === hostedSwarmId)?.name;
      toast.info(name ?? 'Hosted agent', `Permission requested: ${description}`);
    } else if (event.kind === 'permission.resolved' && 'requestId' in event) {
      resolvePermission(event.requestId);
    }
  }, [markPermission, resolvePermission, hostedSwarms]));
}
