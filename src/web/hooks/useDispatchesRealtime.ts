/**
 * Dispatches Real-time Hook
 *
 * Subscribes to live dispatch events on the `map:dispatches` channel and
 * invalidates dispatch-related React Query caches so the UI reflects state
 * transitions (queued → running → complete/failed/cancelled) without polling.
 */

import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSubscribe, useWSEvent } from './useWebSocket';

interface DispatchEventData {
  dispatch?: { id?: string };
  taskId?: string;
}

function extractDispatchId(data: unknown): string | undefined {
  const d = data as DispatchEventData | undefined;
  return d?.dispatch?.id ?? d?.taskId;
}

export function useDispatchesRealtime() {
  const qc = useQueryClient();

  useSubscribe(['map:dispatches']);

  const invalidate = useCallback(
    (data: unknown) => {
      qc.invalidateQueries({ queryKey: ['dispatches'] });
      const id = extractDispatchId(data);
      if (id) qc.invalidateQueries({ queryKey: ['dispatch', id] });
    },
    [qc],
  );

  useWSEvent('dispatch.created', invalidate);
  useWSEvent('dispatch.status_changed', invalidate);
  useWSEvent('dispatch.completed', invalidate);
  useWSEvent('dispatch.cancelled', invalidate);
  // Orchestrator-emitted events — these drive attempt/turn counters and
  // the cancel-ack warning.
  useWSEvent('dispatch.retrying', invalidate);
  useWSEvent('dispatch.dead', invalidate);
  useWSEvent('dispatch.cancel_not_acked', invalidate);
  useWSEvent('dispatch.stall_detected', invalidate);
}

/**
 * Track which dispatches have had a `cancel_not_acked` event in the current
 * session. Consumed by DispatchDetail to surface a warning ribbon when the
 * agent failed to acknowledge a user-initiated cancel.
 */
export function useCancelAckWarnings(dispatchId: string | undefined): {
  warned: boolean;
  dismiss: () => void;
} {
  const [warnedIds, setWarnedIds] = useState<Set<string>>(new Set());

  const onCancelNotAcked = useCallback((data: unknown) => {
    const id = extractDispatchId(data);
    if (!id) return;
    setWarnedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  useWSEvent('dispatch.cancel_not_acked', onCancelNotAcked);

  const dismiss = useCallback(() => {
    if (!dispatchId) return;
    setWarnedIds((prev) => {
      if (!prev.has(dispatchId)) return prev;
      const next = new Set(prev);
      next.delete(dispatchId);
      return next;
    });
  }, [dispatchId]);

  // Clear the set when the dispatch id changes — different page, different context.
  useEffect(() => {
    setWarnedIds(new Set());
  }, [dispatchId]);

  return {
    warned: dispatchId ? warnedIds.has(dispatchId) : false,
    dismiss,
  };
}
