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
  /** Transport that delivered this attempt (V49). Populated by the adapter
   *  that performed delivery — `acp` from the runtime, `mail` from the
   *  mail port. Absent on attempts that never reached delivery. */
  transport?: 'acp' | 'mail' | 'codex';
  /** Resolved target agent id at delivery time (V49). */
  agent_id?: string;
  /** Routing decision from swarm-dispatch (V49): `spawn` = fresh agent
   *  started, `route` = existing agent picked. Diagnostic. */
  via?: 'spawn' | 'route';
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
  /** Per-dispatch transport hint for ACP routing. `'fresh'` spawns a new
   *  coordinator with loadout permissions enforced at spawn time;
   *  `'reuse'` attaches to an existing ACP-capable agent (advisory). Null
   *  falls through to `config.dispatch.acp_lifecycle_default`. */
  acp_lifecycle: 'fresh' | 'reuse' | null;
  /** Same shape as acp_lifecycle but for the mail transport. `'fresh'`
   *  forces routing to the connection's sidecar (which spawns an
   *  ephemeral worker per envelope); `'reuse'` lets the roster pick. */
  mail_lifecycle: 'fresh' | 'reuse' | null;
  /** Loadout binding (V49): the original `loadout_ref` or
   *  `team:<template>/role:<role>` string captured at enrichment. */
  loadout_ref: string | null;
  /** Materialization status (V49). `null` = no binding. */
  loadout_status: 'materialized' | 'failed' | null;
  /** Materialization error message when status='failed' (V49). */
  loadout_error: string | null;
  /** Linked dispatch coordination thread conversation id. Null until the
   *  first message is posted (lazy creation). */
  conversation_id: string | null;
  /** Shared coordinated-team thread id (P4.2). Non-null when this dispatch
   *  was created as part of a coordinated fan-out. */
  team_conversation_id: string | null;
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
  // Advanced (P4.1) — all optional; the backend DispatchSpecSchema already
  // accepts these. Omitted fields keep the simple two-click dispatch path.
  loadout_resource_id?: string;
  team_template_resource_id?: string;
  role?: string;
  acp_lifecycle?: 'fresh' | 'reuse';
  mail_lifecycle?: 'fresh' | 'reuse';
  repo_id?: string;
  branch?: string;
  /** Coordinated-team mode (P4.2) — shared thread across >1 target. */
  coordinated?: boolean;
}

// ============================================================================
// Queries
// ============================================================================

export interface UseDispatchListOptions {
  status?: DispatchStatus | DispatchStatus[];
  target_swarm_id?: string;
  spec_resource_id?: string;
  spec_id?: string;
  task_resource_id?: string;
  task_node_id?: string;
  initiator_id?: string;
  initiator_type?: DispatchInitiatorType;
  limit?: number;
  offset?: number;
  enabled?: boolean;
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
  if (options.task_resource_id) params.set('task_resource_id', options.task_resource_id);
  if (options.task_node_id) params.set('task_node_id', options.task_node_id);
  if (options.initiator_id) params.set('initiator_id', options.initiator_id);
  if (options.initiator_type) params.set('initiator_type', options.initiator_type);
  params.set('limit', String(options.limit ?? 50));
  params.set('offset', String(options.offset ?? 0));

  return useQuery({
    queryKey: ['dispatches', { ...options }],
    queryFn: () => api.get<DispatchesResponse>(`/dispatches?${params.toString()}`),
    enabled: options.enabled ?? true,
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
        {
          target_swarms: input.target_swarms,
          prompt: input.prompt,
          ...(input.loadout_resource_id
            ? { loadout_resource_id: input.loadout_resource_id }
            : {}),
          ...(input.team_template_resource_id
            ? { team_template_resource_id: input.team_template_resource_id }
            : {}),
          ...(input.role ? { role: input.role } : {}),
          ...(input.acp_lifecycle ? { acp_lifecycle: input.acp_lifecycle } : {}),
          ...(input.mail_lifecycle ? { mail_lifecycle: input.mail_lifecycle } : {}),
          ...(input.repo_id ? { repo_id: input.repo_id } : {}),
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.coordinated ? { coordinated: true } : {}),
        },
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
