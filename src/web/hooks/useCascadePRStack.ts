import { useMutation } from '@tanstack/react-query';
import { api } from '../lib/api';

export type PRStackEntryStatus =
  | 'created'
  | 'existing'
  | 'push_required'
  | 'blocked_by_parent'
  | 'failed';

export interface PRStackResultEntry {
  /** cascade_streams.id (hub row id). */
  stream_row_id: string;
  /** Cascade runtime stream id. */
  cascade_stream_id: string;
  /** Human stream name. */
  name: string;
  /** Stream status at walk time. */
  status: string;
  /** Branch GitHub will see as `head`. */
  head_branch: string;
  /** Branch GitHub will see as `base`. */
  base_branch: string;
  /**
   * Walker-assigned lineage anchor. UI uses this to show "blocked by"
   * relationships when descendants inherit a push_required from an
   * ancestor.
   */
  lineage_id: string;
  /** Outcome of this entry's PR-creation attempt. */
  result_status: PRStackEntryStatus;
  /** Set on `created` / `existing`. */
  pr_url?: string;
  /** Set on `created` / `existing`. */
  pr_number?: number;
  /** Sanitized error message on `failed`. */
  error?: string;
}

export interface PRStackResult {
  /** Trunk branch resolved for the swarm (echoed for the UI). */
  trunk: string;
  /** Walker order — parent appears before descendants. */
  entries: PRStackResultEntry[];
}

export interface OpenPRStackVariables {
  /** cascade_streams.id of the stack root. */
  rootRowId: string;
  /** Optional override for the root's base branch (default: trunk). */
  target_branch?: string;
  /** Whether to mark new PRs as draft. Default false. */
  draft?: boolean;
}

/**
 * Open a stack of PRs from a cascade stream root. Sequential walker per
 * D18 with per-lineage `blocked_by_parent` propagation (D20). Idempotent:
 * re-running surfaces existing PRs as `result_status='existing'` (D19).
 *
 * No query caching since this is a write action; render the result
 * payload immediately in a drawer.
 */
export function useOpenPRStack() {
  return useMutation({
    mutationFn: async (vars: OpenPRStackVariables): Promise<PRStackResult> => {
      const res = await api.post<{ data: PRStackResult }>(
        `/cascade/streams/${encodeURIComponent(vars.rootRowId)}/pr-stack`,
        {
          target_branch: vars.target_branch,
          draft: vars.draft ?? false,
        },
      );
      return res.data;
    },
  });
}
