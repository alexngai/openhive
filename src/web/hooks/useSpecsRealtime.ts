/**
 * Specs Real-time Hook
 *
 * Subscribes to live spec events on the `map:tasks` channel (shared with
 * tasks — both are opentasks graph nodes) and invalidates spec-related
 * React Query caches.
 */

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSubscribe, useWSEvent } from './useWebSocket';

export function useSpecsRealtime() {
  const qc = useQueryClient();

  useSubscribe(['map:tasks']);

  const invalidateAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['specs'] });
  }, [qc]);

  const invalidateOne = useCallback(
    (event: { resource_id?: string; spec?: { id?: string } } | undefined) => {
      qc.invalidateQueries({ queryKey: ['specs'] });
      if (event?.resource_id && event?.spec?.id) {
        qc.invalidateQueries({ queryKey: ['spec', event.resource_id, event.spec.id] });
      }
    },
    [qc],
  );

  useWSEvent('spec.created', invalidateAll);
  useWSEvent('spec.updated', (data) => invalidateOne(data as { resource_id?: string; spec?: { id?: string } }));
  useWSEvent('spec.deleted', invalidateAll);
}
