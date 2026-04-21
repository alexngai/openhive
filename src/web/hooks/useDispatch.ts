import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export type DispatchStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export type DispatchInitiatorType = 'user' | 'agent';

export interface DispatchOutcome {
  summary?: string;
  artifacts?: Array<{ kind: string; ref: string }>;
  error?: string;
  [key: string]: unknown;
}

export interface DispatchAttempt {
  attempt: number;
  started_at: string;
  ended_at?: string;
  status: 'running' | 'completed' | 'failed' | 'retrying';
  error?: string;
  session_id?: string;
  next_retry_at?: string;
}

export interface Dispatch {
  id: string;
  spec_resource_id: string;
  spec_id: string;
  spec_captured_at: string | null;
  target_swarm_id: string;
  status: DispatchStatus;
  initiator_type: DispatchInitiatorType;
  initiator_id: string;
  session_ids: string[];
  outcome: DispatchOutcome | null;
  prompt_override: string | null;
  attempt?: number;
  turn_count?: number;
  attempts_history?: DispatchAttempt[];
  created_at: string;
  updated_at: string;
}

/** Per-dispatch payload returned by POST /specs/:rid/:specId/dispatch — the
 *  base Dispatch plus the seed prompt for the agent + the resolved swarm name
 *  for ack display.
 */
export interface CreatedDispatch extends Dispatch {
  seed_prompt: string;
  target_swarm_name: string | null;
}

export interface DispatchesResponse {
  data: Dispatch[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateDispatchInput {
  resource_id: string;
  spec_id: string;
  target_swarms: string[];
  prompt?: string;
}

// ============================================================================
// Queries
// ============================================================================

export interface UseDispatchListOptions {
  status?: DispatchStatus | DispatchStatus[];
  target_swarm_id?: string;
  spec_resource_id?: string;
  spec_id?: string;
  initiator_id?: string;
  initiator_type?: DispatchInitiatorType;
  limit?: number;
  offset?: number;
}

export function useDispatchList(options: UseDispatchListOptions = {}) {
  const params = new URLSearchParams();
  if (options.status) {
    const v = Array.isArray(options.status) ? options.status.join(',') : options.status;
    params.set('status', v);
  }
  if (options.target_swarm_id) params.set('target_swarm_id', options.target_swarm_id);
  if (options.spec_resource_id) params.set('spec_resource_id', options.spec_resource_id);
  if (options.spec_id) params.set('spec_id', options.spec_id);
  if (options.initiator_id) params.set('initiator_id', options.initiator_id);
  if (options.initiator_type) params.set('initiator_type', options.initiator_type);
  params.set('limit', String(options.limit ?? 50));
  params.set('offset', String(options.offset ?? 0));

  return useQuery({
    queryKey: ['dispatches', { ...options }],
    queryFn: () => api.get<DispatchesResponse>(`/dispatches?${params.toString()}`),
    staleTime: 15_000,
  });
}

export interface DispatchLinkedTaskRef {
  resource_id: string;
  node_id: string;
  advanced_on_start?: boolean;
}

export interface DispatchDetailResponse {
  dispatch: Dispatch;
  linked_tasks?: DispatchLinkedTaskRef[];
}

export function useDispatch(id: string | undefined) {
  return useQuery({
    queryKey: ['dispatch', id],
    queryFn: () => api.get<DispatchDetailResponse>(`/dispatches/${id}`),
    enabled: !!id,
    staleTime: 15_000,
    // Polling fallback for the running window: the primary source of
    // truth is the `map:dispatches` WS channel (see useDispatchRealtime),
    // but if the socket drops or the server doesn't emit for any reason,
    // a 5s tick keeps the detail view honest. Stops automatically once
    // the dispatch settles — compare status against the known terminal
    // set so new statuses auto-poll until proven terminal.
    refetchInterval: (query) => {
      const status = query.state.data?.dispatch.status;
      const terminal: ReadonlyArray<string> = ['complete', 'failed', 'cancelled'];
      if (!status || terminal.includes(status)) return false;
      return 5_000;
    },
  });
}

// ============================================================================
// Mutations
// ============================================================================

export function useCreateDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDispatchInput) =>
      api.post<{ dispatches: CreatedDispatch[] }>(
        `/specs/${input.resource_id}/${input.spec_id}/dispatch`,
        { target_swarms: input.target_swarms, prompt: input.prompt },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dispatches'] });
    },
  });
}

export function useCancelDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ dispatch: Dispatch }>(`/dispatches/${id}/cancel`, undefined),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['dispatches'] });
      qc.invalidateQueries({ queryKey: ['dispatch', id] });
    },
  });
}

// Bootstrap is now handled by the dispatch orchestrator (src/dispatch/setup.ts).
// The POST /dispatches/:id/bootstrap endpoint has been removed.

// ============================================================================
// Admin: dispatch policy (kill switch)
// ============================================================================

export interface DispatchPolicy {
  autonomous_dispatch_paused: boolean;
}

export function useDispatchPolicy() {
  return useQuery({
    queryKey: ['dispatch-policy'],
    queryFn: () => api.get<DispatchPolicy>('/admin/dispatch-policy'),
    staleTime: 30_000,
  });
}

export function useUpdateDispatchPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) =>
      api.post<DispatchPolicy>('/admin/dispatch-policy', { paused }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dispatch-policy'] });
    },
  });
}
