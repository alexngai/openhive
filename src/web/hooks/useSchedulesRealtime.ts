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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractScheduleId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const payload = isRecord(data.data) ? data.data : data;
  return typeof payload.schedule_id === 'string' ? payload.schedule_id : undefined;
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
