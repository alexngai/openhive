/**
 * Schedules realtime invalidation.
 *
 * Subscribes to `map:schedules` and invalidates schedule queries on lifecycle
 * events. Mirrors the dispatches/specs realtime pattern.
 */

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSubscribe, useWSEvent } from './useWebSocket';

interface ScheduleEventData {
  schedule_id?: string;
}

function extractScheduleId(data: unknown): string | undefined {
  return (data as ScheduleEventData | undefined)?.schedule_id;
}

export function useSchedulesRealtime() {
  const qc = useQueryClient();

  useSubscribe(['map:schedules']);

  const invalidate = useCallback(
    (data: unknown) => {
      qc.invalidateQueries({ queryKey: ['schedules'] });
      const id = extractScheduleId(data);
      if (id) qc.invalidateQueries({ queryKey: ['schedule', id] });
    },
    [qc],
  );

  useWSEvent('schedule.created', invalidate);
  useWSEvent('schedule.updated', invalidate);
  useWSEvent('schedule.deleted', invalidate);
  useWSEvent('schedule.paused', invalidate);
  useWSEvent('schedule.resumed', invalidate);

  // `schedule.fired` produces new dispatches — invalidate both schedule (fire
  // history) and dispatches (the new rows).
  const onFired = useCallback(
    (data: unknown) => {
      qc.invalidateQueries({ queryKey: ['schedules'] });
      qc.invalidateQueries({ queryKey: ['dispatches'] });
      const id = extractScheduleId(data);
      if (id) qc.invalidateQueries({ queryKey: ['schedule', id] });
    },
    [qc],
  );
  useWSEvent('schedule.fired', onFired);
}
