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
  webhook_received: { event: string; repository?: string };
}
