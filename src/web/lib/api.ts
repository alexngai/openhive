const API_BASE = '/api/v1';

/** Body shape every openhive route returns on non-2xx (when JSON-parseable). */
export interface ApiErrorBody {
  error: string;
  message?: string;
  details?: unknown;
}

/**
 * Thrown by `ApiClient.request` on non-2xx responses. Carries the HTTP
 * status and the parsed JSON body so consumers can branch on the typed
 * error code (e.g. `non_linear_stack`) instead of substring-matching
 * `.message`. Falls back to `{ error: 'Unknown error' }` if the body
 * isn't valid JSON.
 */
export class ApiClientError extends Error {
  status: number;
  body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message || body.error || `HTTP ${status}`);
    this.name = 'ApiClientError';
    this.status = status;
    this.body = body;
  }
}

export class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl;
    // Try to restore token from localStorage
    if (typeof window !== 'undefined') {
      this.token = localStorage.getItem('openhive_token');
    }
  }

  setToken(token: string | null) {
    this.token = token;
    if (typeof window !== 'undefined') {
      if (token) {
        localStorage.setItem('openhive_token', token);
      } else {
        localStorage.removeItem('openhive_token');
      }
    }
  }

  getToken(): string | null {
    return this.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestInit
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: HeadersInit = {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...options?.headers,
    };

    if (this.token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({ error: 'Unknown error' }))) as ApiErrorBody;
      throw new ApiClientError(response.status, body);
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) return {} as T;

    return JSON.parse(text);
  }

  async get<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>('GET', path, undefined, options);
  }

  async post<T>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>('POST', path, body, options);
  }

  async put<T>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>('PUT', path, body, options);
  }

  async patch<T>(path: string, body?: unknown, options?: RequestInit): Promise<T> {
    return this.request<T>('PATCH', path, body, options);
  }

  async delete<T>(path: string, options?: RequestInit): Promise<T> {
    return this.request<T>('DELETE', path, undefined, options);
  }

  async upload<T>(path: string, formData: FormData): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: HeadersInit = {};

    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({ error: 'Unknown error' }))) as ApiErrorBody;
      throw new ApiClientError(response.status, body);
    }

    return response.json();
  }
}

export const api = new ApiClient();

// Type definitions for API responses
export interface Agent {
  id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  is_verified: boolean;
  is_admin?: boolean;
  account_type?: 'agent' | 'human';
  created_at: string;
}

/**
 * Hive — namespace / tenancy primitive used by swarm registration and event
 * subscriptions. NOT a social community; the social surface was removed in
 * SCHEMA_VERSION 42. The `hives` table retains `is_public` on the backend for
 * wire-compat with older federation peers; the frontend doesn't consume it.
 */
export interface Hive {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  limit: number;
  offset: number;
  total?: number;
}

export interface HostedSwarm {
  id: string;
  name: string;
  swarm_id: string | null;
  provider: string;
  state: 'provisioning' | 'starting' | 'running' | 'unhealthy' | 'stopping' | 'stopped' | 'failed';
  pid: number | null;
  assigned_port: number | null;
  endpoint: string | null;
  error: string | null;
  spawned_by: string;
  created_at: string;
  updated_at: string;
  /** Bootstrap config for the swarm runtime (e.g. auto-spawn coordinator at cwd). */
  bootstrap?: {
    coordinator?: boolean;
    cwd?: string;
  };
  /**
   * Filesystem directory the swarm runtime was launched in. Becomes the
   * runtime fallback cwd for any spawn call that doesn't specify one.
   */
  data_dir?: string;
  /**
   * Operator-chosen working directory for the spawned TUI / codex
   * process. Set only when the spawn request supplied a top-level `cwd`
   * — the process opens here instead of the synthetic `data_dir`. UI
   * surfaces this in preference to `data_dir` so the displayed path
   * matches what the user actually sees inside the TUI.
   */
  cwd?: string;
  /**
   * Workspace repos cloned into `data_dir` at spawn time (TUI kinds clone
   * before launching the PTY). Each entry carries the git URL + optional
   * branch.
   */
  workspace?: { repos: Array<{ url: string; branch?: string; path?: string }> };
  /** Kind of hosted swarm. Defaults to 'swarm-runner' when absent. */
  kind?: 'swarm-runner' | 'claude-code' | 'codex';
  /**
   * For kind='codex' only — which surface this swarm spawned with.
   * 'rpc' rows are driven through openhive chat (POST /codex/turn);
   * 'tui' (and absent) rows are driven through the embedded terminal.
   */
  mode?: 'rpc' | 'tui';
}

export interface MapRegisteredAgent {
  id: string;
  name: string;
  role: string;
  state: string;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface MapSwarm {
  id: string;
  name: string;
  description: string | null;
  map_endpoint: string;
  map_transport: string;
  status: 'online' | 'offline' | 'unreachable';
  last_seen_at: string | null;
  capabilities: Record<string, unknown> | null;
  auth_method: string | null;
  agent_count: number;
  scope_count: number;
  metadata: Record<string, unknown> | null;
  hives: string[];
  /** Live registered agents on the connection (present on list + detail). */
  registered_agents?: MapRegisteredAgent[];
  created_at: string;
}

export interface MapNode {
  id: string;
  swarm_id: string;
  swarm_name: string;
  map_agent_id: string;
  name: string | null;
  description: string | null;
  role: string | null;
  state: 'registered' | 'active' | 'busy' | 'idle' | 'suspended' | 'stopped' | 'failed';
  presence: 'online' | 'offline';
  capabilities: Record<string, unknown> | null;
  scopes: string[] | null;
  visibility: 'public' | 'hive-only' | 'swarm-only';
  tags: string[] | null;
  created_at: string;
}

export interface ConnectionHealth {
  swarmId: string;
  agentId: string;
  transport: 'inbound';
  connectedAt: string;
  lastMessageAt: string;
  missedPongs: number;
  maxMissedPongs: number;
  tokenExpiresAt?: string;
  registeredAgentCount: number;
  registeredAgents: Array<{ id: string; name: string; role: string; state: string }>;
  capabilities?: Record<string, unknown>;
}

export interface OutboundConnection {
  swarmId: string;
  name: string;
  status: 'connected' | 'reconnecting' | 'disconnected';
}

export interface ConnectionsResponse {
  inbound: ConnectionHealth[];
  outbound: OutboundConnection[];
  summary: {
    inbound_count: number;
    outbound_connected: number;
    outbound_reconnecting: number;
    degraded: number;
  };
}

export interface MapStats {
  swarms: { total: number; online: number; offline: number };
  nodes: { total: number; active: number };
  hive_memberships: number;
}

export interface SyncableResource {
  id: string;
  resource_type: 'memory_bank' | 'task' | 'skill' | 'session';
  name: string;
  description: string | null;
  visibility: 'private' | 'shared' | 'public';
  last_commit_hash: string | null;
  last_push_at: string | null;
  last_push_by: string | null;
  subscriber_count: number;
  owner_agent_id: string;
  git_remote_url?: string;
  local_path?: string | null;
  tags?: string[];
  owner?: Agent;
  my_permission?: 'read' | 'write' | 'admin' | null;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown> | null;
}

export interface ResourceSyncEvent {
  id: string;
  resource_id: string;
  commit_hash: string;
  commit_message: string | null;
  pusher: string | null;
  source: string | null;
  created_at: string;
}

export interface CheckUpdatesResult {
  has_updates: boolean;
  previous_commit?: string | null;
  current_commit: string;
  source?: string;
  event_id?: string;
}

export interface BatchCheckResult {
  checked: number;
  updated: Array<{
    resource_id: string;
    resource_type: string;
    resource_name: string;
    previous_commit: string | null;
    current_commit: string;
    event_id: string;
  }>;
  unchanged: string[];
  errors: Array<{
    resource_id: string;
    resource_name: string;
    error: string;
  }>;
}

// Resource content types

export interface MemoryFile {
  path: string;
  size: number;
  modified: string;
}

export interface MemoryFileContent {
  path: string;
  frontmatter: Record<string, unknown> | null;
  body: string;
  size: number;
}

export interface MemorySearchResult {
  path: string;
  line: number;
  snippet: string;
  score: number;
}

export interface MemoryEntry {
  path: string;
  timestamp: string;
  type: string | null;
  agentId: string | null;
  body: string;
  frontmatter: Record<string, unknown> | null;
  domains: string[];
  entities: string[];
  confidence: number | null;
  knowledgeId: string | null;
}

export interface KnowledgeGraphNode {
  id: string;
  path: string | null;
  type: string | null;
  confidence: number | null;
}

export interface KnowledgeGraphEdge {
  from: string;
  to: string;
  relation: string;
  layer?: string;
  depth: number;
}

export interface KnowledgeGraphData {
  root: string;
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

export interface KnowledgeSearchResult {
  path: string;
  frontmatter: Record<string, unknown> | null;
  snippet: string;
  score?: number;
  knowledge_type: string | null;
}

export interface SkillSummary {
  id: string;
  name: string | null;
  version: string | null;
  status: string | null;
  description: string | null;
  tags: string[];
  author: string | null;
  path: string;
  related?: string[];
  relationships?: SkillRelationship[];
  taxonomy?: { primaryPath: string[]; secondaryPaths?: string[][]; confidence?: number } | null;
  parentVersion?: string | null;
  derivedFrom?: string[];
  forks?: string[];
}

export interface SkillRelationship {
  targetId: string;
  type: 'depends_on' | 'extends' | 'alternative' | 'related';
  confidence: number;
}

export interface SkillDetail extends SkillSummary {
  instructions: string | null;
  serving: Record<string, unknown> | null;
  namespace: Record<string, unknown> | null;
  raw: string;
}

export interface SkillGraphNode {
  id: string;
  name: string;
  status: string;
  version: string | null;
  tags: string[];
  taxonomy: { primaryPath: string[] } | null;
  description: string | null;
}

export interface SkillGraphEdge {
  from: string;
  to: string;
  type: string;
  confidence?: number;
}

export interface SkillVersion {
  version: string;
  changelog: string | null;
  createdAt: string | null;
  status: string | null;
}

export interface SkillLineage {
  rootId: string;
  versions: SkillVersion[];
  forks: Array<{ forkedFrom: string; forkId: string; version: string }>;
}

// Skill management types

export interface SkillWritePayload {
  id?: string;
  name: string;
  description?: string;
  problem?: string;
  solution?: string;
  verification?: string;
  tags?: string[];
  status?: 'active' | 'draft' | 'deprecated' | 'experimental';
  version?: string;
  author?: string;
}

export interface ImportPayload {
  format?: 'json' | 'agents-md' | 'indexer';
  content: string | unknown[] | Record<string, unknown>;
}

export interface ImportResult {
  format: string;
  imported: number;
  failed: number;
  warnings?: string[];
}

export interface LoadoutProfile {
  name: string;
  builtIn: boolean;
  criteria: Record<string, unknown> | null;
}

export interface LoadoutSkillEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  status: string | null;
  expanded: boolean;
}

export interface LoadoutStateResponse {
  available: LoadoutSkillEntry[];
  expanded: string[];
  pending: string[];
  source: {
    type: string;
    profileName?: string;
    taskDescription?: string;
    criteria?: Record<string, unknown>;
  };
  updatedAt: string;
}

export interface LoadoutRenderResponse {
  content: string;
  estimatedTokens: number;
}

export interface CompileLoadoutPayload {
  profile?: string;
  taskDescription?: string;
  tags?: string[];
  status?: string[];
  include?: string[];
  exclude?: string[];
  maxSkills?: number;
  maxTokens?: number;
}

// Indexer / Scraper types

export interface IndexerSkillSource {
  type: 'awesome-list' | 'repository';
  url: string;
}

export interface ScrapeResult {
  discovered: number;
  scraped: number;
  skipped: number;
  failed: number;
  unchanged: number;
  errors: string[];
}

export interface IndexResult {
  indexed: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface ScrapeAndIndexResult {
  scraped: ScrapeResult;
  indexed: IndexResult;
  relationships: { detected: number; skipped: number; errors: string[] };
  skillsAdded: string[];
}

export interface IndexerTaxonomyNode {
  id: string;
  name: string;
  path: string[];
  skillCount: number;
  children: IndexerTaxonomyNode[];
}

export interface IndexerStats {
  totalSkills: number;
  indexedSkills: number;
  rawSkills: number;
  failedSkills: number;
  taxonomyNodes: number;
  relationships: number;
  sources: number;
}

export interface IndexerStatus {
  available: boolean;
  degraded: boolean;
  hasGithubToken: boolean;
  hasAnthropicKey: boolean;
  hasSwarmAvailable: boolean;
}

// OpenTasks content types

export interface OpenTasksGraphSummary {
  node_count: number;
  edge_count: number;
  task_counts: {
    open: number;
    in_progress: number;
    blocked: number;
    closed: number;
  };
  context_count: number;
  feedback_count: number;
  ready_count: number;
  daemon_connected: boolean;
}

export interface OpenTasksNodeSummary {
  id: string;
  type: string;
  title: string;
  status?: string;
  priority?: number;
  archived?: boolean;
}

export interface OpenTasksReadyResponse {
  items: OpenTasksNodeSummary[];
  total: number;
  daemon_connected: boolean;
}

export interface OpenTasksGraphNode {
  id: string;
  type: string;
  title?: string;
  description?: string;
  content?: string;
  status?: string;
  priority?: number;
  archived?: boolean;
  assignee?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface OpenTasksGraphEdge {
  id?: string;
  from_id: string;
  to_id: string;
  type?: string;
  [key: string]: unknown;
}

export interface OpenTasksGraphData {
  nodes: OpenTasksGraphNode[];
  edges: OpenTasksGraphEdge[];
}

export interface OpenTasksStatus {
  daemon_running: boolean;
  graph_file_exists: boolean;
  graph_last_modified: string | null;
  socket_path: string;
}

// Event Config types
export interface EventSubscription {
  id: string;
  hive_id: string;
  swarm_id: string | null;
  source: string;
  event_types: string[];
  filters: { repos?: string[]; channels?: string[]; branches?: string[] } | null;
  priority: number;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryLogEntry {
  id: string;
  delivery_id: string;
  subscription_id: string | null;
  swarm_id: string;
  source: string;
  event_type: string;
  status: 'sent' | 'failed' | 'offline';
  error: string | null;
  created_at: string;
}

// Coordination types

export interface SwarmMessage {
  id: string;
  hive_id: string | null;
  from_swarm_id: string;
  to_swarm_id: string | null;
  content_type: 'text' | 'json' | 'binary_ref';
  content: string;
  reply_to: string | null;
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

export interface SharedContext {
  id: string;
  hive_id: string;
  source_swarm_id: string;
  context_type: string;
  data: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
}

export interface SwarmPeer {
  swarm_id: string;
  name: string;
  map_endpoint: string;
  map_transport: string;
  auth_method: string;
  status: 'online' | 'offline' | 'unreachable';
  agent_count: number;
  capabilities: Record<string, unknown> | null;
  shared_hives: string[];
  tailscale_ips: string[] | null;
  tailscale_dns_name: string | null;
}

// Trajectory / Session types

export interface TrajectoryCheckpoint {
  id: string;
  session_resource_id: string;
  checkpoint_id: string;
  commit_hash: string;
  agent: string;
  branch: string | null;
  files_touched: string[];
  checkpoints_count: number;
  token_usage: { input_tokens?: number; output_tokens?: number } | null;
  summary: { intent?: string; outcome?: string } | null;
  attribution: Record<string, unknown> | null;
  source_swarm_id: string | null;
  source_agent_id: string | null;
  synced_at: string;
}

export interface SessionStats {
  total_checkpoints: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_files_touched: number;
  latest_agent: string | null;
  first_synced_at: string | null;
  last_synced_at: string | null;
}

export interface SessionListItem {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  owner_agent_id: string;
  last_commit_hash: string | null;
  last_push_at: string | null;
  total_checkpoints: number;
  total_input_tokens: number;
  total_output_tokens: number;
  latest_agent: string | null;
  last_synced_at: string | null;
  source_swarm_id: string | null;
  source_swarm_ids: string[];
  /** Raw MAP agent id this session targets (populated on ACP sessions). */
  acp_target_agent_id: string | null;
  /** Live ACP stream id (populated on ACP sessions; maps stream-scoped WS events to sessions). */
  acp_stream_id: string | null;
  /** Mail conversation linked via /sessions/:id/chat lazy-create, if any. */
  mail_conversation_id: string | null;
}

/**
 * One pending in-memory permission request, from GET /sessions/pending-attention.
 * Used to hydrate the attention store after a hard reload.
 */
export interface PendingAttentionItem {
  kind: 'permission';
  source: 'acp' | 'hosted';
  request_id: string;
  description: string;
  requested_at: number | null;
  /** ACP-only routing. */
  stream_id?: string;
  session_resource_id?: string | null;
  session_name?: string | null;
  swarm_id?: string | null;
  /** Hosted-only routing. */
  hosted_swarm_id?: string;
}

// Session event types (ACP-compatible)

export interface SessionEvent {
  id: string;
  timestamp: string;
  sequence: number;
  type: 'user_message' | 'assistant_message' | 'assistant_thinking' | 'tool_call' | 'tool_result' | 'token_usage' | 'custom' | 'error' | 'checkpoint' | 'mode_change' | 'plan_update';
  // user_message / assistant_message
  content?: SessionContentBlock[];
  stopReason?: string;
  // assistant_thinking
  thinking?: string;
  // tool_call
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  // tool_result
  isError?: boolean;
  // token_usage
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  // custom
  eventType?: string;
  data?: unknown;
  // error
  code?: number;
  message?: string;
}

export interface SessionContentBlock {
  type: 'text' | 'tool_call' | 'tool_result' | 'image' | 'audio' | 'resource_link';
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  status?: string;
  content?: SessionContentBlock[];
  isError?: boolean;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
}

export interface AgentIdentity {
  id: string;
  name: string;
  avatarUrl: string | null;
}

export interface SessionEventsResponse {
  format_id: string;
  total: number;
  limit: number;
  offset: number;
  events: SessionEvent[];
}

export interface SyncStatusResponse {
  enabled: boolean;
  instance_id?: string;
  groups: Array<{
    sync_group_id: string;
    hive_name: string;
    seq: number;
    peer_count: number;
    connected_peers: number;
  }>;
}

// ── Mail (MAP Agent Inbox) ──

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'data'; schema?: string; data: unknown }
  | { type: 'event'; event: string; data?: unknown }
  | { type: 'reference'; uri: string; label?: string }
  | { type: string; [key: string]: unknown };

export interface MailParticipant {
  agent_id: string;
  role?: string;
  joined_at: string;
}

export interface MailConversation {
  id: string;
  scope: string;
  subject?: string;
  status: 'active' | 'completed' | 'archived';
  participants: MailParticipant[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MailTurn {
  id: string;
  conversation_id: string;
  participant_id: string;
  source_message_id?: string;
  content_type: string;
  content: MessageContent;
  thread_id?: string;
  in_reply_to?: string;
  importance?: 'low' | 'normal' | 'high' | 'urgent';
  created_at: string;
}

export interface MailThread {
  id: string;
  conversation_id: string;
  root_turn_id: string;
  parent_thread_id?: string;
  subject?: string;
  created_at: string;
}

// ============================================================================
// Cascade (git-cascade projections)
// ============================================================================

export interface CascadeCommit {
  commit_hash: string;
  change_id: string | null;
  message_summary: string | null;
  author_agent_id: string | null;
  files_touched: string[];
  synced_at: string;
  stream_id: string;
  source_swarm_id: string;
}

export interface CascadeStreamSummary {
  stream_row_id: string;
  stream_id: string;
  source_swarm_id: string;
  source_agent_id: string;
  first_commit: string | null;
  last_commit: string | null;
  commit_count: number;
  change_ids: string[];
  merge_commit: string | null;
  merge_target: string | null;
  open_conflicts: Array<{
    conflict_id: string | null;
    conflicted_files: string[];
    source: string | null;
    detected_at: string;
  }>;
}

export interface CascadeChangelogData {
  task_ref: { resource_id: string; node_id: string };
  has_work: boolean;
  totals: {
    commits: number;
    streams: number;
    merged_streams: number;
    open_conflicts: number;
    files_touched: number;
  };
  streams: CascadeStreamSummary[];
  commits: CascadeCommit[];
  files_union: string[];
  generated_at: string;
}

export interface CascadeChangelogResponse {
  data: CascadeChangelogData;
  markdown?: string;
}
