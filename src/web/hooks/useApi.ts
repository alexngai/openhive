import {
  useQuery,
  useMutation,
  useQueryClient,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { api, Post, Comment, Hive, PaginatedResponse } from "../lib/api";
import type {
  Agent,
  HostedSwarm,
  MapSwarm,
  MapNode,
  MapStats,
  SwarmMessage,
  SharedContext,
  SwarmPeer,
  SyncableResource,
  SyncStatusResponse,
  ResourceSyncEvent,
  CheckUpdatesResult,
  BatchCheckResult,
  MemoryFile,
  MemoryFileContent,
  MemorySearchResult,
  MemoryEntry,
  KnowledgeGraphData,
  KnowledgeSearchResult,
  SkillGraphNode,
  SkillGraphEdge,
  SkillVersion,
  SkillSummary,
  SkillDetail,
  SkillWritePayload,
  ImportPayload,
  ImportResult,
  LoadoutProfile,
  LoadoutStateResponse,
  LoadoutRenderResponse,
  CompileLoadoutPayload,
  IndexerSkillSource,
  ScrapeAndIndexResult,
  IndexerTaxonomyNode,
  IndexerStats,
  IndexerStatus,
  PostRule,
  EventSubscription,
  DeliveryLogEntry,
  TrajectoryCheckpoint,
  SessionStats,
  SessionListItem,
  SessionEventsResponse,
  MailConversation,
  MailTurn,
  MailThread,
  ConnectionHealth,
  ConnectionsResponse,
} from "../lib/api";

// Posts
export function usePosts(options: {
  hive?: string;
  sort?: "hot" | "new" | "top";
  limit?: number;
}) {
  const { hive, sort = "hot", limit = 25 } = options;

  return useInfiniteQuery({
    queryKey: ["posts", { hive, sort }],
    queryFn: async ({ pageParam = 0 }) => {
      const params = new URLSearchParams({
        sort,
        limit: String(limit),
        offset: String(pageParam),
      });
      if (hive) params.set("hive", hive);

      return api.get<PaginatedResponse<Post>>(`/posts?${params}`);
    },
    getNextPageParam: (lastPage, allPages) => {
      const totalFetched = allPages.reduce(
        (sum, page) => sum + page.data.length,
        0,
      );
      return lastPage.data.length === limit ? totalFetched : undefined;
    },
    initialPageParam: 0,
  });
}

export function usePost(postId: string) {
  return useQuery({
    queryKey: ["post", postId],
    queryFn: () => api.get<{ data: Post }>(`/posts/${postId}`),
    select: (data) => data.data,
    enabled: !!postId,
  });
}

export function useCreatePost() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      hive: string;
      title: string;
      content?: string;
      url?: string;
    }) => api.post<{ data: Post }>("/posts", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
  });
}

export function useVote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      targetType,
      targetId,
      value,
    }: {
      targetType: "post" | "comment";
      targetId: string;
      value: 1 | -1 | 0;
    }) => api.post(`/${targetType}s/${targetId}/vote`, { value }),
    onMutate: async ({ targetType, targetId, value }) => {
      // Optimistic update
      await queryClient.cancelQueries({ queryKey: [targetType, targetId] });
      const previousData = queryClient.getQueryData([targetType, targetId]);

      queryClient.setQueryData(
        [targetType, targetId],
        (old: { data: Post | Comment } | undefined) => {
          if (!old) return old;
          const item = old.data;
          const prevVote = item.user_vote || 0;
          const scoreDelta = value - prevVote;
          return {
            data: {
              ...item,
              score: item.score + scoreDelta,
              user_vote: value === 0 ? null : value,
            },
          };
        },
      );

      return { previousData };
    },
    onError: (_err, { targetType, targetId }, context) => {
      if (context?.previousData) {
        queryClient.setQueryData([targetType, targetId], context.previousData);
      }
    },
  });
}

// Comments
export function useComments(
  postId: string,
  sort: "top" | "new" | "old" = "top",
) {
  return useQuery({
    queryKey: ["comments", postId, sort],
    queryFn: () =>
      api.get<{ data: Comment[] }>(`/posts/${postId}/comments?sort=${sort}`),
    select: (data) => data.data,
    enabled: !!postId,
  });
}

export function useCreateComment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      postId,
      content,
      parentId,
    }: {
      postId: string;
      content: string;
      parentId?: string;
    }) =>
      api.post<{ data: Comment }>(`/posts/${postId}/comments`, {
        content,
        parent_id: parentId,
      }),
    onSuccess: (_, { postId }) => {
      queryClient.invalidateQueries({ queryKey: ["comments", postId] });
      queryClient.invalidateQueries({ queryKey: ["post", postId] });
    },
  });
}

// Hives
export function useHives(options?: {
  sort?: "popular" | "new" | "alphabetical";
  limit?: number;
}) {
  const { sort = "popular", limit = 50 } = options || {};

  return useQuery({
    queryKey: ["hives", { sort, limit }],
    queryFn: () =>
      api.get<PaginatedResponse<Hive>>(`/hives?sort=${sort}&limit=${limit}`),
    select: (data) => data.data,
  });
}

export function useHive(name: string) {
  return useQuery({
    queryKey: ["hive", name],
    queryFn: () => api.get<{ data: Hive }>(`/hives/${name}`),
    select: (data) => data.data,
    enabled: !!name,
  });
}

export function useJoinHive() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (hiveName: string) => api.post(`/hives/${hiveName}/join`),
    onSuccess: (_, hiveName) => {
      queryClient.invalidateQueries({ queryKey: ["hive", hiveName] });
    },
  });
}

export function useLeaveHive() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (hiveName: string) => api.delete(`/hives/${hiveName}/leave`),
    onSuccess: (_, hiveName) => {
      queryClient.invalidateQueries({ queryKey: ["hive", hiveName] });
    },
  });
}

// Agents
export function useAgents(options?: {
  limit?: number;
  verified_only?: boolean;
}) {
  const { limit = 50, verified_only } = options || {};

  return useQuery({
    queryKey: ["agents", { limit, verified_only }],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (verified_only) params.set("verified_only", "true");
      return api.get<PaginatedResponse<Agent>>(`/agents?${params}`);
    },
    select: (data) => data.data,
  });
}

export function useAgent(name: string) {
  return useQuery({
    queryKey: ["agent", name],
    queryFn: () => api.get<{ data: Agent }>(`/agents/${name}`),
    select: (data) => data.data,
    enabled: !!name,
  });
}

export function useAgentPosts(name: string) {
  return useQuery({
    queryKey: ["agent-posts", name],
    queryFn: () =>
      api.get<PaginatedResponse<Post>>(`/agents/${name}/posts?limit=20`),
    select: (data) => data.data,
    enabled: !!name,
  });
}

export function useFollowAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (agentName: string) => api.post(`/agents/${agentName}/follow`),
    onMutate: async (agentName) => {
      // Optimistically update the agent's is_following status
      await queryClient.cancelQueries({ queryKey: ["agent", agentName] });
      const previousAgent = queryClient.getQueryData(["agent", agentName]);

      queryClient.setQueryData(
        ["agent", agentName],
        (old: Agent | undefined) => {
          if (!old) return old;
          return {
            ...old,
            is_following: true,
            follower_count: (old.follower_count || 0) + 1,
          };
        },
      );

      return { previousAgent };
    },
    onError: (_err, agentName, context) => {
      if (context?.previousAgent) {
        queryClient.setQueryData(["agent", agentName], context.previousAgent);
      }
    },
    onSettled: (_, __, agentName) => {
      queryClient.invalidateQueries({ queryKey: ["agent", agentName] });
    },
  });
}

export function useUnfollowAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (agentName: string) =>
      api.delete(`/agents/${agentName}/follow`),
    onMutate: async (agentName) => {
      // Optimistically update the agent's is_following status
      await queryClient.cancelQueries({ queryKey: ["agent", agentName] });
      const previousAgent = queryClient.getQueryData(["agent", agentName]);

      queryClient.setQueryData(
        ["agent", agentName],
        (old: Agent | undefined) => {
          if (!old) return old;
          return {
            ...old,
            is_following: false,
            follower_count: Math.max(0, (old.follower_count || 0) - 1),
          };
        },
      );

      return { previousAgent };
    },
    onError: (_err, agentName, context) => {
      if (context?.previousAgent) {
        queryClient.setQueryData(["agent", agentName], context.previousAgent);
      }
    },
    onSettled: (_, __, agentName) => {
      queryClient.invalidateQueries({ queryKey: ["agent", agentName] });
    },
  });
}

// Search
export function useSearch(query: string, type?: string) {
  return useQuery({
    queryKey: ["search", query, type],
    queryFn: () => {
      const params = new URLSearchParams({ q: query });
      if (type) params.set("type", type);
      return api.get<{
        results: {
          posts: Post[];
          comments: Comment[];
          agents: Agent[];
          hives: Hive[];
        };
        total: Record<string, number>;
      }>(`/search?${params}`);
    },
    enabled: query.length >= 2,
  });
}

// Hosted Swarms
export function useHostedSwarms(options?: { state?: string; mine?: boolean }) {
  const { state, mine } = options || {};

  return useQuery({
    queryKey: ["hosted-swarms", { state, mine }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (state) params.set("state", state);
      if (mine) params.set("mine", "true");
      return api.get<{ data: HostedSwarm[]; total: number }>(
        `/map/hosted?${params}`,
      );
    },
    select: (data) => data.data,
    staleTime: 30_000,
  });
}

export function useSpawnSwarm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      name: string;
      description?: string;
      adapter?: string;
      adapter_config?: Record<string, unknown>;
      hive?: string;
      provider?: string;
      metadata?: Record<string, unknown>;
      workspace?: {
        repos: Array<{
          url: string;
          branch?: string;
          path?: string;
          depth?: number;
        }>;
      };
    }) => api.post<HostedSwarm>("/map/hosted/spawn", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hosted-swarms"] });
    },
  });
}

export function useStopSwarm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.post(`/map/hosted/${id}/stop`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hosted-swarms"] });
    },
  });
}

export function useRestartSwarm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.post(`/map/hosted/${id}/restart`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hosted-swarms"] });
    },
  });
}

export function useRemoveSwarm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/map/hosted/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hosted-swarms"] });
    },
  });
}

export function useSwarmLogs(id: string | null) {
  return useQuery({
    queryKey: ["swarm-logs", id],
    queryFn: async () => {
      const url = `/api/v1/map/hosted/${id}/logs`;
      const headers: HeadersInit = {};
      const token = api.getToken();
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error("Failed to fetch logs");
      return res.text();
    },
    enabled: !!id,
    refetchInterval: 5000, // Poll logs every 5s when viewing
  });
}

// MAP-registered Swarms (includes both hosted and externally connected)
export function useMapSwarms() {
  return useQuery({
    queryKey: ["map-swarms"],
    queryFn: () => api.get<{ data: MapSwarm[]; total: number }>("/map/swarms"),
    select: (data) => data.data,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useMapSwarmsForPicker(opts?: { status?: string; recency_days?: number }) {
  const params = new URLSearchParams({ dedupe: '1' });
  if (opts?.status) params.set('status', opts.status);
  if (opts?.recency_days) params.set('recency_days', String(opts.recency_days));
  return useQuery({
    queryKey: ['map-swarms-picker', opts],
    queryFn: () =>
      api.get<{ data: (MapSwarm & { variant_count?: number })[]; total: number }>(
        `/map/swarms?${params}`,
      ),
    select: (data) => data.data,
    staleTime: 30_000,
  });
}

export function useMapSwarm(id: string) {
  return useQuery({
    queryKey: ["map-swarm", id],
    queryFn: () => api.get<MapSwarm>(`/map/swarms/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useMapNodes(options?: { swarm_id?: string }) {
  const params = new URLSearchParams();
  if (options?.swarm_id) params.set("swarm_id", options.swarm_id);
  const qs = params.toString();

  return useQuery({
    queryKey: ["map-nodes", options],
    queryFn: () =>
      api.get<{ data: MapNode[]; total: number }>(
        `/map/nodes${qs ? `?${qs}` : ""}`,
      ),
    select: (data) => data.data,
    staleTime: 30_000,
  });
}

export function useConnectSwarm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      name: string;
      description?: string;
      map_endpoint: string;
      map_transport?: "websocket" | "http-sse" | "ndjson";
      capabilities?: {
        observation?: boolean;
        messaging?: boolean;
        lifecycle?: boolean;
      };
      auth_method?: "bearer" | "api-key" | "mtls" | "none";
      auth_token?: string;
      metadata?: Record<string, unknown>;
    }) => api.post<{ swarm: MapSwarm }>("/map/swarms", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["map-swarms"] });
    },
  });
}

// Connection health hooks
export function useConnectionHealth(swarmId: string) {
  return useQuery({
    queryKey: ["connection-health", swarmId],
    queryFn: () => api.get<ConnectionHealth>(`/map/connections/${swarmId}`),
    enabled: !!swarmId,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useAllConnections() {
  return useQuery({
    queryKey: ["connections"],
    queryFn: () => api.get<ConnectionsResponse>("/map/connections"),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

// Dashboard hooks
export function useMapStats() {
  return useQuery({
    queryKey: ["map-stats"],
    queryFn: () => api.get<MapStats>("/map/stats"),
  });
}

export function useResources(options?: { type?: string; limit?: number }) {
  const { type, limit = 10 } = options || {};

  return useQuery({
    queryKey: ["resources", { type, limit }],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (type) params.set("type", type);
      return api.get<{ data: SyncableResource[]; total: number }>(
        `/resources?${params}`,
      );
    },
  });
}

export function useSyncStatus() {
  return useQuery({
    queryKey: ["sync-status"],
    queryFn: () => api.get<SyncStatusResponse>("/sync/status"),
  });
}

// Resources (extended)
export function useResourcesByType(
  type: "memory_bank" | "skill" | "task",
  options?: { limit?: number },
) {
  const { limit = 50 } = options || {};

  return useQuery({
    queryKey: ["resources", { type, limit }],
    queryFn: () => {
      const params = new URLSearchParams({ limit: String(limit), type });
      return api.get<{ data: SyncableResource[]; total: number }>(
        `/resources?${params}`,
      );
    },
  });
}

export function useResource(id: string) {
  return useQuery({
    queryKey: ["resource", id],
    queryFn: () => api.get<SyncableResource>(`/resources/${id}`),
    enabled: !!id,
  });
}

export function useResourceEvents(id: string, options?: { limit?: number }) {
  const { limit = 20 } = options || {};

  return useQuery({
    queryKey: ["resource-events", id, { limit }],
    queryFn: () =>
      api.get<{ data: ResourceSyncEvent[]; total: number }>(
        `/resources/${id}/events?limit=${limit}`,
      ),
    enabled: !!id,
  });
}

export function useCheckUpdates() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      resourceId,
      branch,
    }: {
      resourceId: string;
      branch?: string;
    }) =>
      api.post<CheckUpdatesResult>(`/resources/${resourceId}/check-updates`, {
        branch,
      }),
    onSuccess: (_, { resourceId }) => {
      queryClient.invalidateQueries({ queryKey: ["resource", resourceId] });
      queryClient.invalidateQueries({
        queryKey: ["resource-events", resourceId],
      });
      queryClient.invalidateQueries({ queryKey: ["resources"] });
    },
  });
}

export function useBatchCheckUpdates() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      resource_type?: "memory_bank" | "skill";
      branch?: string;
    }) => api.post<BatchCheckResult>("/resources/check-updates", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      queryClient.invalidateQueries({ queryKey: ["resource-events"] });
    },
  });
}

// Resource Content - Memory Banks
export function useMemoryFiles(resourceId: string) {
  return useQuery({
    queryKey: ["memory-files", resourceId],
    queryFn: () =>
      api.get<{ files: MemoryFile[] }>(
        `/resources/${resourceId}/content/files`,
      ),
    select: (data) => data.files,
    enabled: !!resourceId,
  });
}

export function useMemoryFile(resourceId: string, path: string | null) {
  return useQuery({
    queryKey: ["memory-file", resourceId, path],
    queryFn: () =>
      api.get<MemoryFileContent>(
        `/resources/${resourceId}/content/file?path=${encodeURIComponent(path!)}`,
      ),
    enabled: !!resourceId && !!path,
  });
}

export function useMemorySearch(resourceId: string, query: string) {
  return useQuery({
    queryKey: ["memory-search", resourceId, query],
    queryFn: () =>
      api.get<{ results: MemorySearchResult[]; total: number }>(
        `/resources/${resourceId}/content/search?q=${encodeURIComponent(query)}&limit=30`,
      ),
    enabled: !!resourceId && query.length >= 2,
  });
}

export function useMemoryEntries(resourceId: string) {
  return useQuery({
    queryKey: ["memory-entries", resourceId],
    queryFn: () =>
      api.get<{ entries: MemoryEntry[] }>(
        `/resources/${resourceId}/content/entries`,
      ),
    select: (data) => data.entries,
    enabled: !!resourceId,
  });
}

export function useKnowledgeGraph(
  resourceId: string,
  noteId: string | null,
  depth = 2,
) {
  return useQuery({
    queryKey: ["knowledge-graph", resourceId, noteId, depth],
    queryFn: () =>
      api.get<KnowledgeGraphData>(
        `/resources/${resourceId}/content/knowledge/graph?note_id=${encodeURIComponent(noteId!)}&depth=${depth}&direction=both`,
      ),
    enabled: !!resourceId && !!noteId,
  });
}

export function useKnowledgeGraphFull(resourceId: string) {
  return useQuery({
    queryKey: ["knowledge", resourceId, "full"],
    queryFn: () =>
      api.get<{ results: KnowledgeSearchResult[]; total: number }>(
        `/resources/${resourceId}/content/knowledge`,
      ),
    enabled: !!resourceId,
  });
}

// Resource Content - Skills
export function useSkillsList(resourceId: string) {
  return useQuery({
    queryKey: ["skills-list", resourceId],
    queryFn: () =>
      api.get<{ skills: SkillSummary[] }>(
        `/resources/${resourceId}/content/skills`,
      ),
    select: (data) => data.skills,
    enabled: !!resourceId,
  });
}

export function useSkillDetail(resourceId: string, skillId: string | null) {
  return useQuery({
    queryKey: ["skill-detail", resourceId, skillId],
    queryFn: () =>
      api.get<SkillDetail>(
        `/resources/${resourceId}/content/skills/${skillId}`,
      ),
    enabled: !!resourceId && !!skillId,
  });
}

export function useSkillGraph(resourceId: string) {
  return useQuery({
    queryKey: ["skill-graph", resourceId],
    queryFn: () =>
      api.get<{ nodes: SkillGraphNode[]; edges: SkillGraphEdge[] }>(
        `/resources/${resourceId}/content/skills/graph`,
      ),
    enabled: !!resourceId,
  });
}

export function useSkillVersions(resourceId: string, skillId: string | null) {
  return useQuery({
    queryKey: ["skill-versions", resourceId, skillId],
    queryFn: () =>
      api.get<{ skillId: string; versions: SkillVersion[] }>(
        `/resources/${resourceId}/content/skills/${skillId}/versions`,
      ),
    enabled: !!resourceId && !!skillId,
  });
}

export function useSkillSearch(resourceId: string, query: string) {
  return useQuery({
    queryKey: ["skill-search", resourceId, query],
    queryFn: () =>
      api.get<{
        results: Array<{
          id: string;
          name: string | null;
          description: string | null;
          score: number | null;
        }>;
        total: number;
      }>(
        `/resources/${resourceId}/content/skills/search?q=${encodeURIComponent(query)}&limit=20`,
      ),
    enabled: !!resourceId && query.length >= 2,
  });
}

// Resource Content - Skill Management (CRUD + Import + Loadout)

export function useCreateSkill(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: SkillWritePayload) =>
      api.post<{ id: string; created: boolean }>(
        `/resources/${resourceId}/skills`,
        payload,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills-list", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["skill-graph", resourceId] });
    },
  });
}

export function useUpdateSkill(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, ...payload }: Partial<SkillWritePayload> & { skillId: string }) =>
      api.put<{ id: string; updated: boolean }>(
        `/resources/${resourceId}/skills/${skillId}`,
        payload,
      ),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["skills-list", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["skill-detail", resourceId, vars.skillId] });
      queryClient.invalidateQueries({ queryKey: ["skill-graph", resourceId] });
    },
  });
}

export function useDeleteSkill(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) =>
      api.delete(`/resources/${resourceId}/skills/${skillId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills-list", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["skill-graph", resourceId] });
    },
  });
}

export function useDeprecateSkill(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) =>
      api.post<{ id: string; status: string }>(
        `/resources/${resourceId}/skills/${skillId}/deprecate`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills-list", resourceId] });
    },
  });
}

export function useImportSkills(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ImportPayload) =>
      api.post<ImportResult>(
        `/resources/${resourceId}/skills/import`,
        payload,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills-list", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["skill-graph", resourceId] });
    },
  });
}

export function useExportSkills(resourceId: string) {
  return useMutation({
    mutationFn: () =>
      api.post<{ skills: unknown[]; stats: Record<string, unknown> }>(
        `/resources/${resourceId}/skills/export`,
      ),
  });
}

export function useBootstrapSkillBank(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ initialized: boolean; alreadyExisted: boolean; path: string }>(
        `/resources/${resourceId}/skills/bootstrap`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills-list", resourceId] });
    },
  });
}

// Loadout management

export function useLoadoutProfiles(resourceId: string) {
  return useQuery({
    queryKey: ["loadout-profiles", resourceId],
    queryFn: () =>
      api.get<{ profiles: LoadoutProfile[] }>(
        `/resources/${resourceId}/loadout/profiles`,
      ),
    select: (data) => data.profiles,
    enabled: !!resourceId,
  });
}

export function useLoadoutState(resourceId: string) {
  return useQuery({
    queryKey: ["loadout-state", resourceId],
    queryFn: () =>
      api.get<LoadoutStateResponse>(
        `/resources/${resourceId}/loadout`,
      ),
    enabled: !!resourceId,
  });
}

export function useLoadoutRender(resourceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["loadout-render", resourceId],
    queryFn: () =>
      api.get<LoadoutRenderResponse>(
        `/resources/${resourceId}/loadout/render`,
      ),
    enabled: !!resourceId && enabled,
  });
}

export function useCompileLoadout(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: CompileLoadoutPayload) =>
      api.post<LoadoutStateResponse>(
        `/resources/${resourceId}/loadout/compile`,
        payload,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["loadout-state", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["loadout-render", resourceId] });
    },
  });
}

export function useExpandLoadoutSkill(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) =>
      api.post<{ skillId: string; expanded: boolean }>(
        `/resources/${resourceId}/loadout/expand/${skillId}`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["loadout-state", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["loadout-render", resourceId] });
    },
  });
}

export function useCollapseLoadoutSkill(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillId: string) =>
      api.post<{ skillId: string; collapsed: boolean }>(
        `/resources/${resourceId}/loadout/collapse/${skillId}`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["loadout-state", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["loadout-render", resourceId] });
    },
  });
}

export function useClearLoadout(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.delete(`/resources/${resourceId}/loadout`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["loadout-state", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["loadout-render", resourceId] });
    },
  });
}

// Indexer / Scraper

export function useIndexerStatus(resourceId: string) {
  return useQuery({
    queryKey: ["indexer-status", resourceId],
    queryFn: () =>
      api.get<IndexerStatus>(
        `/resources/${resourceId}/indexer/status`,
      ),
    enabled: !!resourceId,
  });
}

export function useIndexerStats(resourceId: string) {
  return useQuery({
    queryKey: ["indexer-stats", resourceId],
    queryFn: () =>
      api.get<IndexerStats>(
        `/resources/${resourceId}/indexer/stats`,
      ),
    enabled: !!resourceId,
  });
}

export function useIndexerTaxonomy(resourceId: string) {
  return useQuery({
    queryKey: ["indexer-taxonomy", resourceId],
    queryFn: () =>
      api.get<IndexerTaxonomyNode>(
        `/resources/${resourceId}/indexer/taxonomy`,
      ),
    enabled: !!resourceId,
  });
}

export function useScrapeAndIndex(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      sources: IndexerSkillSource[];
      force?: boolean;
      autoClassify?: boolean;
      detectRelationships?: boolean;
      importAll?: boolean;
    }) =>
      api.post<ScrapeAndIndexResult>(
        `/resources/${resourceId}/indexer/scrape-and-index`,
        payload,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills-list", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["skill-graph", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["indexer-stats", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["indexer-taxonomy", resourceId] });
    },
  });
}

export function useClassifySkills(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { skillId?: string; all?: boolean; useSwarm?: boolean }) =>
      api.post<{ indexed: number; skipped: number; failed: number; errors: string[] }>(
        `/resources/${resourceId}/indexer/classify`,
        payload,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skills-list", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["indexer-stats", resourceId] });
    },
  });
}

export function useDetectRelationships(resourceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { skillId?: string; useSwarm?: boolean }) =>
      api.post<{ detected: number; skipped: number; errors: string[] }>(
        `/resources/${resourceId}/indexer/relationships`,
        payload,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["skill-graph", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["indexer-stats", resourceId] });
    },
  });
}

// ── OpenTasks ──

export function useOpenTasksSummary(resourceId: string) {
  return useQuery({
    queryKey: ["opentasks-summary", resourceId],
    queryFn: () =>
      api.get<import("../lib/api").OpenTasksGraphSummary>(
        `/resources/${resourceId}/content/opentasks/summary`,
      ),
    enabled: !!resourceId,
    staleTime: 30_000, // consider fresh for 30s — avoids refetch storms on window focus
  });
}

export function useOpenTasksReady(resourceId: string) {
  return useQuery({
    queryKey: ["opentasks-ready", resourceId],
    queryFn: () =>
      api.get<import("../lib/api").OpenTasksReadyResponse>(
        `/resources/${resourceId}/content/opentasks/ready`,
      ),
    enabled: !!resourceId,
  });
}

export function useOpenTasksGraph(resourceId: string) {
  return useQuery({
    queryKey: ["opentasks-graph", resourceId],
    queryFn: () =>
      api.get<import("../lib/api").OpenTasksGraphData>(
        `/resources/${resourceId}/content/opentasks/graph`,
      ),
    enabled: !!resourceId,
  });
}

export function useCreateOpenTask(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      title: string;
      description?: string;
      status?: string;
      priority?: number;
      assignee?: string | null;
      metadata?: Record<string, unknown>;
    }) =>
      api.post<{ node_id: string; status: string }>(
        `/resources/${resourceId}/content/opentasks/tasks`,
        data,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["opentasks-summary", resourceId],
      });
      queryClient.invalidateQueries({
        queryKey: ["opentasks-ready", resourceId],
      });
      queryClient.invalidateQueries({
        queryKey: ["opentasks-graph", resourceId],
      });
    },
  });
}

export function useUpdateOpenTaskStatus(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      nodeId,
      status,
      result,
      error,
    }: {
      nodeId: string;
      status: string;
      result?: Record<string, unknown>;
      error?: string;
    }) =>
      api.patch<{
        node_id: string;
        previous_status: string | null;
        new_status: string;
      }>(`/resources/${resourceId}/content/opentasks/tasks/${nodeId}`, {
        status,
        result,
        error,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["opentasks-summary", resourceId],
      });
      queryClient.invalidateQueries({
        queryKey: ["opentasks-ready", resourceId],
      });
      queryClient.invalidateQueries({
        queryKey: ["opentasks-graph", resourceId],
      });
    },
  });
}

// ── SwarmKit Projects ──

export function useSwarmKitProjects() {
  return useQuery({
    queryKey: ["swarmkit-projects"],
    queryFn: () =>
      api.get<{ projectRoots: string[] }>("/admin/swarmkit/projects"),
  });
}

// ── Connected Task Graphs ──

interface ConnectedTaskGraph {
  swarm_id: string;
  swarm_name: string | null;
  location_hash: string | null;
  path: string | null;
  connected_at: string;
  capabilities: Record<string, unknown> | null;
}

export function useConnectedTaskGraphs() {
  return useQuery({
    queryKey: ["connected-task-graphs"],
    queryFn: () =>
      api.get<{ data: ConnectedTaskGraph[] }>("/map/connected-task-graphs"),
    refetchInterval: 30000, // poll every 30s since these are ephemeral
  });
}

// ── Task Resource Management ──

export function useCreateTaskResource() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      name: string;
      path: string;
      description?: string;
      config?: Record<string, unknown>;
      syncStrategy?: string;
    }) =>
      api.post<import("../lib/api").SyncableResource>("/resources", {
        resource_type: "task",
        name: data.name,
        git_remote_url: data.path,
        description: data.description || undefined,
        visibility: "private",
        sync_strategy: data.syncStrategy || "metadata",
        metadata: { opentasks: true, ...(data.config ? { opentasks_config: data.config } : {}) },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resources"] });
    },
  });
}

export function useUpdateTaskResource() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      resourceId,
      data,
    }: {
      resourceId: string;
      data: {
        name?: string;
        description?: string | null;
        metadata?: Record<string, unknown>;
      };
    }) => api.patch<import("../lib/api").SyncableResource>(`/resources/${resourceId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resources"] });
    },
  });
}

export function useDeleteTaskResource() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (resourceId: string) =>
      api.delete(`/resources/${resourceId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resources"] });
    },
  });
}

export function useDeleteOpenTask(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (nodeId: string) =>
      api.delete<{ deleted: boolean; node_id: string }>(
        `/resources/${resourceId}/content/opentasks/tasks/${nodeId}`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opentasks-summary", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-ready", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-graph", resourceId] });
    },
  });
}

export function useUpdateOpenTask(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      nodeId,
      title,
      description,
      priority,
      assignee,
    }: {
      nodeId: string;
      title?: string;
      description?: string | null;
      priority?: number;
      assignee?: string | null;
    }) =>
      api.patch<{ node_id: string }>(
        `/resources/${resourceId}/content/opentasks/tasks/${nodeId}`,
        { title, description, priority, assignee },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opentasks-summary", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-graph", resourceId] });
    },
  });
}

// ── Context Nodes ──

export function useCreateContext(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { title: string; content?: string; priority?: number; tags?: string[] }) =>
      api.post<{ node_id: string; type: string }>(
        `/resources/${resourceId}/content/opentasks/contexts`,
        data,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opentasks-graph", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-summary", resourceId] });
    },
  });
}

export function useCreateContextFile(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { filePath: string; title?: string; commit?: string }) =>
      api.post<{ node_id: string; type: string }>(
        `/resources/${resourceId}/content/opentasks/context-files`,
        data,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opentasks-graph", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-summary", resourceId] });
    },
  });
}

export function useResolveContextFile(resourceId: string, nodeId: string | null) {
  return useQuery({
    queryKey: ["context-resolve", resourceId, nodeId],
    queryFn: () =>
      api.get<{ content: string; drifted: boolean; filePath: string; commit: string; contentHash: string }>(
        `/resources/${resourceId}/content/opentasks/contexts/${nodeId}/resolve`,
      ),
    enabled: !!nodeId,
    staleTime: 30_000,
  });
}

export function useCheckContextDrift(resourceId: string, nodeId: string | null) {
  return useQuery({
    queryKey: ["context-drift", resourceId, nodeId],
    queryFn: () =>
      api.get<{ drifted: boolean; currentHash: string; capturedHash?: string }>(
        `/resources/${resourceId}/content/opentasks/contexts/${nodeId}/drift`,
      ),
    enabled: !!nodeId,
    refetchInterval: 60_000,
  });
}

export function useSyncContextFile(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (nodeId: string) =>
      api.post<{ id: string; title: string }>(
        `/resources/${resourceId}/content/opentasks/contexts/${nodeId}/sync`,
        { force: true },
      ),
    onSuccess: (_data, nodeId) => {
      queryClient.invalidateQueries({ queryKey: ["context-resolve", resourceId, nodeId] });
      queryClient.invalidateQueries({ queryKey: ["context-drift", resourceId, nodeId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-graph", resourceId] });
    },
  });
}

export function useContextSummary(resourceId: string) {
  return useQuery({
    queryKey: ["opentasks-context-summary", resourceId],
    queryFn: () =>
      api.get<Record<string, unknown>>(
        `/resources/${resourceId}/content/opentasks/context-summary`,
      ),
    enabled: !!resourceId,
    staleTime: 30_000,
  });
}

// ── Task Links (dependencies) ──

export function useCreateTaskLink(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId, targetId, type }: { nodeId: string; targetId: string; type: string }) =>
      api.post<{ edge_id: string; from_id: string; to_id: string; type: string }>(
        `/resources/${resourceId}/content/opentasks/tasks/${nodeId}/links`,
        { targetId, type },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opentasks-graph", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-ready", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-summary", resourceId] });
    },
  });
}

export function useRemoveTaskLink(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ nodeId, targetId, type }: { nodeId: string; targetId: string; type: string }) =>
      api.delete<{ removed: boolean }>(
        `/resources/${resourceId}/content/opentasks/tasks/${nodeId}/links/${targetId}?type=${type}`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["opentasks-graph", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-ready", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-summary", resourceId] });
    },
  });
}

// ── Git Sync for Task Resources ──

export function useGitSyncStatus(resourceId: string, enabled: boolean, pollInterval?: number) {
  return useQuery({
    queryKey: ["git-sync-status", resourceId],
    queryFn: () =>
      api.get<{
        hasUncommittedChanges: boolean;
        unpushedCommits: number;
        unpulledCommits: number;
        localHead: string | null;
        remoteHead: string | null;
        uncommittedDetails?: {
          added: number;
          modified: number;
          deleted: number;
          linesAdded: number;
          linesDeleted: number;
        };
      }>(`/resources/${resourceId}/content/opentasks/git-status`),
    enabled,
    staleTime: 30_000,
    refetchInterval: pollInterval,
  });
}

export function useGitPush(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<{ pushed: boolean }>(`/resources/${resourceId}/content/opentasks/git-push`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["git-sync-status", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-graph", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-summary", resourceId] });
    },
  });
}

export function useGitPull(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<{ pulled: boolean; previousHead: string | null; newHead: string | null }>(
        `/resources/${resourceId}/content/opentasks/git-pull`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["git-sync-status", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-graph", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-summary", resourceId] });
    },
  });
}

export function useGitLog(resourceId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["git-log", resourceId],
    queryFn: () =>
      api.get<{ commits: Array<{ hash: string; author: string; email: string; date: string; message: string }> }>(
        `/resources/${resourceId}/content/opentasks/git-log?limit=20`,
      ),
    enabled,
    staleTime: 30_000,
  });
}

export function useGitForceFetch(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<{ previousHead: string | null; newHead: string; changed: boolean }>(
        `/resources/${resourceId}/content/opentasks/git-force-fetch`,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["git-sync-status", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["git-log", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-graph", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["opentasks-summary", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["admin-git-sync-status"] });
    },
  });
}

export function useUpdateResource(resourceId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      api.put<Record<string, unknown>>(`/resources/${resourceId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resource", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["resources"] });
      queryClient.invalidateQueries({ queryKey: ["admin-git-sync-status"] });
    },
  });
}

// ── Event Post Rules ──

export function usePostRules(hiveId?: string) {
  return useQuery({
    queryKey: ["post-rules", { hiveId }],
    queryFn: () => {
      const params = hiveId ? `?hive_id=${hiveId}` : "";
      return api.get<{ data: PostRule[] }>(`/events/post-rules${params}`);
    },
    select: (data) => data.data,
  });
}

export function useCreatePostRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      hive_id: string;
      source: string;
      event_types: string[];
      filters?: { repos?: string[]; channels?: string[]; branches?: string[] };
      normalizer?: string;
      thread_mode?: "post_per_event" | "single_thread" | "skip";
      priority?: number;
    }) => api.post<PostRule>("/events/post-rules", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["post-rules"] });
    },
  });
}

export function useUpdatePostRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string;
      source?: string;
      event_types?: string[];
      filters?: {
        repos?: string[];
        channels?: string[];
        branches?: string[];
      } | null;
      normalizer?: string;
      thread_mode?: "post_per_event" | "single_thread" | "skip";
      priority?: number;
      enabled?: boolean;
    }) => api.put<PostRule>(`/events/post-rules/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["post-rules"] });
    },
  });
}

export function useDeletePostRule() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/events/post-rules/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["post-rules"] });
    },
  });
}

// ── Event Subscriptions ──

export function useEventSubscriptions(opts?: {
  hive_id?: string;
  swarm_id?: string;
}) {
  return useQuery({
    queryKey: ["event-subscriptions", opts],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.hive_id) params.set("hive_id", opts.hive_id);
      if (opts?.swarm_id) params.set("swarm_id", opts.swarm_id);
      const qs = params.toString();
      return api.get<{ data: EventSubscription[] }>(
        `/events/subscriptions${qs ? `?${qs}` : ""}`,
      );
    },
    select: (data) => data.data,
    staleTime: 30_000,
  });
}

export function useCreateSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      hive_id: string;
      swarm_id?: string;
      source: string;
      event_types: string[];
      filters?: { repos?: string[]; channels?: string[]; branches?: string[] };
      priority?: number;
    }) => api.post<EventSubscription>("/events/subscriptions", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event-subscriptions"] });
    },
  });
}

export function useUpdateSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      id,
      ...data
    }: {
      id: string;
      source?: string;
      event_types?: string[];
      filters?: {
        repos?: string[];
        channels?: string[];
        branches?: string[];
      } | null;
      priority?: number;
      enabled?: boolean;
    }) => api.put<EventSubscription>(`/events/subscriptions/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event-subscriptions"] });
    },
  });
}

export function useDeleteSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/events/subscriptions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event-subscriptions"] });
    },
  });
}

// ── Delivery Log ──

export function useDeliveryLog(opts?: {
  delivery_id?: string;
  swarm_id?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: ["delivery-log", opts],
    queryFn: () => {
      const params = new URLSearchParams();
      if (opts?.delivery_id) params.set("delivery_id", opts.delivery_id);
      if (opts?.swarm_id) params.set("swarm_id", opts.swarm_id);
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.offset) params.set("offset", String(opts.offset));
      const qs = params.toString();
      return api.get<{ data: DeliveryLogEntry[]; total: number }>(
        `/events/delivery-log${qs ? `?${qs}` : ""}`,
      );
    },
    staleTime: 15_000,
  });
}

// ── Coordination (Messages & Contexts) ──

export function useSwarmMessages(
  swarmId: string,
  options?: { limit?: number },
) {
  const limit = options?.limit ?? 50;

  return useQuery({
    queryKey: ["swarm-messages", swarmId, { limit }],
    queryFn: () =>
      api.get<{ data: SwarmMessage[]; total: number }>(
        `/coordination/messages?swarm_id=${swarmId}&limit=${limit}`,
      ),
    enabled: !!swarmId,
    staleTime: 15_000,
  });
}

export function useSharedContexts(opts: {
  hive_id?: string;
  swarm_id?: string;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (opts.hive_id) params.set("hive_id", opts.hive_id);
  if (opts.swarm_id) params.set("swarm_id", opts.swarm_id);
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();

  return useQuery({
    queryKey: ["shared-contexts", opts],
    queryFn: () =>
      api.get<{ data: SharedContext[]; total: number }>(
        `/coordination/contexts${qs ? `?${qs}` : ""}`,
      ),
    enabled: !!opts.hive_id,
  });
}

export function useSwarmPeers(swarmId: string) {
  return useQuery({
    queryKey: ["swarm-peers", swarmId],
    queryFn: () => api.get<SwarmPeer[]>(`/map/peers/${swarmId}`),
    enabled: !!swarmId,
    retry: false,
    staleTime: 30_000,
  });
}

// ── Sessions / Trajectory ──

export function useSessionsList(options?: {
  limit?: number;
  swarm_id?: string;
}) {
  const { limit = 50, swarm_id } = options || {};

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  if (swarm_id) params.set("swarm_id", swarm_id);

  return useQuery({
    queryKey: ["sessions-overview", { limit, swarm_id }],
    queryFn: () =>
      api.get<{ data: SessionListItem[]; total: number }>(
        `/sessions/overview?${params.toString()}`,
      ),
    staleTime: 30_000,
  });
}

export function useSessionsInfinite(options?: {
  limit?: number;
  search?: string;
}) {
  const { limit = 30, search } = options || {};

  return useInfiniteQuery({
    queryKey: ["sessions-overview-infinite", { limit, search }],
    queryFn: ({ pageParam = 0 }) => {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      params.set("offset", String(pageParam));
      if (search) params.set("search", search);
      return api.get<{ data: SessionListItem[]; total: number }>(
        `/sessions/overview?${params.toString()}`,
      );
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.data.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
    initialPageParam: 0,
    staleTime: 30_000,
  });
}

export function useSessionCheckpoints(
  id: string,
  options?: { limit?: number },
) {
  const { limit = 50 } = options || {};

  return useQuery({
    queryKey: ["session-checkpoints", id, { limit }],
    queryFn: () =>
      api.get<{ data: TrajectoryCheckpoint[]; total: number }>(
        `/sessions/${id}/trajectory-checkpoints?limit=${limit}`,
      ),
    enabled: !!id,
  });
}

export function useSessionStats(id: string) {
  return useQuery({
    queryKey: ["session-stats", id],
    queryFn: () => api.get<SessionStats>(`/sessions/${id}/trajectory-stats`),
    enabled: !!id,
  });
}

export function useSessionParticipants(id: string) {
  return useQuery({
    queryKey: ["session-participants", id],
    queryFn: () =>
      api.get<{
        participants: Array<{
          id: string;
          session_resource_id: string;
          agent_id: string;
          role: string;
          joined_at: string;
          agent_name: string;
          agent_avatar_url: string | null;
        }>;
      }>(`/sessions/${id}/participants`),
    enabled: !!id,
    staleTime: 5 * 60 * 1000,
  });
}

export function useSessionEvents(
  id: string,
  options?: { limit?: number; order?: 'asc' | 'desc'; enabled?: boolean },
) {
  const { limit = 50, order = 'desc', enabled = true } = options || {};

  return useInfiniteQuery({
    queryKey: ["session-events", id, { limit, order }],
    queryFn: ({ pageParam = 0 }) =>
      api.get<SessionEventsResponse>(
        `/sessions/${id}/events?limit=${limit}&offset=${pageParam}&order=${order}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) => {
      const nextOffset = (lastPageParam as number) + limit;
      if (nextOffset >= lastPage.total) return undefined;
      return nextOffset;
    },
    enabled: !!id && enabled,
  });
}

// ── Mail (MAP Agent Inbox) ──

export function useMailConversations(options?: { status?: string }) {
  const { status } = options || {};

  return useQuery({
    queryKey: ["mail-conversations", { status }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const qs = params.toString();
      return api.get<{ conversations: MailConversation[] }>(
        `/mail/conversations${qs ? `?${qs}` : ""}`,
      );
    },
    select: (data) => data.conversations,
  });
}

export function useMailConversation(id: string) {
  return useQuery({
    queryKey: ["mail-conversation", id],
    queryFn: () =>
      api.get<{
        conversation: MailConversation;
        turns: MailTurn[];
        threads: MailThread[];
        turn_count: number;
      }>(`/mail/conversations/${id}`),
    enabled: !!id,
  });
}

export function useMailTurns(
  conversationId: string,
  options?: { thread_id?: string },
) {
  const { thread_id } = options || {};

  return useQuery({
    queryKey: ["mail-turns", conversationId, { thread_id }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (thread_id) params.set("thread_id", thread_id);
      const qs = params.toString();
      return api.get<{ turns: MailTurn[] }>(
        `/mail/conversations/${conversationId}/turns${qs ? `?${qs}` : ""}`,
      );
    },
    select: (data) => data.turns,
    enabled: !!conversationId,
  });
}

export function useSendMailTurn() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      conversationId,
      content,
      content_type,
      thread_id,
      in_reply_to,
    }: {
      conversationId: string;
      content: unknown;
      content_type?: string;
      thread_id?: string;
      in_reply_to?: string;
    }) =>
      api.post<MailTurn>(`/mail/conversations/${conversationId}/turns`, {
        content,
        content_type,
        thread_id,
        in_reply_to,
      }),
    onSuccess: (_, { conversationId }) => {
      queryClient.invalidateQueries({
        queryKey: ["mail-conversation", conversationId],
      });
      queryClient.invalidateQueries({
        queryKey: ["mail-turns", conversationId],
      });
      queryClient.invalidateQueries({ queryKey: ["mail-conversations"] });
    },
  });
}

export function useSendSessionChat() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, content }: { sessionId: string; content: string }) =>
      api.post<{ ok: boolean; conversation_id: string }>(`/sessions/${sessionId}/chat`, { content }),
    onSuccess: (_, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: ['session-events', sessionId] });
    },
  });
}

/**
 * Spawn a new agent on a swarm via its sidecar. Pure lifecycle action — no
 * session or ACP stream is created. Chain with `useConnectAcp` if you want
 * a one-click "spawn + chat" flow.
 */
export function useSpawnAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      swarmId,
      role,
      cwd,
      task,
    }: {
      swarmId: string;
      role?: string;
      cwd?: string;
      task?: string;
    }) =>
      api.post<{
        agent_id: string;
        peer_map_id: string;
        name?: string;
        role: string;
        cwd: string;
      }>(`/map/swarms/${swarmId}/agents`, {
        ...(role ? { role } : {}),
        ...(cwd ? { cwd } : {}),
        ...(task ? { task } : {}),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['map-swarm', vars.swarmId] });
      queryClient.invalidateQueries({ queryKey: ['map-swarms'] });
    },
  });
}

/**
 * Open an ACP session against an already-registered agent on a swarm.
 * `agentId` is required (pass the hub agent id or the peerMapId). Eagerly
 * creates the OpenHive session resource so the UI can navigate to it.
 */
export function useConnectAcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ swarmId, agentId, cwd }: { swarmId: string; agentId: string; cwd?: string }) =>
      api.post<{ session_resource_id: string; acp_session_id: string; acp_stream_id: string; created: boolean }>(
        '/sessions/acp-connect',
        { swarm_id: swarmId, agent_id: agentId, ...(cwd ? { cwd } : {}) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions-overview'] });
      queryClient.invalidateQueries({ queryKey: ['session-checkpoints'] });
    },
  });
}

/**
 * Stop a specific agent on a swarm. Proxies to the macro-agent's
 * `_macro/terminateAgent` extension via SwarmCraft's MAP client.
 */
export function useStopAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ swarmId, agentId, reason }: { swarmId: string; agentId: string; reason?: string }) =>
      api.post<{ success: boolean }>(
        `/map/swarms/${swarmId}/agents/${agentId}/stop`,
        { ...(reason ? { reason } : {}) },
      ),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['map-swarm', vars.swarmId] });
      queryClient.invalidateQueries({ queryKey: ['map-swarms'] });
    },
  });
}
