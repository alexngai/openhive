/**
 * Distributed Learning Coordination
 *
 * Enables distributed learning across multiple OpenHive instances:
 *
 * - **local** (default): All learning runs on this instance.
 * - **centralized**: This instance forwards trajectory data to a designated
 *   learning hive. The learning hive runs Atlas and publishes results back
 *   via the mesh sync protocol.
 * - **domain-partitioned**: Trajectories are routed to different hives based
 *   on domain. Each hive specializes in specific domains.
 *
 * Communication uses the existing sync peer infrastructure (HTTP + bearer token).
 * No new protocols — trajectory forwarding uses resource_synced events,
 * and results propagate back via the normal mesh sync flow.
 */

import type { Config } from '../config.js';
import type { AtlasService } from './atlas-service.js';
import { type LearningLogger, defaultLogger } from './types.js';

export type DistributedMode = 'local' | 'centralized' | 'domain-partitioned';

export interface DistributedLearningStatus {
  mode: DistributedMode;
  local_processing: boolean;
  forwarding_to?: string;
  domain_routing?: Record<string, string>;
  health: {
    local_atlas_available: boolean;
    remote_hive_reachable?: boolean;
    last_forward_at?: string;
    last_forward_error?: string;
  };
}

/**
 * Distributed learning coordinator.
 *
 * In 'local' mode, this is a no-op — all processing happens on the local Atlas.
 * In 'centralized' mode, trajectory data is forwarded to the learning hive.
 * In 'domain-partitioned' mode, trajectories are routed by domain.
 */
export class DistributedLearningCoordinator {
  private config: Config;
  private atlasService: AtlasService;
  private log: LearningLogger;
  private lastForwardAt: string | null = null;
  private lastForwardError: string | null = null;

  constructor(config: Config, atlasService: AtlasService, logger?: LearningLogger) {
    this.config = config;
    this.atlasService = atlasService;
    this.log = logger || defaultLogger;
  }

  /** Get the current distributed mode */
  getMode(): DistributedMode {
    return this.config.learning.distributed.mode;
  }

  /**
   * Determine whether a trajectory with the given domain should be
   * processed locally or forwarded to a remote hive.
   *
   * Returns 'local' if this instance should process it,
   * or the remote hive URL if it should be forwarded.
   */
  resolveTarget(domain: string): 'local' | string {
    const dist = this.config.learning.distributed;

    switch (dist.mode) {
      case 'local':
        return 'local';

      case 'centralized':
        // In centralized mode, forward everything to the learning hive
        if (dist.learningHiveUrl) {
          // Guard against self-forwarding
          const instanceUrl = this.config.instance?.url;
          if (instanceUrl && dist.learningHiveUrl === instanceUrl) {
            return 'local';
          }
          return dist.learningHiveUrl;
        }
        // If no learning hive URL configured, process locally as fallback
        this.log.warn('Centralized mode but no learningHiveUrl configured — processing locally');
        return 'local';

      case 'domain-partitioned': {
        const targetUrl = dist.domainRouting[domain];
        if (targetUrl) {
          // Guard against self-forwarding
          const instanceUrl = this.config.instance?.url;
          if (instanceUrl && targetUrl === instanceUrl) {
            return 'local';
          }
          return targetUrl;
        }
        return 'local';
      }

      default:
        return 'local';
    }
  }

  /**
   * Forward a trajectory to a remote learning hive.
   *
   * Uses the sync peer infrastructure — the remote hive must be a configured
   * peer with an active sync connection. The trajectory is sent as a
   * resource_synced event on the session resource.
   *
   * For Phase 4, this uses a direct HTTP call to the remote hive's
   * learning API if accessible, falling back to sync event propagation.
   */
  async forwardTrajectory(
    trajectoryData: Record<string, unknown>,
    targetUrl: string,
  ): Promise<boolean> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      // Include API key for authentication with the remote hive
      const apiKey = this.config.learning.distributed.learningHiveApiKey;
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${targetUrl}/api/v1/learning/ingest`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ trajectory: trajectoryData }),
        signal: AbortSignal.timeout(30_000),
      });

      if (response.ok) {
        this.lastForwardAt = new Date().toISOString();
        this.lastForwardError = null;
        return true;
      }

      this.lastForwardError = `HTTP ${response.status}: ${response.statusText}`;
      this.log.warn(`Forward to ${targetUrl} failed:`, this.lastForwardError);
      return false;
    } catch (err) {
      this.lastForwardError = (err as Error).message;
      this.log.warn(`Forward to ${targetUrl} failed:`, this.lastForwardError);
      return false;
    }
  }

  /**
   * Check if the remote learning hive is reachable.
   */
  async checkRemoteHealth(targetUrl: string): Promise<boolean> {
    try {
      const headers: Record<string, string> = {};
      const apiKey = this.config.learning.distributed.learningHiveApiKey;
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${targetUrl}/api/v1/learning/health`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const data = await response.json() as { available?: boolean };
        return data.available === true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get the distributed learning status for monitoring.
   */
  async getStatus(): Promise<DistributedLearningStatus> {
    const dist = this.config.learning.distributed;
    const status: DistributedLearningStatus = {
      mode: dist.mode,
      local_processing: dist.mode === 'local' || !dist.learningHiveUrl,
      health: {
        local_atlas_available: this.atlasService.isAvailable(),
        last_forward_at: this.lastForwardAt || undefined,
        last_forward_error: this.lastForwardError || undefined,
      },
    };

    if (dist.mode === 'centralized' && dist.learningHiveUrl) {
      status.forwarding_to = dist.learningHiveUrl;
      status.health.remote_hive_reachable = await this.checkRemoteHealth(dist.learningHiveUrl);
    }

    if (dist.mode === 'domain-partitioned') {
      status.domain_routing = dist.domainRouting;
    }

    return status;
  }
}
