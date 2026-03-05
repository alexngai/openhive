/**
 * SwarmHub API Client
 *
 * Communicates with the SwarmHub bridge API to fetch credentials,
 * identity info, and repo mappings. Handles token caching with
 * automatic refresh before expiry.
 */

import type {
  SwarmHubConfig,
  HiveIdentity,
  HiveReposResponse,
  GitHubTokenRequest,
  GitHubTokenResponse,
  GitHubMultiTokenResponse,
  CachedToken,
  SlackCredentialsRequest,
  SlackCredentialsResponse,
  SlackInstallationsResponse,
  PollEventsResponse,
} from './types.js';

// Refresh tokens 10 minutes before expiry
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;

// Maximum number of cached tokens to prevent unbounded growth
const MAX_TOKEN_CACHE_SIZE = 50;

export class SwarmHubClient {
  private config: SwarmHubConfig;
  private tokenCache = new Map<string, CachedToken>();

  constructor(config: SwarmHubConfig) {
    this.config = config;
  }

  // ==========================================================================
  // Identity & Repos
  // ==========================================================================

  /** Fetch this hive's identity from SwarmHub */
  async getIdentity(): Promise<HiveIdentity> {
    return this.request<HiveIdentity>('GET', '/v1/internal/hive/identity');
  }

  /** List all repositories mapped to this hive */
  async getRepos(): Promise<HiveReposResponse> {
    return this.request<HiveReposResponse>('GET', '/v1/internal/hive/repos');
  }

  // ==========================================================================
  // GitHub Tokens
  // ==========================================================================

  /**
   * Get a scoped GitHub token for git operations.
   * Returns a cached token if still valid, otherwise requests a new one.
   */
  async getGitHubToken(options?: GitHubTokenRequest): Promise<GitHubTokenResponse> {
    const cacheKey = this.buildCacheKey(options);
    const cached = this.tokenCache.get(cacheKey);

    if (cached && !this.isTokenExpiring(cached)) {
      return {
        token: cached.token,
        expires_at: cached.expiresAt.toISOString(),
        permissions: cached.permissions,
        installation_id: cached.installationId,
        repositories: cached.repositories.map(name => ({
          id: 0, // Not available from cache
          name: name.split('/').pop() || name,
          full_name: name,
        })),
      };
    }

    const response = await this.request<GitHubTokenResponse | GitHubMultiTokenResponse>(
      'POST',
      '/v1/internal/hive/github-token',
      options,
    );

    // Handle multi-installation response (use first token)
    const tokenResponse = 'tokens' in response ? response.tokens[0] : response;

    // Evict expired entries and enforce max size before caching
    if (this.tokenCache.size >= MAX_TOKEN_CACHE_SIZE) {
      for (const [key, cached] of this.tokenCache) {
        if (this.isTokenExpiring(cached)) {
          this.tokenCache.delete(key);
        }
      }
      // If still at capacity, evict oldest (first inserted)
      if (this.tokenCache.size >= MAX_TOKEN_CACHE_SIZE) {
        const firstKey = this.tokenCache.keys().next().value;
        if (firstKey !== undefined) this.tokenCache.delete(firstKey);
      }
    }

    // Cache the token
    this.tokenCache.set(cacheKey, {
      token: tokenResponse.token,
      expiresAt: new Date(tokenResponse.expires_at),
      installationId: tokenResponse.installation_id,
      repositories: tokenResponse.repositories.map(r => r.full_name),
      permissions: tokenResponse.permissions,
    });

    return tokenResponse;
  }

  /**
   * Get GitHub tokens for all installations (when repos span multiple installs).
   * Always fetches fresh — no caching for multi-token requests.
   */
  async getGitHubTokens(options?: GitHubTokenRequest): Promise<GitHubTokenResponse[]> {
    const response = await this.request<GitHubTokenResponse | GitHubMultiTokenResponse>(
      'POST',
      '/v1/internal/hive/github-token',
      options,
    );

    return 'tokens' in response ? response.tokens : [response];
  }

  /** Clear all cached tokens (e.g. on reconnect or error) */
  clearTokenCache(): void {
    this.tokenCache.clear();
  }

  // ==========================================================================
  // Slack Credentials
  // ==========================================================================

  /** List Slack installations (workspaces) mapped to this hive */
  async getSlackInstallations(): Promise<SlackInstallationsResponse> {
    return this.request<SlackInstallationsResponse>('GET', '/v1/internal/hive/slack-installations');
  }

  /**
   * Get Slack bot credentials for this hive.
   * Optionally scoped to a specific workspace (team_id).
   */
  async getSlackCredentials(options?: SlackCredentialsRequest): Promise<SlackCredentialsResponse> {
    return this.request<SlackCredentialsResponse>(
      'POST',
      '/v1/internal/hive/slack-credentials',
      options,
    );
  }

  // ==========================================================================
  // Event Polling (tunnel mode)
  // ==========================================================================

  /** Long-poll for events queued by SwarmHub for this hive. */
  async pollEvents(options?: {
    timeout?: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<PollEventsResponse> {
    const params = new URLSearchParams();
    if (options?.timeout) params.set('timeout', String(options.timeout));
    if (options?.limit) params.set('limit', String(options.limit));
    const qs = params.toString();
    const path = `/v1/internal/hive/events/poll${qs ? `?${qs}` : ''}`;
    return this.request<PollEventsResponse>('GET', path, undefined, options?.signal);
  }

  /** Acknowledge successfully processed events. */
  async acknowledgeEvents(eventIds: string[]): Promise<{ acknowledged: number }> {
    return this.request<{ acknowledged: number }>(
      'POST',
      '/v1/internal/hive/events/ack',
      { event_ids: eventIds },
    );
  }

  // ==========================================================================
  // Hive Config (boot-time secrets)
  // ==========================================================================

  /** Fetch boot-time config (OAuth client secret, etc.) from SwarmHub. */
  async getHiveConfig(): Promise<{
    oauth: { client_id: string; client_secret: string } | null;
  }> {
    return this.request('GET', '/v1/internal/hive/config');
  }

  // ==========================================================================
  // Event Config
  // ==========================================================================

  /** Fetch event routing config managed by SwarmHub for this hive. */
  async getEventConfig(): Promise<{
    post_rules: Array<{
      hive_id: string;
      source: string;
      event_types: string[];
      filters?: Record<string, unknown>;
      normalizer?: string;
      thread_mode?: string;
      priority?: number;
    }>;
    subscriptions: Array<{
      hive_id: string;
      swarm_id?: string;
      source: string;
      event_types: string[];
      filters?: Record<string, unknown>;
      priority?: number;
    }>;
  }> {
    return this.request('GET', '/v1/internal/hive/event-config');
  }

  // ==========================================================================
  // Health Check
  // ==========================================================================

  /** Ping SwarmHub to verify connectivity */
  async healthCheck(): Promise<boolean> {
    try {
      await this.getIdentity();
      return true;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const url = `${this.config.apiUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.hiveToken}`,
      'Accept': 'application/json',
    };

    const init: RequestInit = { method, headers };

    if (signal) {
      init.signal = signal;
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const message = text ? `SwarmHub API error ${res.status}: ${text}` : `SwarmHub API error ${res.status}`;
      const err = new Error(message) as Error & { statusCode: number };
      err.statusCode = res.status;
      throw err;
    }

    return res.json() as Promise<T>;
  }

  private buildCacheKey(options?: GitHubTokenRequest): string {
    if (!options) return '__default__';
    const repos = options.repositories?.sort().join(',') || '';
    const perms = options.permissions
      ? Object.entries(options.permissions).sort().map(([k, v]) => `${k}:${v}`).join(',')
      : '';
    return `${repos}|${perms}`;
  }

  private isTokenExpiring(cached: CachedToken): boolean {
    return cached.expiresAt.getTime() - Date.now() < TOKEN_REFRESH_BUFFER_MS;
  }
}
