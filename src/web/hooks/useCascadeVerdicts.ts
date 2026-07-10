import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * Review verdicts (QC station Q1, docs/design/cascade-review-verdicts.md).
 *
 * Hub-owned QC records over cascade streams. Append-only; the current
 * verdict is the newest one at the stream's current head, so a new commit
 * invalidates a prior approval server-side — the UI just refetches.
 */

export type ReviewVerdictValue = 'approved' | 'changes_requested' | 'rejected';

export interface CascadeReviewVerdict {
  id: string;
  stream_row_id: string;
  source_swarm_id: string;
  stream_id: string;
  head_commit: string | null;
  verdict: ReviewVerdictValue;
  reviewer_kind: 'human' | 'agent';
  reviewer_id: string | null;
  notes: string | null;
  dispatch_id: string | null;
  created_at: string;
}

/** Current verdict at the stream's present head (null = unreviewed head). */
export function useCurrentVerdict(streamRowId: string | null) {
  return useQuery({
    queryKey: ['cascade-verdict-current', streamRowId],
    enabled: !!streamRowId,
    queryFn: async () => {
      return api.get<{ data: CascadeReviewVerdict | null; head_commit: string | null }>(
        `/cascade/streams/${encodeURIComponent(streamRowId!)}/verdicts?current=true`,
      );
    },
  });
}

/** Full verdict history for a stream, newest first. */
export function useStreamVerdicts(streamRowId: string | null) {
  return useQuery({
    queryKey: ['cascade-verdicts', streamRowId],
    enabled: !!streamRowId,
    queryFn: async () => {
      return api.get<{ data: CascadeReviewVerdict[]; total: number }>(
        `/cascade/streams/${encodeURIComponent(streamRowId!)}/verdicts`,
      );
    },
  });
}

export function useRecordVerdict() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      streamRowId,
      verdict,
      notes,
    }: {
      streamRowId: string;
      verdict: ReviewVerdictValue;
      notes?: string;
    }) => {
      const res = await api.post<{ data: CascadeReviewVerdict }>(
        `/cascade/streams/${encodeURIComponent(streamRowId)}/verdicts`,
        { verdict, notes },
      );
      return res.data;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['cascade-verdict-current', vars.streamRowId] });
      queryClient.invalidateQueries({ queryKey: ['cascade-verdicts', vars.streamRowId] });
    },
  });
}
