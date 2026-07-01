import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Dispatch } from './useDispatch';

// ============================================================================
// Types — mirror server-side OpenHiveSchedule + payload shape
// ============================================================================

export type CatchUpPolicy = 'skip' | 'fire-once' | 'fire-all';

export interface SchedulePolicy {
  catchUp: CatchUpPolicy;
  skipIfRunning: boolean;
}

export interface SpecRef {
  resource_id: string;
  spec_id: string;
}

export interface ScheduleLifecycleHints {
  acp?: 'fresh' | 'reuse';
  mail?: 'fresh' | 'reuse';
}

export type FallbackSpawnAdapter = 'swarm-runner' | 'claude-code' | 'codex';

export interface FallbackSpawn {
  adapter: FallbackSpawnAdapter;
  cleanup_on_terminal?: boolean;
}

/**
 * Spec-based dispatch. `kind` optional for backward compat with
 * schedules created before the discriminator existed.
 */
export interface DispatchSpecPayload {
  kind?: 'dispatch_spec';
  spec_ref: SpecRef;
  target_swarm_ids: string[];
  prompt_override?: string;
  lifecycle?: ScheduleLifecycleHints;
  loadout_ref?: string;
  fallback_spawn?: FallbackSpawn;
}

/**
 * Ad-hoc prompt dispatch — no spec required. The agent gets the prompt
 * verbatim and decides what to do.
 */
export interface DispatchPromptPayload {
  kind: 'dispatch_prompt';
  prompt: string;
  target_swarm_ids: string[];
  lifecycle?: ScheduleLifecycleHints;
  loadout_ref?: string;
  fallback_spawn?: FallbackSpawn;
}

export type OpenHiveSchedulePayload =
  | DispatchSpecPayload
  | DispatchPromptPayload;

/** Returns 'dispatch_spec' for legacy payloads (no `kind` field). */
export function getPayloadKind(
  payload: OpenHiveSchedulePayload,
): 'dispatch_spec' | 'dispatch_prompt' {
  if ('kind' in payload && payload.kind === 'dispatch_prompt') {
    return 'dispatch_prompt';
  }
  return 'dispatch_spec';
}

export interface Schedule {
  id: string;
  cron: string;
  timezone: string | null;
  payload: OpenHiveSchedulePayload;
  policy: SchedulePolicy;
  paused: boolean;
  next_fires_at: string | null;
  last_fired_at: string | null;
  hive_id: string;
  initiator_type: 'user' | 'agent';
  initiator_id: string;
  pause_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface SchedulesResponse {
  data: Schedule[];
  total: number;
  limit: number;
  offset: number;
}

export interface ScheduleDetailResponse {
  schedule: Schedule;
  fires: Dispatch[];
  fire_total: number;
}

// ============================================================================
// Inputs
// ============================================================================

export interface CreateScheduleInput {
  cron: string;
  timezone?: string;
  payload: OpenHiveSchedulePayload;
  policy?: Partial<SchedulePolicy>;
  paused?: boolean;
  hive_id?: string;
}

export interface UpdateScheduleInput {
  cron?: string;
  timezone?: string | null;
  payload?: OpenHiveSchedulePayload;
  policy?: Partial<SchedulePolicy>;
}

// ============================================================================
// Queries
// ============================================================================

export interface UseSchedulesOptions {
  hive_id?: string;
  initiator_id?: string;
  paused?: boolean;
  limit?: number;
  offset?: number;
  enabled?: boolean;
}

export function useSchedules(options: UseSchedulesOptions = {}) {
  const params = new URLSearchParams();
  if (options.hive_id) params.set('hive_id', options.hive_id);
  if (options.initiator_id) params.set('initiator_id', options.initiator_id);
  if (options.paused !== undefined) params.set('paused', String(options.paused));
  params.set('limit', String(options.limit ?? 50));
  params.set('offset', String(options.offset ?? 0));

  return useQuery({
    queryKey: ['schedules', { ...options }],
    queryFn: () => api.get<SchedulesResponse>(`/schedules?${params.toString()}`),
    enabled: options.enabled ?? true,
    staleTime: 15_000,
  });
}

export function useSchedule(id: string | undefined) {
  return useQuery({
    queryKey: ['schedule', id],
    queryFn: () => api.get<ScheduleDetailResponse>(`/schedules/${id}`),
    enabled: !!id,
    staleTime: 15_000,
  });
}

export interface CronPreviewResponse {
  fires: string[];
  timezone: string;
}

/**
 * Server-side cron preview. Returns the next N fire times for a cron
 * expression. Used by the create modal + detail page to show what cadence
 * the user is about to commit to. Server-side so the UI bundle doesn't have
 * to include cron-parser.
 *
 * Disabled when expr is empty/invalid. Debounce typing in the caller —
 * this fires on every key by default.
 */
export function useCronPreview(
  expr: string | undefined,
  options: { timezone?: string; count?: number; enabled?: boolean } = {},
) {
  const enabled = (options.enabled ?? true) && !!expr && expr.length > 0;
  const params = new URLSearchParams();
  if (expr) params.set('expr', expr);
  if (options.timezone) params.set('timezone', options.timezone);
  params.set('count', String(options.count ?? 3));
  return useQuery({
    queryKey: ['cron-preview', expr, options.timezone, options.count],
    queryFn: () =>
      api.get<CronPreviewResponse>(`/schedules/cron-preview?${params.toString()}`),
    enabled,
    // Cron parse is deterministic; cache aggressively per (expr, tz).
    staleTime: 60_000,
    retry: false,
  });
}

// ============================================================================
// Mutations
// ============================================================================

export function useCreateSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateScheduleInput) =>
      api.post<{ schedule: Schedule }>('/schedules', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['schedules'] });
    },
  });
}

export function useUpdateSchedule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateScheduleInput) =>
      api.patch<{ schedule: Schedule }>(`/schedules/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['schedules'] });
      qc.invalidateQueries({ queryKey: ['schedule', id] });
    },
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ ok: true }>(`/schedules/${id}`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: ['schedules'] });
      qc.invalidateQueries({ queryKey: ['schedule', id] });
    },
  });
}

export function usePauseSchedule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) =>
      api.post<{ schedule: Schedule }>(`/schedules/${id}/pause`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['schedules'] });
      qc.invalidateQueries({ queryKey: ['schedule', id] });
    },
  });
}

export function useResumeSchedule(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ schedule: Schedule }>(`/schedules/${id}/resume`, undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['schedules'] });
      qc.invalidateQueries({ queryKey: ['schedule', id] });
    },
  });
}
