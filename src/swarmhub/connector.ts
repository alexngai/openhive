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
 * - Poll for queued events (tunnel mode) and process them
 * - Emit events for webhook forwarding, token refresh, etc.
 */

import { EventEmitter } from 'node:events';
import { SwarmHubClient } from './client.js';
import { handleForwardedSlackEvent } from './webhook-handler.js';
import { normalize, routeEvent } from '../events/index.js';
import * as eventsDAL from '../db/dal/events.js';
import type {
  SwarmHubConfig,
  ConnectorState,
  ConnectorStatus,
  HiveIdentity,
  HiveConfig,
  GitHubTokenRequest,
  GitHubTokenResponse,
  SlackCredentialsRequest,
  SlackCredentialsResponse,
  SlackInstallationsResponse,
  QueuedEvent,
} from './types.js';

const DEFAULT_HEALTH_CHECK_INTERVAL = 60_000; // 1 minute
const POLL_TIMEOUT_SECONDS = 25;
const POLL_MAX_RECONNECT_DELAY = 60_000; // 1 minute
const POLL_BASE_RECONNECT_DELAY = 2_000; // 2 seconds

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
  private hiveConfig: HiveConfig | null = null;
  private healthTimer?: ReturnType<typeof setInterval>;

  // Event polling state
  private pollAbortController?: AbortController;
  private pollActive = false;
  private pollReconnectAttempts = 0;

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
      enableEventPolling: process.env.SWARMHUB_EVENT_POLLING !== 'false',
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

      // Fetch boot-time config (OAuth client secret, etc.)
      try {
        this.hiveConfig = await this.client.getHiveConfig();
        if (this.hiveConfig.oauth) {
          console.log('[swarmhub] OAuth config fetched (client secret available)');
        }
      } catch (err) {
        console.warn(`[swarmhub] Failed to fetch hive config: ${(err as Error).message}`);
      }

      this.emit('connected', identity);
      this.startHealthMonitor();

      // Start event polling if enabled (tunnel mode)
      if (this.config.enableEventPolling !== false) {
        this.startEventPoller();
      }

      // Pull event routing config from SwarmHub
      this.pullEventConfig().catch((err) => {
        console.warn(`[swarmhub] Failed to pull event config: ${(err as Error).message}`);
      });

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
    this.stopEventPoller();
    this.stopHealthMonitor();
    this.client.clearTokenCache();
    this.setStatus('disconnected');
    this.emit('disconnected', { reason: 'manual' });
    // Remove all listeners to prevent accumulation if reconnected
    this.removeAllListeners();
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
  // Slack Credentials
  // ==========================================================================

  /**
   * Get Slack installations (workspaces) mapped to this hive.
   * Includes channel mappings for each workspace.
   */
  async getSlackInstallations(): Promise<SlackInstallationsResponse> {
    this.ensureConnected();
    try {
      return await this.client.getSlackInstallations();
    } catch (err) {
      this.state.lastError = (err as Error).message;
      throw err;
    }
  }

  /**
   * Get Slack bot credentials via SwarmHub.
   * Allows this hive to send messages to Slack without storing
   * Slack App secrets locally — SwarmHub hosts the Slack App.
   */
  async getSlackCredentials(options?: SlackCredentialsRequest): Promise<SlackCredentialsResponse> {
    this.ensureConnected();
    try {
      return await this.client.getSlackCredentials(options);
    } catch (err) {
      this.state.lastError = (err as Error).message;
      throw err;
    }
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

  /** Returns the OAuth client ID fetched at connect time, or undefined. */
  getOAuthClientId(): string | undefined {
    return this.hiveConfig?.oauth?.client_id;
  }

  /** Returns the OAuth client secret fetched at connect time, or undefined. */
  getOAuthClientSecret(): string | undefined {
    return this.hiveConfig?.oauth?.client_secret;
  }


  // ==========================================================================
  // Event Polling (tunnel mode)
  // ==========================================================================

  private startEventPoller(): void {
    this.stopEventPoller();
    this.pollAbortController = new AbortController();
    this.pollActive = true;
    this.pollReconnectAttempts = 0;

    console.log('[swarmhub] Event polling started');

    // Fire-and-forget — the loop runs until stopEventPoller is called
    this.runPollLoop(this.pollAbortController.signal).catch(() => {
      // Errors are handled inside the loop
    });
  }

  private stopEventPoller(): void {
    if (!this.pollActive) return;
    this.pollActive = false;
    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = undefined;
    }
    console.log('[swarmhub] Event polling stopped');
  }

  private async runPollLoop(signal: AbortSignal): Promise<void> {
    while (this.pollActive && !signal.aborted) {
      try {
        const response = await this.client.pollEvents({
          timeout: POLL_TIMEOUT_SECONDS,
          limit: 10,
          signal,
        });

        // Reset backoff on successful response
        this.pollReconnectAttempts = 0;

        if (response.events.length > 0) {
          console.log(`[swarmhub] Received ${response.events.length} polled event(s)`);
          const ackIds: string[] = [];

          for (const event of response.events) {
            try {
              this.processPolledEvent(event);
              ackIds.push(event.id);
            } catch (err) {
              console.error(`[swarmhub] Failed to process event ${event.id}:`, err);
              // Still ack to prevent re-delivery of unprocessable events
              ackIds.push(event.id);
            }
          }

          // Acknowledge all processed events
          if (ackIds.length > 0) {
            try {
              await this.client.acknowledgeEvents(ackIds);
            } catch (err) {
              console.error('[swarmhub] Failed to acknowledge events:', err);
              // Events will be requeued after stale timeout — not critical
            }
          }
        }
        // If empty response (long-poll timeout), loop immediately
      } catch (err) {
        if (signal.aborted) return;

        const message = (err as Error).message;
        console.error(`[swarmhub] Poll error: ${message}`);
        this.emit('poll_error', { message });

        // Exponential backoff on error
        const delay = Math.min(
          POLL_BASE_RECONNECT_DELAY * Math.pow(2, this.pollReconnectAttempts),
          POLL_MAX_RECONNECT_DELAY,
        );
        this.pollReconnectAttempts++;

        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private processPolledEvent(event: QueuedEvent): void {
    this.emit('webhook_received', {
      event: event.event_type,
      source: event.source,
    });

    if (event.source === 'slack') {
      // Slack events still go through bridge inbound for channel mapping
      handleForwardedSlackEvent({
        team_id: event.payload.team_id as string,
        event_type: event.payload.event_type as string,
        event: event.payload.event as any,
        event_id: event.payload.event_id as string | undefined,
      });

      // Also route through the event system for MAP dispatch + post rules
      const normalized = normalize(
        'slack',
        event.payload.event_type as string,
        event.payload.event_id as string || event.delivery_id || event.id,
        event.payload,
      );
      routeEvent(normalized);
    } else {
      // GitHub and all other sources go through the event router
      const normalized = normalize(
        event.source,
        event.payload.event_type as string || event.event_type,
        event.payload.delivery_id as string || event.delivery_id || event.id,
        event.source === 'github'
          ? (event.payload.payload as Record<string, unknown>) || event.payload
          : event.payload,
      );
      routeEvent(normalized);
    }
  }

  // ==========================================================================
  // Event Config Pull
  // ==========================================================================

  /** Pull event routing config from SwarmHub and apply locally. */
  private async pullEventConfig(): Promise<void> {
    try {
      const config = await this.client.getEventConfig();

      let rulesCreated = 0;
      let subsCreated = 0;

      if (config.post_rules) {
        for (const rule of config.post_rules) {
          eventsDAL.createPostRule({
            hive_id: rule.hive_id,
            source: rule.source,
            event_types: rule.event_types,
            filters: rule.filters as any,
            normalizer: rule.normalizer,
            thread_mode: rule.thread_mode as any,
            priority: rule.priority,
            created_by: 'swarmhub',
          });
          rulesCreated++;
        }
      }

      if (config.subscriptions) {
        for (const sub of config.subscriptions) {
          eventsDAL.createSubscription({
            hive_id: sub.hive_id,
            swarm_id: sub.swarm_id,
            source: sub.source,
            event_types: sub.event_types,
            filters: sub.filters as any,
            priority: sub.priority,
            created_by: 'swarmhub',
          });
          subsCreated++;
        }
      }

      if (rulesCreated > 0 || subsCreated > 0) {
        console.log(`[swarmhub] Pulled event config: ${rulesCreated} rule(s), ${subsCreated} subscription(s)`);
      }
    } catch (err) {
      // Non-fatal — the endpoint may not exist on older SwarmHub versions
      const message = (err as Error).message;
      if (!message.includes('404')) {
        throw err;
      }
    }
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
