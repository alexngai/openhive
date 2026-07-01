/**
 * Experiments realtime invalidation.
 *
 * Subscribes to the fleet channel `map:experiments` (always) and, when an
 * experiment id is supplied, the per-experiment channel `experiment:<id>`.
 * Mirrors the schedules/dispatches realtime pattern: WS lifecycle events
 * invalidate the matching React Query keys instead of polling.
 *
 * Event → invalidation mapping (see src/realtime/experiment-events.ts):
 *   experiment.updated       → list + detail
 *   experiment.run_started   → list + detail + runs
 *   experiment.run_updated   → list + detail + runs + this run
 *   experiment.run_finished  → list + detail + runs + this run + candidates
 *   experiment.candidate     → detail + candidates + this run's events
 */

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSubscribe, useWSEvent } from './useWebSocket';

interface ExperimentEventData {
  experiment_id?: string;
  run_id?: string;
}

function extractIds(data: unknown): ExperimentEventData {
  const d = data as { data?: ExperimentEventData } | undefined;
  // WS messages arrive as `{ type, channel?, data }`; the lifecycle payload is
  // under `.data`. Tolerate a flat shape too (handler test passes data directly).
  return (d?.data ?? (data as ExperimentEventData) ?? {}) as ExperimentEventData;
}

export function useExperimentsRealtime(experimentId?: string) {
  const qc = useQueryClient();

  const channels = experimentId
    ? ['map:experiments', `experiment:${experimentId}`]
    : ['map:experiments'];
  useSubscribe(channels);

  // experiment.updated → list + detail.
  const onExperimentUpdated = useCallback(
    (data: unknown) => {
      qc.invalidateQueries({ queryKey: ['experiments'] });
      const { experiment_id } = extractIds(data);
      const id = experiment_id ?? experimentId;
      if (id) qc.invalidateQueries({ queryKey: ['experiment', id] });
    },
    [qc, experimentId],
  );
  useWSEvent('experiment.updated', onExperimentUpdated);

  // run lifecycle → list + detail + runs (+ this run on update/finish).
  const onRunChanged = useCallback(
    (data: unknown) => {
      const { experiment_id, run_id } = extractIds(data);
      const id = experiment_id ?? experimentId;
      qc.invalidateQueries({ queryKey: ['experiments'] });
      if (id) {
        qc.invalidateQueries({ queryKey: ['experiment', id] });
        qc.invalidateQueries({ queryKey: ['experiment-runs', id] });
        if (run_id) qc.invalidateQueries({ queryKey: ['experiment-run', id, run_id] });
      }
    },
    [qc, experimentId],
  );
  useWSEvent('experiment.run_started', onRunChanged);
  useWSEvent('experiment.run_updated', onRunChanged);

  // run_finished produces the seesaw + claim + content_hash + candidate
  // snapshot — invalidate candidates + the run's event tail too.
  const onRunFinished = useCallback(
    (data: unknown) => {
      const { experiment_id, run_id } = extractIds(data);
      const id = experiment_id ?? experimentId;
      qc.invalidateQueries({ queryKey: ['experiments'] });
      if (id) {
        qc.invalidateQueries({ queryKey: ['experiment', id] });
        qc.invalidateQueries({ queryKey: ['experiment-runs', id] });
        qc.invalidateQueries({ queryKey: ['experiment-candidates', id] });
        if (run_id) {
          qc.invalidateQueries({ queryKey: ['experiment-run', id, run_id] });
          qc.invalidateQueries({ queryKey: ['experiment-run-events', id, run_id] });
        }
      }
    },
    [qc, experimentId],
  );
  useWSEvent('experiment.run_finished', onRunFinished);

  // candidate projection → detail + candidates + this run's live event tail.
  const onCandidate = useCallback(
    (data: unknown) => {
      const { experiment_id, run_id } = extractIds(data);
      const id = experiment_id ?? experimentId;
      if (id) {
        qc.invalidateQueries({ queryKey: ['experiment', id] });
        qc.invalidateQueries({ queryKey: ['experiment-candidates', id] });
        if (run_id) {
          qc.invalidateQueries({ queryKey: ['experiment-run-events', id, run_id] });
        }
      }
    },
    [qc, experimentId],
  );
  useWSEvent('experiment.candidate', onCandidate);
}
