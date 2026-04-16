import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface Spec {
  id: string;
  resource_id: string;
  resource_name: string;
  swarm_id: string | null;
  swarm_name: string | null;
  title: string;
  content: string | null;
  status: string | null;
  priority: number | undefined;
  archived: boolean;
  created_at: string | null;
  updated_at: string | null;
  uri: string | null;
  source: 'local' | 'remote';
}

export interface SpecsResponse {
  data: Spec[];
  total: number;
  limit: number;
  offset: number;
  errors?: Array<{ resource_id: string; message: string }>;
}

/** Lightweight neighbor record returned in the spec detail response. */
export interface LinkedNode {
  id: string;
  type?: string;
  title?: string;
  content?: string;
  status?: string;
  priority?: number;
  archived?: boolean | number;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface SpecEdge {
  from_id: string;
  to_id: string;
  type: string;
}

export interface SpecDetailResponse {
  spec: Spec;
  raw: Record<string, unknown>;
  linked: {
    tasks: LinkedNode[];
    contexts: LinkedNode[];
    feedback: LinkedNode[];
    specs: LinkedNode[];
    issues: LinkedNode[];
    other: LinkedNode[];
  };
  edges: SpecEdge[];
}

export function useSpecs(options?: {
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
  resourceId?: string;
}) {
  const { limit = 50, offset = 0, includeArchived = false, resourceId } = options ?? {};

  return useQuery({
    queryKey: ['specs', { limit, offset, includeArchived, resourceId }],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (includeArchived) params.set('include_archived', 'true');
      if (resourceId) params.set('resource_id', resourceId);
      return api.get<SpecsResponse>(`/specs?${params}`);
    },
    staleTime: 30_000,
  });
}

export function useSpec(resourceId: string | undefined, specId: string | undefined) {
  return useQuery({
    queryKey: ['spec', resourceId, specId],
    queryFn: () => api.get<SpecDetailResponse>(`/specs/${resourceId}/${specId}`),
    enabled: !!resourceId && !!specId,
    staleTime: 30_000,
  });
}

export interface CreateSpecInput {
  resource_id: string;
  title: string;
  content?: string;
  priority?: number;
}

export interface UpdateSpecInput {
  title?: string;
  content?: string | null;
  priority?: number | null;
  archived?: boolean;
  status?: string;
}

export function useCreateSpec() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSpecInput) =>
      api.post<{ spec: Spec }>('/specs', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['specs'] }),
  });
}

export function useUpdateSpec(resourceId: string, specId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSpecInput) =>
      api.patch<{ spec: Spec }>(`/specs/${resourceId}/${specId}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spec', resourceId, specId] });
      qc.invalidateQueries({ queryKey: ['specs'] });
    },
  });
}

export const EDGE_TYPES = [
  'blocks', 'implements', 'references', 'related', 'parent-of',
  'child-of', 'duplicates', 'supersedes', 'depends-on', 'discovered-from',
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export interface LinkSpecInput {
  target_id: string;
  type: EdgeType;
  direction?: 'inbound' | 'outbound';
}

export function useLinkSpec(resourceId: string, specId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LinkSpecInput) =>
      api.post<{ edge_id: string; from_id: string; to_id: string; type: string }>(
        `/specs/${resourceId}/${specId}/links`,
        input,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spec', resourceId, specId] });
    },
  });
}

export function useUnlinkSpec(resourceId: string, specId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { target_id: string; type: EdgeType }) =>
      fetch(`/api/v1/specs/${resourceId}/${specId}/links`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }).then(async (r) => {
        if (!r.ok) {
          const err = await r.json().catch(() => ({ message: `HTTP ${r.status}` }));
          throw new Error(err.message || err.error || `HTTP ${r.status}`);
        }
        return r.json();
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spec', resourceId, specId] });
    },
  });
}
