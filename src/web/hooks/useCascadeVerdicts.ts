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

export interface ReviewInboxEntry {
  stream_row_id: string;
  stream_id: string;
  name: string;
  source_swarm_id: string;
  policy: 'advisory' | 'required';
  head_commit: string;
  agent_verdict: {
    verdict: ReviewVerdictValue;
    reviewer_id: string | null;
    notes: string | null;
  } | null;
}

/**
 * The derived "awaiting review" set — active streams with commits under a
 * non-none policy and no human verdict at the current head. Feeds the
 * Changes page bucket.
 */
export function useReviewInbox() {
  return useQuery({
    queryKey: ['cascade-review-inbox'],
    queryFn: async () => {
      return api.get<{ data: ReviewInboxEntry[]; total: number }>(
        '/cascade/review-inbox',
      );
    },
  });
}

/**
 * Request an agent review (Q3): creates a reviewer dispatch whose completion
 * writes back an advisory agent verdict. Returns the queued dispatch summary.
 */
export function useRequestReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      streamRowId,
      target_swarm_id,
    }: {
      streamRowId: string;
      target_swarm_id?: string;
    }) => {
      const res = await api.post<{
        data: {
          dispatch_id: string;
          target_swarm_id: string;
          role: string | null;
          status: string;
          diff_inlined: boolean;
        };
      }>(`/cascade/streams/${encodeURIComponent(streamRowId)}/request-review`, {
        target_swarm_id,
      });
      return res.data;
    },
    onSuccess: () => {
      // The reviewer job shows up in the Jobs list immediately.
      queryClient.invalidateQueries({ queryKey: ['dispatches'] });
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
