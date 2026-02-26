/**
 * SwarmHub Connector
 *
 * Manages the lifecycle of the SwarmHub bridge connection.
 * Auto-activates when SWARMHUB_API_URL + SWARMHUB_HIVE_TOKEN env vars
 * are present (set by SwarmHub at provisioning time).
 *
 * Responsibilities:
 * - Establish and maintain connection to SwarmHub
 * - Periodic health checks
 * - Provide credential access (GitHub tokens) to other subsystems
 * - Emit events for webhook forwarding, token refresh, etc.
 */

import { EventEmitter } from 'events';
import { SwarmHubClient } from './client.js';
import type {
  SwarmHubConfig,
  ConnectorState,
  ConnectorStatus,
  HiveIdentity,
  GitHubTokenRequest,
  GitHubTokenResponse,
} from './types.js';

const DEFAULT_HEALTH_CHECK_INTERVAL = 60_000; // 1 minute

export class SwarmHubConnector extends EventEmitter {
  private client: SwarmHubClient;
  private config: SwarmHubConfig;
  private state: ConnectorState = {
    status: 'disconnected',
    identity: null,
    lastHealthCheck: null,
    lastError: null,
    connectedAt: null,
  };
  private healthTimer?: ReturnType<typeof setInterval>;

  constructor(config: SwarmHubConfig) {
    super();
    this.config = config;
    this.client = new SwarmHubClient(config);
  }

  // ==========================================================================
  // Static Factory
  // ==========================================================================

  /**
   * Create a connector from environment variables.
   * Returns null if SwarmHub env vars are not set.
   */
  static fromEnv(): SwarmHubConnector | null {
    const apiUrl = process.env.SWARMHUB_API_URL;
    const hiveToken = process.env.SWARMHUB_HIVE_TOKEN;

    if (!apiUrl || !hiveToken) return null;

    return new SwarmHubConnector({
      enabled: true,
      apiUrl,
      hiveToken,
      healthCheckInterval: parseInt(process.env.SWARMHUB_HEALTH_INTERVAL || '', 10) || DEFAULT_HEALTH_CHECK_INTERVAL,
    });
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /** Connect to SwarmHub and start health monitoring */
  async connect(): Promise<HiveIdentity> {
    this.setStatus('connecting');

    try {
      const identity = await this.client.getIdentity();
      this.state.identity = identity;
      this.state.connectedAt = new Date().toISOString();
      this.setStatus('connected');

      this.emit('connected', identity);
      this.startHealthMonitor();

      return identity;
    } catch (err) {
      const message = (err as Error).message;
      this.state.lastError = message;
      this.setStatus('error');
      this.emit('error', { message });
      throw err;
    }
  }

  /** Disconnect and stop health monitoring */
  async disconnect(): Promise<void> {
    this.stopHealthMonitor();
    this.client.clearTokenCache();
    this.setStatus('disconnected');
    this.emit('disconnected', { reason: 'manual' });
  }

  // ==========================================================================
  // Credential Access
  // ==========================================================================

  /**
   * Get a scoped GitHub token via SwarmHub.
   * This is the primary method for swarms/agents to get git credentials
   * without storing GitHub App secrets locally.
   */
  async getGitHubToken(options?: GitHubTokenRequest): Promise<GitHubTokenResponse> {
    this.ensureConnected();
    try {
      const token = await this.client.getGitHubToken(options);
      this.emit('github_token_refreshed', {
        installationId: token.installation_id,
        expiresAt: token.expires_at,
      });
      return token;
    } catch (err) {
      this.state.lastError = (err as Error).message;
      throw err;
    }
  }

  /**
   * Get the list of repositories mapped to this hive.
   */
  async getRepos() {
    this.ensureConnected();
    return this.client.getRepos();
  }

  // ==========================================================================
  // State
  // ==========================================================================

  get status(): ConnectorStatus {
    return this.state.status;
  }

  get identity(): HiveIdentity | null {
    return this.state.identity;
  }

  get isConnected(): boolean {
    return this.state.status === 'connected';
  }

  getState(): ConnectorState {
    return { ...this.state };
  }

  // ==========================================================================
  // Internal
  // ==========================================================================

  private setStatus(status: ConnectorStatus): void {
    this.state.status = status;
  }

  private ensureConnected(): void {
    if (this.state.status !== 'connected') {
      throw new Error('SwarmHub connector is not connected');
    }
  }

  private startHealthMonitor(): void {
    this.stopHealthMonitor();
    this.healthTimer = setInterval(async () => {
      try {
        const healthy = await this.client.healthCheck();
        this.state.lastHealthCheck = new Date().toISOString();
        if (healthy && this.state.status === 'error') {
          // Recovered from error
          this.setStatus('connected');
        } else if (!healthy && this.state.status === 'connected') {
          this.state.lastError = 'Health check failed';
          this.setStatus('error');
          this.emit('error', { message: 'Health check failed' });
        }
      } catch (err) {
        this.state.lastError = (err as Error).message;
        if (this.state.status === 'connected') {
          this.setStatus('error');
          this.emit('error', { message: (err as Error).message });
        }
      }
    }, this.config.healthCheckInterval);
  }

  private stopHealthMonitor(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }
}
