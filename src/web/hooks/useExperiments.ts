import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

// ============================================================================
// Types — mirror the experiments DAL row shapes + the route `publicRun`
// stripper. `worker_token_hash` is never present client-side (the server
// strips it from every run it returns).
// ============================================================================

export type ExperimentStatus = 'draft' | 'active' | 'paused' | 'archived';
export type ObjectiveDirection = 'increase' | 'decrease';
export type ExperimentInitiatorType = 'user' | 'agent';
export type RunStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export type RunInitiatorType = 'user' | 'agent' | 'schedule';
export type CandidateStatus =
  | 'baseline'
  | 'admitted'
  | 'keep'
  | 'discard'
  | 'crash'
  | 'no_candidate';

/**
 * Claim regime reported by the runner at finalization. The hub stores it as
 * opaque JSON (`claim_strength` is `z.unknown()` on the wire); the runner emits
 * a `{ strength, label? }` shape. `strength` is the honesty axis we badge on.
 */
export interface ClaimStrength {
  strength?: 'capability' | 'judged' | 'heldOutJudge' | 'gameable' | 'anchor' | string;
  label?: string;
  [key: string]: unknown;
}

export interface Experiment {
  id: string;
  hive_id: string;
  name: string;
  description: string | null;
  content_hash: string | null;
  objective_metric: string;
  objective_direction: ObjectiveDirection;
  objective_min_delta: number;
  claims: unknown | null;
  config: unknown;
  repo_resource_id: string | null;
  status: ExperimentStatus;
  incumbent_candidate_id: string | null;
  initiator_type: ExperimentInitiatorType;
  initiator_id: string;
  created_at: string;
  updated_at: string;
}

/** A run as returned by the API — `publicRun` strips `worker_token_hash`. */
export interface ExperimentRun {
  id: string;
  experiment_id: string;
  autonomation_run_id: string | null;
  hosted_swarm_id: string | null;
  content_hash: string | null;
  env_fingerprint: unknown | null;
  repo_root: string | null;
  experiment_branch: string | null;
  experiment_worktree: string | null;
  start_point: string | null;
  status: RunStatus;
  stop_reason: string | null;
  stop_message: string | null;
  claim_strength: ClaimStrength | null;
  cycles: number;
  total_proposed: number;
  total_admitted: number;
  total_promoted: number;
  candidate_failures: number;
  summary: unknown | null;
  initiator_type: RunInitiatorType;
  initiator_id: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface ExperimentCandidate {
  id: string;
  experiment_id: string;
  run_id: string;
  candidate_ref: string;
  parent_candidate_id: string | null;
  cycle_index: number | null;
  proposer: string | null;
  status: CandidateStatus;
  base_commit: string | null;
  head_commit: string | null;
  changed_paths: string[] | null;
  patch_ref: string | null;
  overlay: unknown | null;
  content_hash: string | null;
  score_train: number | null;
  score_held_out: number | null;
  scores: Record<string, number> | null;
  promoted: boolean;
  rationale: string | null;
  failure_reason: string | null;
  dispatch_id: string | null;
  cascade_stream_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExperimentEvent {
  id: string;
  experiment_id: string;
  run_id: string;
  autonomation_run_id: string | null;
  seq: number;
  type: string;
  cycle_index: number | null;
  candidate_ref: string | null;
  metric: string | null;
  score: number | null;
  message: string | null;
  payload: unknown;
  created_at: string;
  received_at: string;
}

// ============================================================================
// Response shapes
// ============================================================================

export interface ExperimentsResponse {
  data: Experiment[];
  total: number;
  limit: number;
  offset: number;
}

export interface ExperimentDetailResponse {
  experiment: Experiment;
  runs: ExperimentRun[];
  run_total: number;
}

export interface ExperimentRunsResponse {
  data: ExperimentRun[];
  total: number;
}

export interface ExperimentRunResponse {
  run: ExperimentRun;
}

export interface ExperimentCandidatesResponse {
  data: ExperimentCandidate[];
  total: number;
}

export interface ExperimentEventsResponse {
  data: ExperimentEvent[];
  max_seq: number;
}

// ============================================================================
// Queries
// ============================================================================

export interface UseExperimentsOptions {
  hive_id?: string;
  status?: ExperimentStatus;
  limit?: number;
  offset?: number;
  enabled?: boolean;
}

export function useExperiments(options: UseExperimentsOptions = {}) {
  const params = new URLSearchParams();
  if (options.hive_id) params.set('hive_id', options.hive_id);
  if (options.status) params.set('status', options.status);
  params.set('limit', String(options.limit ?? 100));
  params.set('offset', String(options.offset ?? 0));

  return useQuery({
    queryKey: ['experiments', { ...options }],
    queryFn: () => api.get<ExperimentsResponse>(`/experiments?${params.toString()}`),
    enabled: options.enabled ?? true,
    staleTime: 15_000,
  });
}

export function useExperiment(id: string | undefined) {
  return useQuery({
    queryKey: ['experiment', id],
    queryFn: () => api.get<ExperimentDetailResponse>(`/experiments/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useExperimentRuns(id: string | undefined) {
  return useQuery({
    queryKey: ['experiment-runs', id],
    queryFn: () => api.get<ExperimentRunsResponse>(`/experiments/${id}/runs`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useExperimentRun(id: string | undefined, runId: string | undefined) {
  return useQuery({
    queryKey: ['experiment-run', id, runId],
    queryFn: () => api.get<ExperimentRunResponse>(`/experiments/${id}/runs/${runId}`),
    enabled: !!id && !!runId,
    staleTime: 15_000,
  });
}

export function useExperimentCandidates(id: string | undefined) {
  return useQuery({
    queryKey: ['experiment-candidates', id],
    queryFn: () =>
      api.get<ExperimentCandidatesResponse>(`/experiments/${id}/candidates`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export function useExperimentRunEvents(
  id: string | undefined,
  runId: string | undefined,
  afterSeq?: number,
) {
  const params = new URLSearchParams();
  if (afterSeq !== undefined) params.set('after_seq', String(afterSeq));
  params.set('limit', '500');
  const qs = params.toString();

  return useQuery({
    queryKey: ['experiment-run-events', id, runId, afterSeq ?? null],
    queryFn: () =>
      api.get<ExperimentEventsResponse>(
        `/experiments/${id}/runs/${runId}/events?${qs}`,
      ),
    enabled: !!id && !!runId,
    staleTime: 15_000,
  });
}

// ============================================================================
// Mutations — admin (launch/cancel) + operator (create run, pause/resume/
// archive). Each invalidates the relevant list + detail keys on success.
// ============================================================================

export function useCreateRun(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: Record<string, unknown>) =>
      api.post<{ run: ExperimentRun; worker_token: string }>(
        `/experiments/${id}/runs`,
        body ?? {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['experiments'] });
      qc.invalidateQueries({ queryKey: ['experiment', id] });
      qc.invalidateQueries({ queryKey: ['experiment-runs', id] });
    },
  });
}

export function useLaunchRun(id: string, runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ run: ExperimentRun; pid?: number }>(
        `/experiments/${id}/runs/${runId}/launch`,
        undefined,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['experiments'] });
      qc.invalidateQueries({ queryKey: ['experiment', id] });
      qc.invalidateQueries({ queryKey: ['experiment-runs', id] });
      qc.invalidateQueries({ queryKey: ['experiment-run', id, runId] });
    },
  });
}

export function useCancelRun(id: string, runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ run: ExperimentRun }>(`/experiments/${id}/runs/${runId}/cancel`, undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['experiments'] });
      qc.invalidateQueries({ queryKey: ['experiment', id] });
      qc.invalidateQueries({ queryKey: ['experiment-runs', id] });
      qc.invalidateQueries({ queryKey: ['experiment-run', id, runId] });
    },
  });
}

function useExperimentLifecycleAction(id: string, action: 'pause' | 'resume' | 'archive') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ experiment: Experiment }>(`/experiments/${id}/${action}`, undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['experiments'] });
      qc.invalidateQueries({ queryKey: ['experiment', id] });
    },
  });
}

export function usePauseExperiment(id: string) {
  return useExperimentLifecycleAction(id, 'pause');
}

export function useResumeExperiment(id: string) {
  return useExperimentLifecycleAction(id, 'resume');
}

export function useArchiveExperiment(id: string) {
  return useExperimentLifecycleAction(id, 'archive');
}
