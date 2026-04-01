import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

// ── Types ──

export interface LearningStats {
  memory: {
    experienceCount: number;
    playbookCount: number;
    metaObservationCount: number;
  };
  learning: {
    trajectoriesProcessed: number;
    pendingTrajectories: number;
  };
  skillLibrary?: {
    coreSkillCount: number;
    domainSkillCounts: Record<string, number>;
  };
}

export interface Playbook {
  id: string;
  name: string;
  confidence: number;
  complexity: string;
  estimatedEffort?: number;
  applicability: {
    situations: string[];
    triggers: string[];
    antiPatterns: string[];
    domains: string[];
  };
  guidance: {
    strategy: string;
    tactics: string[];
    steps?: string[];
    codeExample?: string;
  };
  verification: {
    successIndicators: string[];
    failureIndicators: string[];
    rollbackStrategy?: string;
  };
  evolution: {
    version: string;
    successCount: number;
    failureCount: number;
    lastUsed?: string;
    refinements: Array<{ context: string; addition: string; source: string }>;
  };
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeNote {
  frontmatter: {
    id: string;
    type: 'observation' | 'entity' | 'domain-summary';
    domain: string[];
    entities: string[];
    tags: string[];
    confidence: number;
    created: string;
    updated: string;
  };
  body: string;
  filePath: string;
}

export interface Experience {
  id: string;
  task: { domain: string; description: string };
  outcome: { success: boolean };
  agentId: string;
  timestamp: string;
  totalTokens: number;
}

export interface LearningHealth {
  available: boolean;
  reason?: string;
  agentic_compute?: boolean;
  trajectories_processed?: number;
  pending_trajectories?: number;
  experience_count?: number;
  playbook_count?: number;
  session_banks: Array<{
    index: number;
    available: boolean;
    processed: number;
  }>;
  maintenance: {
    scheduled: boolean;
    schedule?: string;
    auto_run?: boolean;
  };
  distributed?: {
    mode: 'local' | 'centralized' | 'domain-partitioned';
    local_processing: boolean;
    forwarding_to?: string;
    domain_routing?: Record<string, string>;
    health: {
      local_atlas_available: boolean;
      remote_hive_reachable?: boolean;
      last_forward_at?: string;
      last_forward_error?: string;
    };
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

// ── Query Hooks ──

export function useLearningStats() {
  return useQuery({
    queryKey: ['learning-stats'],
    queryFn: () => api.get<LearningStats>('/learning/stats'),
    retry: false,
  });
}

export function useLearningHealth() {
  return useQuery({
    queryKey: ['learning-health'],
    queryFn: () => api.get<LearningHealth>('/learning/health'),
    refetchInterval: 30_000, // Refresh every 30s for monitoring
  });
}

export function useLearningPlaybooks(options?: {
  domain?: string;
  sort?: 'confidence' | 'recency' | 'usage';
  limit?: number;
  offset?: number;
}) {
  const { domain, sort = 'confidence', limit = 50, offset = 0 } = options || {};

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  params.set('sort', sort);
  if (domain) params.set('domain', domain);

  return useQuery({
    queryKey: ['learning-playbooks', { domain, sort, limit, offset }],
    queryFn: () => api.get<PaginatedResponse<Playbook>>(`/learning/playbooks?${params}`),
    retry: false,
  });
}

export function useLearningPlaybook(id: string) {
  return useQuery({
    queryKey: ['learning-playbook', id],
    queryFn: () => api.get<Playbook>(`/learning/playbooks/${id}`),
    enabled: !!id,
    retry: false,
  });
}

export function useLearningKnowledge(options?: {
  search?: string;
  type?: string;
  domain?: string;
  limit?: number;
  offset?: number;
}) {
  const { search, type, domain, limit = 50, offset = 0 } = options || {};

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (search) params.set('search', search);
  if (type) params.set('type', type);
  if (domain) params.set('domain', domain);

  return useQuery({
    queryKey: ['learning-knowledge', { search, type, domain, limit, offset }],
    queryFn: () => api.get<PaginatedResponse<KnowledgeNote>>(`/learning/knowledge?${params}`),
    retry: false,
  });
}

export function useLearningExperiences(options?: {
  domain?: string;
  limit?: number;
  offset?: number;
}) {
  const { domain, limit = 50, offset = 0 } = options || {};

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (domain) params.set('domain', domain);

  return useQuery({
    queryKey: ['learning-experiences', { domain, limit, offset }],
    queryFn: () => api.get<PaginatedResponse<Experience>>(`/learning/experiences?${params}`),
    retry: false,
  });
}

export interface LearningActivityEvent {
  id: string;
  type: 'instant' | 'batch' | 'maintenance' | 'ingestion';
  timestamp: string;
  summary: string;
  data?: Record<string, unknown>;
}

export function useLearningActivity(options?: { limit?: number; offset?: number }) {
  const { limit = 50, offset = 0 } = options || {};

  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));

  return useQuery({
    queryKey: ['learning-activity', { limit, offset }],
    queryFn: () => api.get<PaginatedResponse<LearningActivityEvent>>(`/learning/activity?${params}`),
    retry: false,
  });
}

// ── Mutation Hooks ──

export function useTriggerBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/learning/batch'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['learning-stats'] });
      queryClient.invalidateQueries({ queryKey: ['learning-playbooks'] });
      queryClient.invalidateQueries({ queryKey: ['learning-experiences'] });
      queryClient.invalidateQueries({ queryKey: ['learning-health'] });
    },
  });
}

export function useTriggerMaintenance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/learning/maintenance'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['learning-stats'] });
      queryClient.invalidateQueries({ queryKey: ['learning-knowledge'] });
      queryClient.invalidateQueries({ queryKey: ['learning-health'] });
    },
  });
}
