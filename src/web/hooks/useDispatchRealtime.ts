/**
 * Dispatch Real-time Hook
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
  dispatch_id?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractPayload(data: unknown): DispatchEventData | undefined {
  if (!isRecord(data)) return undefined;
  return (isRecord(data.data) ? data.data : data) as DispatchEventData;
}

function extractDispatchId(data: unknown): string | undefined {
  const payload = extractPayload(data);
  return payload?.dispatch?.id ?? payload?.taskId ?? payload?.dispatch_id;
}

function extractDispatchError(data: unknown): string | undefined {
  const payload = extractPayload(data);
  return payload?.error;
}

export function useDispatchRealtime() {
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
  // Loadout materialization failed during enrichment — the dispatch will
  // proceed without the loadout. Surfaced as a banner on DispatchDetail via
  // useMaterializationWarnings; we still invalidate so the row reloads in
  // case the orchestrator persists a marker.
  useWSEvent('dispatch.materialization_failed', invalidate);
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

/**
 * Track which dispatches saw a `materialization_failed` event in the current
 * session, alongside the error reason. Consumed by DispatchDetail to surface
 * a banner when loadout enrichment failed and the dispatch ran without it.
 */
export function useMaterializationWarnings(dispatchId: string | undefined): {
  error: string | null;
  dismiss: () => void;
} {
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  const onMaterializationFailed = useCallback((data: unknown) => {
    const id = extractDispatchId(data);
    if (!id) return;
    const err = extractDispatchError(data) ?? 'unknown error';
    setErrors((prev) => {
      if (prev.get(id) === err) return prev;
      const next = new Map(prev);
      next.set(id, err);
      return next;
    });
  }, []);

  useWSEvent('dispatch.materialization_failed', onMaterializationFailed);

  const dismiss = useCallback(() => {
    if (!dispatchId) return;
    setErrors((prev) => {
      if (!prev.has(dispatchId)) return prev;
      const next = new Map(prev);
      next.delete(dispatchId);
      return next;
    });
  }, [dispatchId]);

  useEffect(() => {
    setErrors(new Map());
  }, [dispatchId]);

  return {
    error: dispatchId ? errors.get(dispatchId) ?? null : null,
    dismiss,
  };
}
