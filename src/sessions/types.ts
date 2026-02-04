// ============================================================================
// Session Types for OpenHive
// ACP-aligned (Agent Client Protocol) content and event types
// ============================================================================

// ============================================================================
// ACP-Compatible Content Types
// ============================================================================

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  data: string; // base64
  mimeType: string;
}

export interface AudioContent {
  type: 'audio';
  data: string; // base64
  mimeType: string;
}

export interface ResourceLink {
  type: 'resource_link';
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface ToolCallContent {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: string;
  error?: string;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolCallId: string;
  content: (TextContent | ImageContent | ResourceLink)[];
  isError?: boolean;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | ToolCallContent
  | ToolResultContent;

// ============================================================================
// ACP-Compatible Session Events
// ============================================================================

export interface SessionEventBase {
  id: string;
  timestamp: string;
  sequence: number;
}

export interface UserMessageEvent extends SessionEventBase {
  type: 'user_message';
  content: ContentBlock[];
}

export interface AssistantMessageEvent extends SessionEventBase {
  type: 'assistant_message';
  content: ContentBlock[];
  stopReason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'cancelled';
}

export interface AssistantThinkingEvent extends SessionEventBase {
  type: 'assistant_thinking';
  thinking: string;
}

export interface ToolCallEvent extends SessionEventBase {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent extends SessionEventBase {
  type: 'tool_result';
  toolCallId: string;
  content: ContentBlock[];
  isError?: boolean;
}

export interface ModeChangeEvent extends SessionEventBase {
  type: 'mode_change';
  previousMode?: string;
  newMode: string;
}

export interface PlanUpdateEvent extends SessionEventBase {
  type: 'plan_update';
  plan: PlanEntry[];
}

export interface PlanEntry {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

export interface CheckpointEvent extends SessionEventBase {
  type: 'checkpoint';
  name: string;
  description?: string;
}

export interface ErrorEvent extends SessionEventBase {
  type: 'error';
  code: number;
  message: string;
  data?: unknown;
}

export interface TokenUsageEvent extends SessionEventBase {
  type: 'token_usage';
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CustomEvent extends SessionEventBase {
  type: 'custom';
  eventType: string;
  data: unknown;
  _original?: unknown; // Preserve source format data for lossless round-trip
}

export type SessionEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | AssistantThinkingEvent
  | ToolCallEvent
  | ToolResultEvent
  | ModeChangeEvent
  | PlanUpdateEvent
  | CheckpointEvent
  | ErrorEvent
  | TokenUsageEvent
  | CustomEvent;

// ============================================================================
// Session State and Metadata
// ============================================================================

export type SessionState = 'active' | 'paused' | 'completed' | 'archived';

export interface SessionIndex {
  // Stats for quick querying without parsing full session
  messageCount: number;
  toolCallCount: number;
  inputTokens?: number;
  outputTokens?: number;
  firstEventAt?: string;
  lastEventAt?: string;
  // Preview data
  messagesPreview?: MessagePreview[];
  toolCallsSummary?: ToolCallSummary[];
}

export interface MessagePreview {
  id: string;
  type: 'user_message' | 'assistant_message';
  timestamp: string;
  contentPreview: string; // First ~100 chars
}

export interface ToolCallSummary {
  toolName: string;
  count: number;
  lastUsedAt?: string;
}

export interface SessionResourceMetadata {
  // Format information
  format: {
    id: string; // References session_format_registry
    version?: string;
    detected: boolean; // Auto-detected vs explicitly set
  };

  // ACP compatibility
  acp: {
    native: boolean; // True if stored in native ACP format
    version?: string; // ACP version if native
    sessionId?: string; // ACP sessionId
  };

  // Session config
  config?: {
    mode?: string; // 'ask', 'architect', 'code', etc.
    model?: string;
    workingDirectory?: string;
    mcpServers?: McpServerConfig[];
  };

  // Indexed stats (extracted for quick access)
  index: SessionIndex;

  // Storage info (for large sessions)
  storage?: {
    backend: 'git' | 'local' | 's3' | 'gcs';
    location?: string; // bucket/path for cloud storage
    sizeBytes?: number;
    chunked?: boolean;
  };

  // Relationships
  relationships?: {
    parentSessionId?: string;
    forkedFromId?: string;
    forkPointEventIndex?: number;
  };
}

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  config: Record<string, unknown>;
}

// ============================================================================
// Format Registry Types
// ============================================================================

export interface SessionFormatDefinition {
  id: string;
  name: string;
  vendor?: string;
  version?: string;

  // Detection patterns for auto-detection
  detectionPatterns?: FormatDetectionPattern[];

  // JSON Schema for validation (optional)
  jsonSchema?: object;

  // Adapter configuration
  adapter: {
    type: 'builtin' | 'wasm' | 'url' | 'none';
    builtinId?: string;
    wasmUrl?: string;
    wasmHash?: string;
    transformUrl?: string;
  };

  // ACP compatibility
  isAcpNative: boolean;
  acpVersionTarget?: string;
}

export interface FormatDetectionPattern {
  type: 'field_exists' | 'field_value' | 'regex';
  path?: string; // JSON path for field checks
  value?: unknown; // Expected value for field_value checks
  pattern?: string; // Regex pattern
}

// Note: SessionAdapter interface is defined in adapters/types.ts

// ============================================================================
// Session Participant Types (for multi-agent)
// ============================================================================

export interface SessionParticipant {
  id: string;
  sessionResourceId: string;
  agentId: string;
  role: 'owner' | 'collaborator' | 'observer';
  cursorEventIndex?: number;
  cursorEventId?: string;
  joinedAt: string;
  lastActiveAt?: string;
}

export interface SessionCheckpoint {
  id: string;
  sessionResourceId: string;
  name: string;
  description?: string;
  eventIndex: number;
  eventId?: string;
  stateSnapshot?: Record<string, unknown>;
  createdAt: string;
  createdByAgentId: string;
}

export interface SessionFork {
  id: string;
  parentSessionId: string;
  childSessionId: string;
  forkPointEventIndex: number;
  forkReason?: string;
  createdAt: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface CreateSessionRequest {
  name: string;
  description?: string;
  git_remote_url?: string; // Optional - can use local/cloud storage instead
  visibility?: 'private' | 'shared' | 'public';

  // Session-specific
  format_id?: string; // Default: 'acp_v1' or auto-detect
  initial_mode?: string;
  parent_session_id?: string; // For continuations
  fork_from?: {
    session_id: string;
    event_index: number;
  };

  // Storage backend (if not using git)
  storage_backend?: 'git' | 'local' | 's3' | 'gcs';
  storage_config?: {
    bucket?: string;
    path_prefix?: string;
  };

  config?: {
    model?: string;
    working_directory?: string;
    mcp_servers?: McpServerConfig[];
  };

  tags?: string[];
}

export interface UploadSessionRequest {
  name: string;
  description?: string;
  visibility?: 'private' | 'shared' | 'public';

  // Content - either raw content or file reference
  content?: string; // Raw session content (JSONL, etc.)
  content_format?: string; // Explicit format, or auto-detect

  // Or upload via multipart
  // file handled separately in route

  // Storage backend for the uploaded session
  storage_backend?: 'git' | 'local' | 's3' | 'gcs';

  tags?: string[];
}

export interface SessionUpdateNotification {
  sessionId: string;
  eventType:
    | 'event_added'
    | 'state_changed'
    | 'participant_joined'
    | 'participant_left'
    | 'checkpoint_created';
  data: {
    event?: SessionEvent;
    state?: SessionState;
    participant?: SessionParticipant;
    checkpoint?: SessionCheckpoint;
  };
  timestamp: string;
}

// ============================================================================
// Session Query Types
// ============================================================================

export interface SessionQuery {
  // Filter by format
  format_id?: string;
  format_vendor?: string;

  // Filter by state
  state?: SessionState;

  // Filter by stats
  min_messages?: number;
  max_messages?: number;
  has_tool_calls?: boolean;

  // Date range
  created_after?: string;
  created_before?: string;
  updated_after?: string;

  // Full-text search in indexed content
  search?: string;

  // Pagination
  limit?: number;
  offset?: number;

  // Sort
  sort_by?: 'created_at' | 'updated_at' | 'message_count' | 'name';
  sort_order?: 'asc' | 'desc';
}
