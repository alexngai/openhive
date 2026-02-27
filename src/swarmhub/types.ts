/**
 * SwarmHub Connector Types
 *
 * Type definitions for the optional SwarmHub bridge that enables
 * managed OpenHive instances to receive credentials, webhooks,
 * and other signals from SwarmHub.
 */

// ============================================================================
// Configuration
// ============================================================================

export interface SwarmHubConfig {
  /** Whether the connector is enabled (auto-detected from env vars) */
  enabled: boolean;
  /** SwarmHub API base URL (e.g. https://api.swarmhub.dev) */
  apiUrl: string;
  /** Per-hive bearer token for authenticating with SwarmHub bridge API */
  hiveToken: string;
  /** Health check interval in ms (default: 60000) */
  healthCheckInterval: number;
  /** Enable event polling for tunnel-mode hives (default: true when connector active) */
  enableEventPolling?: boolean;
}

// ============================================================================
// SwarmHub Bridge API Responses
// ============================================================================

/** Hive identity returned by GET /v1/internal/hive/identity */
export interface HiveIdentity {
  id: string;
  slug: string;
  name: string;
  owner_type: 'user' | 'organization';
  owner_id: string;
  tier: string;
  status: string;
  endpoint_url: string | null;
}

/** Repository mapping returned by GET /v1/internal/hive/repos */
export interface HiveRepo {
  repo_full_name: string;
  installation_id: number;
  event_filter?: string[];
}

export interface HiveReposResponse {
  repositories: HiveRepo[];
}

/** GitHub token returned by POST /v1/internal/hive/github-token */
export interface GitHubTokenResponse {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
  installation_id: number;
  repositories: Array<{
    id: number;
    name: string;
    full_name: string;
  }>;
}

/** Multi-installation token response */
export interface GitHubMultiTokenResponse {
  tokens: GitHubTokenResponse[];
}

/** Request body for POST /v1/internal/hive/github-token */
export interface GitHubTokenRequest {
  repositories?: string[];
  permissions?: Record<string, string>;
}

// ============================================================================
// Slack Integration (SwarmHub as Slack App host)
// ============================================================================

/** Slack workspace installation returned by GET /v1/internal/hive/slack-installations */
export interface SlackInstallation {
  team_id: string;
  team_name: string;
  team_url?: string;
  bot_user_id: string;
  scopes: string[];
  channel_mappings: SlackChannelMapping[];
}

/** Slack channel → hive mapping managed by SwarmHub */
export interface SlackChannelMapping {
  channel_id: string;
  channel_name?: string;
  hive_name: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  event_filter?: string[];
}

/** Slack credentials returned by POST /v1/internal/hive/slack-credentials */
export interface SlackCredentialsResponse {
  installations: Array<{
    team_id: string;
    team_name: string;
    team_url?: string;
    bot_user_id: string;
    bot_token: string;
    scopes: string[];
  }>;
}

/** Request body for POST /v1/internal/hive/slack-credentials */
export interface SlackCredentialsRequest {
  team_id?: string;
}

/** Slack installations list response */
export interface SlackInstallationsResponse {
  installations: SlackInstallation[];
}

/**
 * Forwarded Slack event from SwarmHub.
 * SwarmHub verifies the Slack signature and forwards the normalized event.
 */
export interface ForwardedSlackEvent {
  team_id: string;
  event_type: string;
  event: SlackEventPayload;
  /** Original Slack event_id for deduplication */
  event_id?: string;
}

/** Slack Events API event payload (subset relevant to message processing) */
export interface SlackEventPayload {
  type: string;
  subtype?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  files?: Array<{
    url_private: string;
    name: string;
    mimetype: string;
  }>;
}

// ============================================================================
// Connector State
// ============================================================================

export type ConnectorStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectorState {
  status: ConnectorStatus;
  identity: HiveIdentity | null;
  lastHealthCheck: string | null;
  lastError: string | null;
  connectedAt: string | null;
}

// ============================================================================
// Cached Token
// ============================================================================

export interface CachedToken {
  token: string;
  expiresAt: Date;
  installationId: number;
  repositories: string[];
  permissions: Record<string, string>;
}

// ============================================================================
// Events
// ============================================================================

export interface SwarmHubEvents {
  connected: HiveIdentity;
  disconnected: { reason: string };
  error: { message: string; code?: string };
  github_token_refreshed: { installationId: number; expiresAt: string };
  webhook_received: { event: string; source?: string; repository?: string };
  poll_error: { message: string };
  github_webhook: { event_type: string; delivery_id: string; payload: Record<string, unknown> };
}

// ============================================================================
// Event Polling (tunnel mode)
// ============================================================================

/** A queued event returned by the poll endpoint. */
export interface QueuedEvent {
  id: string;
  source: string;
  event_type: string;
  delivery_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

/** Response from GET /v1/internal/hive/events/poll */
export interface PollEventsResponse {
  events: QueuedEvent[];
}
