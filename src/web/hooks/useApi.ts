import {
  useQuery,
  useMutation,
  useQueryClient,
  useInfiniteQuery,
} from "@tanstack/react-query";
import { api, Hive, PaginatedResponse } from "../lib/api";
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

// Hives (namespace/tenancy primitive used by swarm registration + event
// subscriptions — not the social-layer hive). Kept list+lookup only.
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

/**
 * Distinct project paths recorded across registered swarms (metadata.projectPath)
 * and hosted swarm bootstrap configs (config.bootstrap.cwd). Used by the
 * Spawn Swarm dialog's project-directory autocomplete.
 */
export function useKnownProjectPaths() {
  return useQuery({
    queryKey: ["known-project-paths"],
    queryFn: () => api.get<{ paths: string[] }>("/map/known-project-paths"),
    select: (data) => data.paths,
    staleTime: 60_000,
  });
}

export function useSpawnSwarm() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      /**
       * What kind of agent process to spawn. Defaults server-side to
       * 'openswarm' for backwards compatibility. 'claude-code' routes to
       * a different spawn pipeline (claude TUI + cc-swarm plugin sidecar).
       * See docs/HOSTED_SWARM_KINDS_DESIGN.md.
       */
      kind?: 'openswarm' | 'claude-code' | 'codex';
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
      bootstrap?: {
        coordinator?: boolean;
        cwd?: string;
      };
      /**
       * Optional first-turn prompt. For claude-code, passed to `claude` as
       * a positional arg so the TUI opens with the prompt prefilled.
       */
      initial_prompt?: string;
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
    // Drop ephemeral `session swarm_*` rows — they're registrations that
    // back a single session and aren't valid dispatch / chat targets. The
    // hub returns them for dedupe/variant context; pickers don't need them.
    select: (data) => data.data.filter((s) => !s.name?.startsWith('session ')),
    // Pure WS-driven now that the HMR leak + stale-emit-closure in
    // `useWebSocket` is fixed. `useSwarmRealtime` invalidates
    // `['map-swarms-picker']` on swarm lifecycle events, which refetches
    // this query without any polling. The previous polling fallback
    // (staleTime:2s + refetchInterval:5s) was a workaround for those
    // bugs — removed once the underlying WS delivery was fixed.
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
      queryClient.invalidateQueries({ queryKey: ["map-swarms-picker"] });
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

// ============================================================================
// Git sync (opentasks-backed task resources)
// ============================================================================

export interface GitSyncMetadata {
  enabled: boolean;
  remote?: string;
  autoCommit?: boolean;
  autoPush?: boolean;
  pullOnStartup?: boolean;
  pushDebounceMs?: number;
  /** When true, hub-received MAP context events fire an immediate pull. */
  pullOnSignal?: boolean;
}

/**
 * Recent health snapshot from the resource's daemon. Present when git
 * sync is enabled AND the daemon is reachable; null otherwise.
 *
 * `lastError` being null with a non-null `lastSuccessAt` means the most
 * recent cycle succeeded. A non-null `lastError` is sticky until the
 * corresponding op (commit/pull/push) succeeds again.
 */
export interface GitSyncHealth {
  lastError: string | null;
  lastErrorAt: string | null;
  lastErrorOp: "commit" | "pull" | "push" | null;
  lastSuccessAt: string | null;
}

export interface GitSyncResponse {
  git_sync: GitSyncMetadata | null;
  health: GitSyncHealth | null;
}

export interface UpdateGitSyncResponse {
  resource: SyncableResource;
  git_sync: GitSyncMetadata;
  /**
   * Present when a running daemon picked up the new config in-place.
   * Null if the daemon wasn't reachable (flag still persists; next
   * daemon restart will apply it).
   */
  daemon_applied: { enabled: boolean; remote?: string } | null;
}

/**
 * Read the current git_sync block + live health for a resource. Only
 * meaningful on task resources backed by a local opentasks workspace.
 *
 * Refetches every 15s so operators see push failures surface without
 * having to reload the page.
 */
export function useResourceGitSync(resourceId: string | undefined) {
  return useQuery({
    queryKey: ["resource-git-sync", resourceId],
    queryFn: () =>
      api.get<GitSyncResponse>(`/resources/${resourceId}/git-sync`),
    enabled: !!resourceId,
    refetchInterval: 15000,
  });
}

export interface SyncNowResponse {
  ran: boolean;
  reason?: string;
  result?: {
    commit: { committed: boolean; hash?: string };
    pull: { pulled: boolean; hasChanges: boolean; error?: string };
    push: { pushed: boolean; error?: string };
  };
}

/**
 * Force an immediate sync cycle (commit + pull + push) on a resource's
 * daemon. Used by the "Sync now" button in the GitSyncToggle popover to
 * let operators verify their auth + remote config without waiting for
 * the auto-sync debounce.
 */
export function useRunGitSyncNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (resourceId: string) =>
      api.post<SyncNowResponse>(`/resources/${resourceId}/git-sync/run`, {}),
    onSuccess: (_data, resourceId) => {
      // Refetch git-sync data so the new health snapshot lands in the UI.
      queryClient.invalidateQueries({ queryKey: ["resource-git-sync", resourceId] });
    },
  });
}

/**
 * Toggle git_sync on/off for a resource. PATCH writes the metadata,
 * writes the opentasks daemon's `.opentasks/config.json`, and attempts
 * a live sync.reload on the daemon so the change takes effect without
 * a restart (see `daemon_applied` on the response).
 */
export function useUpdateResourceGitSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      resourceId,
      gitSync,
    }: {
      resourceId: string;
      gitSync: GitSyncMetadata;
    }) =>
      api.patch<UpdateGitSyncResponse>(
        `/resources/${resourceId}/git-sync`,
        gitSync,
      ),
    onSuccess: (_data, { resourceId }) => {
      queryClient.invalidateQueries({ queryKey: ["resource-git-sync", resourceId] });
      queryClient.invalidateQueries({ queryKey: ["resource", resourceId] });
    },
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

/**
 * Bulk-resolve agent profiles by id. Shared across chat surfaces to
 * decorate user/supervisor turns with real names + avatars. Returns a Map
 * keyed by agent id; unknown ids are simply absent from the map so callers
 * can default to a generic "user" fallback.
 *
 * Caching: react-query keys on the sorted id list, so two callers asking
 * for overlapping sets still share cached entries. staleTime is long (5 min)
 * since agent profile data rarely changes and chat surfaces re-ask on every
 * message list refresh.
 */
export function useAgentLookup(ids: string[]) {
  const unique = Array.from(new Set(ids.filter(Boolean))).sort();
  return useQuery({
    queryKey: ["agents-by-ids", unique.join(",")],
    queryFn: async () => {
      if (unique.length === 0) return {} as Record<string, Agent>;
      const qs = `?ids=${encodeURIComponent(unique.join(","))}`;
      const res = await api.get<{ agents: Record<string, Agent> }>(`/agents/by-ids${qs}`);
      return res.agents ?? {};
    },
    staleTime: 5 * 60 * 1000,
    enabled: unique.length > 0,
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

export type SpawnAgentPermissionMode = 'auto-approve' | 'auto-deny' | 'callback' | 'interactive';

export interface SpawnAgentConfig {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  env?: Record<string, string>;
  mcpServers?: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>;
}

export interface SpawnAgentRequest {
  swarmId: string;
  role?: string;
  cwd?: string;
  task?: string;
  // Advanced SpawnAgentOptions — all optional. Backend forwards them to
  // macro-agent's _macro/spawnAgent handler which applies defaults if unset.
  permissionMode?: SpawnAgentPermissionMode;
  agentType?: string;
  customPrompt?: string;
  topics?: string[];
  config?: SpawnAgentConfig;
  taskRef?: { resource_id: string; node_id: string };
}

/**
 * Spawn a new agent on a swarm via its sidecar. Pure lifecycle action — no
 * session or ACP stream is created. Chain with `useConnectAcp` if you want
 * a one-click "spawn + chat" flow.
 */
export function useSpawnAgent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (req: SpawnAgentRequest) => {
      const { swarmId, ...body } = req;
      // Strip undefined fields so macro-agent defaults apply (vs. receiving
      // an explicit `undefined` which would override them).
      const cleanBody = Object.fromEntries(
        Object.entries(body).filter(([, v]) => v !== undefined),
      );
      return api.post<{
        agent_id: string;
        peer_map_id: string;
        name?: string;
        role: string;
        cwd: string;
      }>(`/map/swarms/${swarmId}/agents`, cleanBody);
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['map-swarm', vars.swarmId] });
      queryClient.invalidateQueries({ queryKey: ['map-swarms'] });
      queryClient.invalidateQueries({ queryKey: ['map-swarms-picker'] });
    },
  });
}

/**
 * Open an ACP session against an already-registered agent on a swarm.
 * `agentId` is required (pass the hub agent id or the peerMapId).
 * `peerMapId`, when provided, is the swarm-side MAP server target id —
 * required when the registry hasn't published it (e.g., immediately after
 * spawning a macro-agent coordinator). Eagerly creates the OpenHive
 * session resource so the UI can navigate to it.
 */
export function useConnectAcp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ swarmId, agentId, peerMapId, cwd }: {
      swarmId: string; agentId: string; peerMapId?: string; cwd?: string;
    }) =>
      api.post<{ session_resource_id: string; acp_session_id: string; acp_stream_id: string; created: boolean }>(
        '/sessions/acp-connect',
        {
          swarm_id: swarmId,
          agent_id: agentId,
          ...(peerMapId ? { peer_map_id: peerMapId } : {}),
          ...(cwd ? { cwd } : {}),
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions-overview'] });
      queryClient.invalidateQueries({ queryKey: ['session-checkpoints'] });
    },
  });
}

// ============================================================================
// Cascade (git-cascade projections)
// ============================================================================

/**
 * Task changelog — commit range + merges + conflicts bound to an
 * OpenTasks task, plus rendered markdown. The Phase 3 primary artifact.
 *
 * Pass `format: 'json'` to skip markdown rendering when the UI renders its
 * own layout from the structured data.
 */
export function useCascadeChangelog(
  resourceId: string,
  nodeId: string,
  options: {
    title?: string;
    subtitle?: string;
    format?: 'json' | 'both';
    enabled?: boolean;
  } = {},
) {
  const params = new URLSearchParams();
  params.set('format', options.format ?? 'both');
  if (options.title) params.set('title', options.title);
  if (options.subtitle) params.set('subtitle', options.subtitle);

  return useQuery({
    queryKey: ['cascade-changelog', resourceId, nodeId, options.format, options.title, options.subtitle],
    queryFn: () =>
      api.get<import('../lib/api').CascadeChangelogResponse>(
        `/cascade/tasks/${encodeURIComponent(resourceId)}/${encodeURIComponent(nodeId)}/changelog?${params.toString()}`,
      ),
    enabled: (options.enabled ?? true) && !!resourceId && !!nodeId,
    staleTime: 15_000,
  });
}

/**
 * Raw commit range for a task — lighter than the full changelog when you
 * only need stream info + commit list.
 */
export function useCascadeCommitRange(
  resourceId: string,
  nodeId: string,
  options: { limit?: number; offset?: number; enabled?: boolean } = {},
) {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.offset) params.set('offset', String(options.offset));

  const qs = params.toString();
  return useQuery({
    queryKey: ['cascade-commit-range', resourceId, nodeId, options.limit, options.offset],
    queryFn: () =>
      api.get<{
        data: Array<{
          stream_row_id: string;
          stream_id: string;
          source_swarm_id: string;
          source_agent_id: string;
          first_commit: string | null;
          last_commit: string | null;
          change_ids: string[];
          commits: Array<{
            commit_hash: string;
            change_id: string | null;
            message_summary: string | null;
            author_agent_id: string | null;
            files_touched: string[];
            synced_at: string;
          }>;
          files_union: string[];
          merge_commit: string | null;
          merge_target: string | null;
        }>;
      }>(
        `/cascade/tasks/${encodeURIComponent(resourceId)}/${encodeURIComponent(nodeId)}/commits${qs ? `?${qs}` : ''}`,
      ),
    enabled: (options.enabled ?? true) && !!resourceId && !!nodeId,
  });
}

// ── Stream DAG + detail hooks ───────────────────────────────────────

export interface StreamDAGNode {
  id: string;
  stream_id: string;
  source_swarm_id: string;
  source_agent_id: string;
  parent_stream_id: string | null;
  name: string;
  status: string;
  task_resource_id: string | null;
  task_node_id: string | null;
  publish_branch: string | null;
  opened_at: string;
  last_event_at: string;
  commit_count: number;
  open_conflict_count: number;
}

export interface StreamDAGEdge {
  source: string;
  target: string;
  type: 'parent' | 'merge';
}

export interface StreamDAG {
  nodes: StreamDAGNode[];
  edges: StreamDAGEdge[];
}

export interface StreamTimelineEvent {
  type: 'commit' | 'merge' | 'conflict_detected' | 'conflict_resolved' | 'status_change' | 'push' | 'rebase';
  timestamp: string;
  data: Record<string, unknown>;
}

export function useCascadeDAG(options: {
  source_swarm_id?: string;
  task_resource_id?: string;
  enabled?: boolean;
} = {}) {
  const params = new URLSearchParams();
  if (options.source_swarm_id) params.set('source_swarm_id', options.source_swarm_id);
  if (options.task_resource_id) params.set('task_resource_id', options.task_resource_id);
  const qs = params.toString();

  return useQuery({
    queryKey: ['cascade-dag', options.source_swarm_id, options.task_resource_id],
    queryFn: () =>
      api.get<{ data: StreamDAG }>(`/cascade/streams/dag${qs ? `?${qs}` : ''}`),
    enabled: options.enabled ?? true,
    staleTime: 10_000,
  });
}

export function useCascadeStreamTimeline(streamRowId: string | null) {
  return useQuery({
    queryKey: ['cascade-stream-timeline', streamRowId],
    queryFn: () =>
      api.get<{ data: StreamTimelineEvent[] }>(
        `/cascade/streams/${encodeURIComponent(streamRowId!)}/timeline`,
      ),
    enabled: !!streamRowId,
    staleTime: 10_000,
  });
}

export function useCascadeStreamDetail(streamRowId: string | null) {
  return useQuery({
    queryKey: ['cascade-stream-detail', streamRowId],
    queryFn: () =>
      api.get<{ data: Record<string, unknown> }>(
        `/cascade/streams/${encodeURIComponent(streamRowId!)}`,
      ),
    enabled: !!streamRowId,
    staleTime: 10_000,
  });
}

/**
 * Lightweight listing of sessions on a swarm that have a persisted
 * provider_session_id — i.e. can be resumed durably. Used by the swarm
 * detail page to show a "Resumable Sessions" panel.
 */
export interface ResumableSession {
  session_resource_id: string;
  name: string;
  description: string | null;
  project: string | null;
  project_path: string | null;
  acp_session_id: string | null;
  provider_session_id_prefix: string;
  updated_at: string;
  owner_agent_id: string;
}

export function useResumableSessions(swarmId: string | undefined) {
  return useQuery({
    queryKey: ['resumable-sessions', swarmId],
    queryFn: () =>
      api.get<{ swarm_id: string; total: number; sessions: ResumableSession[] }>(
        `/map/swarms/${swarmId}/resumable-sessions`,
      ),
    enabled: !!swarmId,
  });
}

/**
 * Batch resume all resumable sessions on a swarm. Bounded parallelism server-
 * side (default 3 concurrent). Partial failures are returned — one bad session
 * doesn't fail the whole batch.
 */
export function useResumeAllSessions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ swarmId, cwd, concurrency }: { swarmId: string; cwd?: string; concurrency?: number }) =>
      api.post<{
        swarm_id: string;
        total: number;
        succeeded: Array<{ session_resource_id: string; acp_session_id: string; acp_stream_id: string }>;
        failed: Array<{ session_resource_id: string; error: string; message: string }>;
      }>(`/map/swarms/${swarmId}/resume-all`, {
        ...(cwd ? { cwd } : {}),
        ...(concurrency ? { concurrency } : {}),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['resumable-sessions', vars.swarmId] });
      queryClient.invalidateQueries({ queryKey: ['sessions-overview'] });
    },
  });
}

/**
 * Resume a session whose source swarm/agent may be stopped or offline. The
 * server restarts the hosted swarm (if needed), waits for macro-agent to
 * reconnect, asks macro-agent to resume the agent by provider_session_id,
 * and opens a fresh ACP stream loading the persisted transcript. Can take
 * up to ~30s when the swarm is cold.
 */
export function useResumeSession() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionResourceId, cwd }: {
      sessionResourceId: string; cwd?: string;
    }) =>
      api.post<{ session_resource_id: string; acp_session_id: string; acp_stream_id: string }>(
        `/sessions/${sessionResourceId}/resume`,
        cwd ? { cwd } : {},
      ),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['resource', vars.sessionResourceId] });
      queryClient.invalidateQueries({ queryKey: ['sessions-overview'] });
    },
  });
}

/**
 * Stop a specific agent on a swarm. Proxies to the swarm's MAP server. The
 * server prefers `_macro/terminateAgent` (real process termination on
 * macro-agent v0.1.10+); on older runtimes it falls back to
 * `map/agents/unregister` and reports `method` so the UI can warn that the
 * underlying process may still be running.
 */
export type CascadeAction = 'merge' | 'abandon' | 'pause' | 'resume' | 'resolve' | 'push' | 'commit';

export function useCascadeStreamAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      streamRowId,
      action,
      params,
    }: {
      streamRowId: string;
      action: CascadeAction;
      params?: {
        target_stream_id?: string;
        reason?: string;
        conflict_id?: string;
        strategy?: string;
      };
    }) => {
      return api.post<{ sent: boolean; action: string; stream_id: string }>(
        `/cascade/streams/${encodeURIComponent(streamRowId)}/actions/${action}`,
        params ?? {},
      );
    },
    onSuccess: () => {
      // Invalidate DAG + detail so the UI picks up the resulting event
      queryClient.invalidateQueries({ queryKey: ['cascade-dag'] });
      queryClient.invalidateQueries({ queryKey: ['cascade-stream-detail'] });
      queryClient.invalidateQueries({ queryKey: ['cascade-stream-timeline'] });
    },
  });
}

// ── PR + branch management hooks ────────────────────────────────────

export interface CascadePullRequest {
  id: string;
  stream_row_id: string;
  provider: string;
  remote_pr_number: number | null;
  remote_pr_url: string | null;
  state: string;
  source_branch: string;
  target_branch: string;
  title: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  created_at: string;
  updated_at: string;
}

export function useCascadeStreamPR(streamRowId: string | null) {
  return useQuery({
    queryKey: ['cascade-stream-pr', streamRowId],
    queryFn: () =>
      api.get<{ data: CascadePullRequest | null }>(
        `/cascade/streams/${encodeURIComponent(streamRowId!)}/pr`,
      ),
    enabled: !!streamRowId,
    staleTime: 10_000,
  });
}

export function useCreatePR() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      streamRowId,
      title,
      target_branch,
      draft,
    }: {
      streamRowId: string;
      title?: string;
      target_branch?: string;
      draft?: boolean;
    }) => {
      return api.post<{ data: CascadePullRequest }>(
        `/cascade/streams/${encodeURIComponent(streamRowId)}/pr`,
        { title, target_branch, draft },
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['cascade-stream-pr', vars.streamRowId] });
      queryClient.invalidateQueries({ queryKey: ['cascade-dag'] });
    },
  });
}

export function useUpdatePR() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      streamRowId,
      title,
      target_branch,
    }: {
      streamRowId: string;
      title?: string;
      target_branch?: string;
    }) => {
      return api.patch<{ data: CascadePullRequest }>(
        `/cascade/streams/${encodeURIComponent(streamRowId)}/pr`,
        { title, target_branch },
      );
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['cascade-stream-pr', vars.streamRowId] });
    },
  });
}

export function useClosePR() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ streamRowId }: { streamRowId: string }) => {
      return api.delete(`/cascade/streams/${encodeURIComponent(streamRowId)}/pr`);
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['cascade-stream-pr', vars.streamRowId] });
    },
  });
}

export function useUpdatePublishBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      streamRowId,
      publish_branch,
    }: {
      streamRowId: string;
      publish_branch: string;
    }) => {
      return api.patch<{ data: { publish_branch: string } }>(
        `/cascade/streams/${encodeURIComponent(streamRowId)}/branch`,
        { publish_branch },
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cascade-dag'] });
    },
  });
}

export function useGitHubStatus() {
  return useQuery({
    queryKey: ['github-status'],
    queryFn: () => api.get<{ data: { connected: boolean; user?: string; error?: string } }>('/cascade/github/status'),
    staleTime: 60_000,
  });
}

export function useStopAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ swarmId, agentId, reason }: { swarmId: string; agentId: string; reason?: string }) =>
      api.post<{ success: boolean; method?: string }>(
        `/map/swarms/${swarmId}/agents/${agentId}/stop`,
        { ...(reason ? { reason } : {}) },
      ),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['map-swarm', vars.swarmId] });
      queryClient.invalidateQueries({ queryKey: ['map-swarms'] });
      queryClient.invalidateQueries({ queryKey: ['map-swarms-picker'] });
    },
  });
}
