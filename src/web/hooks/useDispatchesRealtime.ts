/**
 * Dispatches Real-time Hook
 *
 * Subscribes to live dispatch events on the `map:dispatches` channel and
 * invalidates dispatch-related React Query caches so the UI reflects state
 * transitions (queued → running → complete/failed/cancelled) without polling.
 */

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSubscribe, useWSEvent } from './useWebSocket';

interface DispatchEventData {
  dispatch?: { id?: string };
}

export function useDispatchesRealtime() {
  const qc = useQueryClient();

  useSubscribe(['map:dispatches']);

  const invalidate = useCallback(
    (data: unknown) => {
      qc.invalidateQueries({ queryKey: ['dispatches'] });
      const id = (data as DispatchEventData | undefined)?.dispatch?.id;
      if (id) qc.invalidateQueries({ queryKey: ['dispatch', id] });
    },
    [qc],
  );

  useWSEvent('dispatch.created', invalidate);
  useWSEvent('dispatch.status_changed', invalidate);
  useWSEvent('dispatch.completed', invalidate);
  useWSEvent('dispatch.cancelled', invalidate);
}
