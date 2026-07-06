import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface IdeaLabRole {
  idealab_key: string;
  cron: string;
  paused: boolean;
  next_fires_at: string | null;
  target_swarm_ids?: string[];
}

export interface IdeaLabStatus {
  loaded: boolean;
  paused: boolean;
  roles: IdeaLabRole[];
}

export interface IdeaLabSetupBody {
  targetSwarmIds?: string[];
  gitRemote?: string;
  hiveId?: string;
  reconcile?: 'managed' | 'create-only';
  objectives?: Array<{ title: string; content?: string; priority?: number }>;
}

export interface IdeaLabSummary {
  ok: boolean;
  deferred: boolean;
  objectives: { created: number; existing: number };
  schedules: { created: number; updated: number; unchanged: number; paused: number };
  warnings: string[];
}

export function useIdeaLabStatus() {
  return useQuery({
    queryKey: ['idea-lab'],
    queryFn: () => api.get<IdeaLabStatus>('/admin/idea-lab'),
  });
}

export function useSetupIdeaLab() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IdeaLabSetupBody) => api.post<IdeaLabSummary>('/admin/idea-lab/setup', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['idea-lab'] });
      qc.invalidateQueries({ queryKey: ['schedules'] });
    },
  });
}

export function useTeardownIdeaLab() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ paused: number; total: number }>('/admin/idea-lab/teardown', undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['idea-lab'] });
      qc.invalidateQueries({ queryKey: ['schedules'] });
    },
  });
}
