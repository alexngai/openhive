/**
 * Swarm Manager
 *
 * Orchestrates the spawning, lifecycle management, and health monitoring
 * of hosted OpenSwarm instances. Bridges hosting providers with the MAP hub.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';
import { broadcastToChannel } from '../realtime/index.js';
import { registerSwarm } from '../map/service.js';
import * as mapDal from '../db/dal/map.js';
import * as dal from './dal.js';
import { LocalProvider } from './providers/local.js';
import { SandboxedLocalProvider } from './providers/sandboxed-local.js';
import { resolveCredentialOverlay } from './credentials.js';
import type {
  SpawnSwarmInput,
  SwarmProvisionConfig,
  BootstrapToken,
  HostingProvider,
  HostedSwarm,
  SwarmHostingConfig,
  SwarmSandboxPolicy,
} from './types.js';

export class SwarmManager {
  private config: SwarmHostingConfig;
  private instanceUrl: string;
  private providers = new Map<string, HostingProvider>();
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private usedPorts = new Set<number>();
  /** Maps provider instance IDs → hosted swarm DB IDs for exit handler lookup */
  private instanceToHostedId = new Map<string, string>();
  /** Track which instances are being intentionally stopped (to avoid auto-restart) */
  private stoppingInstances = new Set<string>();
  /** Track restart attempts per hosted swarm ID (survives instance ID changes) */
  private restartCounts = new Map<string, number>();
  /** Reverse mapping: hosted swarm DB ID → provider instance ID */
  private hostedToInstanceId = new Map<string, string>();

  constructor(config: SwarmHostingConfig, instanceUrl: string) {
    this.config = config;
    this.instanceUrl = instanceUrl;

    // Initialize local provider with exit handler
    const command = this.resolveOpenswarmCommand(config.openswarm_command);
    const localProvider = new LocalProvider(command);
    localProvider.onProcessExit = (instanceId, code, signal) => {
      this.handleProcessExit(instanceId, code, signal);
    };
    this.providers.set('local', localProvider);

    // Initialize sandboxed local provider if sandbox config is present
    if (config.sandbox?.enabled) {
      const sandboxedProvider = new SandboxedLocalProvider(
        command,
        config.sandbox.default_policy,
      );
      sandboxedProvider.onProcessExit = (instanceId, code, signal) => {
        this.handleProcessExit(instanceId, code, signal);
      };
      this.providers.set('local-sandboxed', sandboxedProvider);

      if (sandboxedProvider.isSandboxAvailable()) {
        console.log('[swarm-manager] Sandboxed local provider initialized');
      } else {
        console.warn('[swarm-manager] Sandbox requested but dependencies unavailable — sandboxed spawns will fall back to unsandboxed');
      }
    }
  }

  /**
   * Resolve the openswarm command to an executable form.
   *
   * We resolve the openswarm bin entry directly to avoid the npx indirection,
   * which can cause pid tracking issues (npx spawns a child node process,
   * then exits, making us think the server stopped).
   *
   * Resolution order:
   * 1. dist/server.mjs exists → run bin directly with node (production)
   * 2. src/hosting/index.ts exists → run with tsx (development)
   * 3. Fall back to configured command as-is
   */
  private resolveOpenswarmCommand(configured: string): string {
    if (configured !== 'npx openswarm serve') {
      return configured;
    }

    try {
      const require_ = createRequire(import.meta.url);
      const pkgPath = require_.resolve('openswarm/package.json');
      const pkgDir = path.dirname(pkgPath);
      const binEntry = path.join(pkgDir, 'bin', 'openswarm.mjs');

      // Production: dist/server.mjs exists, run the bin entry directly with node
      const serverBundle = path.join(pkgDir, 'dist', 'server.mjs');
      if (fs.existsSync(serverBundle) && fs.existsSync(binEntry)) {
        const resolved = `node ${binEntry} serve`;
        console.log(`[swarm-manager] Resolved openswarm command: ${resolved}`);
        return resolved;
      }

      // Development: no bundle, run TypeScript source via tsx
      const hostingEntry = path.join(pkgDir, 'src', 'hosting', 'index.ts');
      const tsxBin = path.join(pkgDir, '..', '.bin', 'tsx');
      if (fs.existsSync(hostingEntry) && fs.existsSync(tsxBin)) {
        const resolved = `${tsxBin} ${hostingEntry}`;
        console.log(`[swarm-manager] Server bundle not found, using tsx: ${resolved}`);
        return resolved;
      }

      console.warn('[swarm-manager] Could not resolve openswarm package');
      return configured;
    } catch {
      console.warn('[swarm-manager] Could not resolve openswarm package, using: ' + configured);
      return configured;
    }
  }

  // ==========================================================================
  // Spawn
  // ==========================================================================

  /**
   * Spawn a new OpenSwarm instance.
   *
   * Flow:
   * 1. Validate limits (max swarms, port availability)
   * 2. Allocate a port
   * 3. Generate a bootstrap token with a pre-auth key
   * 4. Create a hosted_swarms DB record
   * 5. Call the hosting provider to provision the instance
   * 6. Wait for health, then register in the MAP hub
   * 7. Update the DB record with the swarm_id
   */
  async spawn(agentId: string, input: SpawnSwarmInput): Promise<HostedSwarm> {
    // Generate a name if none provided
    const name = input.name ?? uniqueNamesGenerator({
      dictionaries: [adjectives, colors, animals],
      separator: '-',
      length: 3,
    });

    // Check limits
    const activeCount = dal.countActiveHostedSwarms();
    if (activeCount >= this.config.max_swarms) {
      throw new SwarmHostingError(
        'MAX_SWARMS_REACHED',
        `Maximum of ${this.config.max_swarms} hosted swarms reached (${activeCount} active)`
      );
    }

    const providerType = input.provider ?? this.config.default_provider;
    const provider = this.providers.get(providerType);
    if (!provider) {
      throw new SwarmHostingError('PROVIDER_NOT_AVAILABLE', `Hosting provider "${providerType}" is not configured`);
    }

    // Allocate a port
    const port = this.allocatePort();
    if (!port) {
      throw new SwarmHostingError(
        'NO_PORTS_AVAILABLE',
        `No ports available in range ${this.config.port_range[0]}-${this.config.port_range[1]}`
      );
    }

    // Generate bootstrap token
    const adapter = input.adapter ?? 'macro-agent';
    const dataDir = path.join(this.config.data_dir, `swarm-${port}`);

    // Create a pre-auth key if a hive is specified
    let preauthKeyPlaintext: string | undefined;
    if (input.hive) {
      try {
        const { findHiveByName } = await import('../db/dal/hives.js');
        const hive = findHiveByName(input.hive);
        if (!hive) {
          this.releasePort(port);
          throw new SwarmHostingError('HIVE_NOT_FOUND', `Hive "${input.hive}" not found`);
        }
        const keyResult = mapDal.createPreauthKey(agentId, {
          hive_id: hive.id,
          uses: 1,
          expires_in_hours: 1, // Short TTL — just for bootstrap
        });
        preauthKeyPlaintext = keyResult.plaintext_key;
      } catch (err) {
        this.releasePort(port);
        if (err instanceof SwarmHostingError) throw err;
        throw new SwarmHostingError('PREAUTH_KEY_FAILED', `Failed to create pre-auth key: ${(err as Error).message}`);
      }
    }

    const bootstrapToken: BootstrapToken = {
      version: 1,
      openhive_url: this.instanceUrl,
      preauth_key: preauthKeyPlaintext ?? '',
      swarm_name: name,
      adapter,
      adapter_config: input.adapter_config,
      metadata: input.metadata,
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
    };

    const tokenString = Buffer.from(JSON.stringify(bootstrapToken)).toString('base64');
    const tokenHash = createHash('sha256').update(tokenString).digest('hex');

    // Resolve credentials for this swarm
    const inheritEnv = this.config.credentials?.inherit_env !== false;
    const credentialOverlay = resolveCredentialOverlay(
      this.config.credentials,
      input.hive,
      input.credential_overrides,
    );

    const provisionConfig: SwarmProvisionConfig = {
      name,
      adapter,
      adapter_config: input.adapter_config,
      bootstrap_token: tokenString,
      assigned_port: port,
      data_dir: dataDir,
      resolved_credentials: Object.keys(credentialOverlay).length > 0 ? credentialOverlay : undefined,
      inherit_env: inheritEnv,
      credential_resolution: {
        credential_set: this.config.credentials?.default_set,
        hive: input.hive,
        inherit_env: inheritEnv,
      },
      workspace: input.workspace,
    };

    // Create DB record
    const hosted = dal.createHostedSwarm({
      provider: providerType,
      spawned_by: agentId,
      assigned_port: port,
      bootstrap_token_hash: tokenHash,
      config: provisionConfig,
    });

    try {
      // Provision via the hosting provider
      dal.updateHostedSwarm(hosted.id, { state: 'starting' });

      // Resolve sandbox policy for sandboxed providers
      const sandboxPolicy = this.resolveSandboxPolicy(input.hive);
      const result = provider instanceof SandboxedLocalProvider
        ? await provider.provision(provisionConfig, sandboxPolicy)
        : await provider.provision(provisionConfig);

      // Track instance ↔ hosted swarm mapping
      this.instanceToHostedId.set(result.instance_id, hosted.id);
      this.hostedToInstanceId.set(hosted.id, result.instance_id);

      // Update with provider-specific info
      dal.updateHostedSwarm(hosted.id, {
        pid: result.pid ?? null,
        container_id: result.container_id ?? null,
        deployment_id: result.deployment_id ?? null,
        endpoint: result.endpoint ?? null,
      });

      // Wait for health check
      const endpoint = result.endpoint ?? `ws://127.0.0.1:${port}`;
      const healthy = await this.waitForHealth(port, 30000);

      if (!healthy) {
        dal.updateHostedSwarm(hosted.id, {
          state: 'unhealthy',
          error: 'Health check timed out after 30s',
        });
        // Don't throw — the swarm may still come up. Health monitor will track it.
        console.warn(`[swarm-manager] Swarm ${hosted.id} health check timed out, marking unhealthy`);
        return dal.findHostedSwarmById(hosted.id)!;
      }

      // Register in MAP hub (clear stale entry at same endpoint first)
      try {
        const staleSwarm = mapDal.findSwarmByEndpoint(endpoint);
        if (staleSwarm) {
          mapDal.deleteSwarm(staleSwarm.id);
        }

        const mapResult = registerSwarm(agentId, {
          name,
          description: input.description,
          map_endpoint: endpoint,
          map_transport: 'websocket',
          capabilities: {
            observation: true,
            messaging: true,
            lifecycle: true,
          },
          metadata: {
            ...(input.metadata ?? {}),
            hosted: true,
            hosted_swarm_id: hosted.id,
            provider: providerType,
          },
          preauth_key: preauthKeyPlaintext,
        });

        dal.updateHostedSwarm(hosted.id, {
          swarm_id: mapResult.swarm.id,
          endpoint,
          state: 'running',
          error: null,
        });
      } catch (err) {
        // MAP registration failed but process is running
        dal.updateHostedSwarm(hosted.id, {
          endpoint,
          state: 'running',
          error: `MAP registration failed: ${(err as Error).message}`,
        });
        console.warn(`[swarm-manager] Swarm ${hosted.id} is running but MAP registration failed: ${(err as Error).message}`);
      }

      // Broadcast event
      broadcastToChannel('map:discovery', {
        type: 'swarm_spawned',
        data: {
          hosted_swarm_id: hosted.id,
          name,
          provider: providerType,
          endpoint,
        },
      });

      return dal.findHostedSwarmById(hosted.id)!;
    } catch (err) {
      // Clean up on failure
      this.releasePort(port);

      dal.updateHostedSwarm(hosted.id, {
        state: 'failed',
        error: (err as Error).message,
      });

      if (err instanceof SwarmHostingError) throw err;
      throw new SwarmHostingError('SPAWN_FAILED', `Failed to spawn swarm: ${(err as Error).message}`);
    }
  }

  // ==========================================================================
  // Stop
  // ==========================================================================

  async stop(hostedSwarmId: string, agentId: string): Promise<HostedSwarm> {
    const hosted = dal.findHostedSwarmById(hostedSwarmId);
    if (!hosted) {
      throw new SwarmHostingError('NOT_FOUND', 'Hosted swarm not found');
    }
    if (hosted.spawned_by !== agentId) {
      throw new SwarmHostingError('NOT_OWNER', 'You did not spawn this swarm');
    }

    const provider = this.providers.get(hosted.provider);
    if (!provider) {
      throw new SwarmHostingError('PROVIDER_NOT_AVAILABLE', `Provider "${hosted.provider}" not available`);
    }

    dal.updateHostedSwarm(hostedSwarmId, { state: 'stopping' });

    // Find the instance ID in the provider
    const instanceId = this.getInstanceId(hosted);
    if (!instanceId) {
      // No tracked instance — just mark as stopped
      dal.updateHostedSwarm(hostedSwarmId, { state: 'stopped', error: null });
      this.restartCounts.delete(hostedSwarmId);
      return dal.findHostedSwarmById(hostedSwarmId)!;
    }

    // Mark as intentionally stopping so exit handler doesn't auto-restart
    this.stoppingInstances.add(instanceId);

    try {
      await provider.deprovision(instanceId);
    } catch (err) {
      console.warn(`[swarm-manager] Error stopping instance ${instanceId}: ${(err as Error).message}`);
    }

    this.stoppingInstances.delete(instanceId);
    this.instanceToHostedId.delete(instanceId);
    this.hostedToInstanceId.delete(hostedSwarmId);

    // Release port
    if (hosted.assigned_port) {
      this.releasePort(hosted.assigned_port);
    }

    // Deregister from MAP hub if registered
    if (hosted.swarm_id) {
      try {
        mapDal.deleteSwarm(hosted.swarm_id);
      } catch { /* swarm may already be deleted */ }
    }

    dal.updateHostedSwarm(hostedSwarmId, { state: 'stopped', error: null });
    this.restartCounts.delete(hostedSwarmId);

    broadcastToChannel('map:discovery', {
      type: 'swarm_stopped',
      data: { hosted_swarm_id: hostedSwarmId },
    });

    return dal.findHostedSwarmById(hostedSwarmId)!;
  }

  // ==========================================================================
  // Restart
  // ==========================================================================

  async restart(hostedSwarmId: string, agentId: string): Promise<HostedSwarm> {
    const hosted = dal.findHostedSwarmById(hostedSwarmId);
    if (!hosted) {
      throw new SwarmHostingError('NOT_FOUND', 'Hosted swarm not found');
    }
    if (hosted.spawned_by !== agentId) {
      throw new SwarmHostingError('NOT_OWNER', 'You did not spawn this swarm');
    }

    const provider = this.providers.get(hosted.provider);
    if (!provider || !provider.restart) {
      throw new SwarmHostingError('RESTART_NOT_SUPPORTED', `Provider "${hosted.provider}" does not support restart`);
    }

    dal.updateHostedSwarm(hostedSwarmId, { state: 'starting', error: null });

    const instanceId = this.getInstanceId(hosted);
    if (!instanceId) {
      throw new SwarmHostingError('RESTART_FAILED', 'No tracked instance to restart');
    }

    try {
      const result = await provider.restart(instanceId);

      dal.updateHostedSwarm(hostedSwarmId, {
        pid: result.pid ?? null,
        endpoint: result.endpoint ?? null,
        state: 'running',
        error: null,
      });

      // Send heartbeat if registered in MAP hub
      if (hosted.swarm_id) {
        try {
          mapDal.heartbeatSwarm(hosted.swarm_id);
        } catch { /* swarm may not exist */ }
      }

      return dal.findHostedSwarmById(hostedSwarmId)!;
    } catch (err) {
      dal.updateHostedSwarm(hostedSwarmId, {
        state: 'failed',
        error: (err as Error).message,
      });
      throw new SwarmHostingError('RESTART_FAILED', `Failed to restart: ${(err as Error).message}`);
    }
  }

  // ==========================================================================
  // Logs
  // ==========================================================================

  async getLogs(hostedSwarmId: string, agentId: string, opts?: { lines?: number }): Promise<string> {
    const hosted = dal.findHostedSwarmById(hostedSwarmId);
    if (!hosted) {
      throw new SwarmHostingError('NOT_FOUND', 'Hosted swarm not found');
    }
    if (hosted.spawned_by !== agentId) {
      throw new SwarmHostingError('NOT_OWNER', 'You did not spawn this swarm');
    }

    const provider = this.providers.get(hosted.provider);
    if (!provider) return '(provider not available)';

    const instanceId = this.getInstanceId(hosted);
    if (!instanceId) return '(no tracked instance)';
    return provider.getLogs(instanceId, { lines: opts?.lines ?? 100 });
  }

  // ==========================================================================
  // Health Monitoring
  // ==========================================================================

  /** Start the periodic health check loop */
  startHealthMonitor(): void {
    if (this.healthInterval) return;

    this.healthInterval = setInterval(async () => {
      await this.runHealthChecks();
    }, this.config.health_check_interval);

    console.log(`[swarm-manager] Health monitor started (interval: ${this.config.health_check_interval}ms)`);
  }

  /** Stop the health check loop */
  stopHealthMonitor(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  private async runHealthChecks(): Promise<void> {
    const active = dal.getActiveHostedSwarms();

    for (const hosted of active) {
      if (hosted.state === 'stopping' || hosted.state === 'provisioning') continue;

      const provider = this.providers.get(hosted.provider);
      if (!provider) continue;

      const instanceId = this.getInstanceId(hosted);

      // No tracked instance — skip (process may have been managed before a server restart)
      if (!instanceId) continue;

      try {
        const status = await provider.getStatus(instanceId);

        if (status.state === 'stopped' || status.state === 'failed') {
          dal.updateHostedSwarm(hosted.id, {
            state: status.state,
            error: status.error ?? null,
          });
          if (hosted.assigned_port) this.releasePort(hosted.assigned_port);
          continue;
        }

        // If running, try HTTP health check on the gateway port
        if (hosted.assigned_port && status.state === 'running') {
          const httpPort = hosted.assigned_port + 1; // OpenSwarm gateway HTTP is port+1
          const healthy = await this.checkHttpHealth(httpPort);

          if (healthy) {
            // Reset failures, ensure state is running
            if (provider instanceof LocalProvider || provider instanceof SandboxedLocalProvider) {
              (provider as LocalProvider | SandboxedLocalProvider).resetHealthFailures(instanceId);
            }
            if (hosted.state !== 'running') {
              dal.updateHostedSwarm(hosted.id, { state: 'running', error: null });
            }
            // Send heartbeat to MAP hub
            if (hosted.swarm_id) {
              try { mapDal.heartbeatSwarm(hosted.swarm_id); } catch { /* ignore */ }
            }
          } else {
            let failures = 1;
            if (provider instanceof LocalProvider || provider instanceof SandboxedLocalProvider) {
              failures = (provider as LocalProvider | SandboxedLocalProvider).recordHealthFailure(instanceId);
            }

            if (failures >= this.config.max_health_failures) {
              dal.updateHostedSwarm(hosted.id, {
                state: 'unhealthy',
                error: `Health check failed ${failures} consecutive times`,
              });
            }
          }
        }
      } catch (err) {
        console.warn(`[swarm-manager] Health check error for ${hosted.id}: ${(err as Error).message}`);
      }
    }
  }

  // ==========================================================================
  // Shutdown
  // ==========================================================================

  /** Gracefully stop all hosted swarms and clean up */
  async shutdown(): Promise<void> {
    this.stopHealthMonitor();

    // Disable exit handler before stopping — otherwise handleProcessExit
    // sees SIGTERM exits as crashes and tries to auto-restart, spawning
    // new child processes that prevent the Node process from exiting.
    const localProvider = this.providers.get('local');
    if (localProvider instanceof LocalProvider) {
      localProvider.onProcessExit = null;
      await localProvider.stopAll();
      localProvider.removeExitHandler();
    }

    const sandboxedProvider = this.providers.get('local-sandboxed');
    if (sandboxedProvider instanceof SandboxedLocalProvider) {
      sandboxedProvider.onProcessExit = null;
      await sandboxedProvider.stopAll();
      sandboxedProvider.removeExitHandler();
    }

    // Mark all active hosted swarms as stopped and clean up MAP registrations
    const active = dal.getActiveHostedSwarms();
    for (const hosted of active) {
      if (hosted.swarm_id) {
        try { mapDal.deleteSwarm(hosted.swarm_id); } catch { /* may already be deleted */ }
      }
      dal.updateHostedSwarm(hosted.id, { state: 'stopped' });
    }

    console.log('[swarm-manager] Shutdown complete');
  }

  // ==========================================================================
  // Process Exit Handler (Immediate Crash Detection)
  // ==========================================================================

  /**
   * Called immediately by LocalProvider when a child process exits.
   * This provides instant crash detection instead of waiting for the
   * next 30s health check interval.
   */
  private handleProcessExit(instanceId: string, code: number | null, signal: string | null): void {
    // If this was an intentional stop, don't do anything
    if (this.stoppingInstances.has(instanceId)) return;

    const hostedId = this.instanceToHostedId.get(instanceId);
    if (!hostedId) return;

    const hosted = dal.findHostedSwarmById(hostedId);
    if (!hosted) return;

    // Already in a terminal state
    if (hosted.state === 'stopped' || hosted.state === 'failed') return;

    const isGraceful = code === 0;
    const eventType = isGraceful ? 'swarm_shutdown' : 'swarm_crashed';
    const errorMsg = isGraceful
      ? 'Process exited gracefully'
      : `Process crashed (code=${code}, signal=${signal})`;

    console.warn(`[swarm-manager] ${eventType}: ${hosted.id} — ${errorMsg}`);

    // Log recent process output to help debug crashes
    if (!isGraceful) {
      const provider = this.providers.get(hosted.provider);
      if (provider) {
        provider.getLogs(instanceId, { lines: 15 }).then((recentLogs) => {
          if (recentLogs && recentLogs !== '(no logs — instance not found)') {
            console.warn(`[swarm-manager] Recent output from ${hosted.id}:\n${recentLogs}`);
          }
        }).catch(() => { /* ignore log retrieval errors */ });
      }
    }

    // Update DB state
    dal.updateHostedSwarm(hostedId, {
      state: isGraceful ? 'stopped' : 'failed',
      error: isGraceful ? null : errorMsg,
    });

    // Release port
    if (hosted.assigned_port) {
      this.releasePort(hosted.assigned_port);
    }

    // Broadcast crash/shutdown event to connected clients
    broadcastToChannel('map:discovery', {
      type: eventType,
      data: {
        hosted_swarm_id: hostedId,
        name: hosted.config?.name,
        code,
        signal,
        error: errorMsg,
      },
    });

    // Auto-restart if configured and this was a crash (not graceful shutdown)
    if (!isGraceful && this.config.auto_restart && hosted.config) {
      const restartCount = this.restartCounts.get(hostedId) ?? 0;

      const maxAttempts = this.config.max_restart_attempts;
      if (maxAttempts > 0 && restartCount >= maxAttempts) {
        console.warn(
          `[swarm-manager] Swarm ${hostedId} exceeded max restart attempts (${maxAttempts}), not restarting`,
        );
        dal.updateHostedSwarm(hostedId, {
          error: `${errorMsg} — exceeded max restart attempts (${maxAttempts})`,
        });
        this.restartCounts.delete(hostedId);
        return;
      }

      this.restartCounts.set(hostedId, restartCount + 1);
      console.log(`[swarm-manager] Auto-restarting swarm ${hostedId} (attempt ${restartCount + 1})`);

      // Clean up old mapping
      this.instanceToHostedId.delete(instanceId);
      this.hostedToInstanceId.delete(hostedId);

      // Re-provision asynchronously
      this.autoRestart(hostedId, hosted).catch((err) => {
        console.error(`[swarm-manager] Auto-restart failed for ${hostedId}: ${(err as Error).message}`);
        dal.updateHostedSwarm(hostedId, {
          state: 'failed',
          error: `Auto-restart failed: ${(err as Error).message}`,
        });
      });
    }
  }

  /**
   * Re-provision a crashed swarm using its saved config.
   */
  private async autoRestart(hostedId: string, hosted: HostedSwarm): Promise<void> {
    const provider = this.providers.get(hosted.provider);
    if (!provider || !hosted.config) {
      throw new Error('Cannot auto-restart: provider or config not available');
    }

    dal.updateHostedSwarm(hostedId, { state: 'starting', error: null });

    // Re-allocate a port (the old one was released)
    const port = this.allocatePort();
    if (!port) {
      throw new Error('No ports available for restart');
    }

    // Re-resolve credentials from live config (not from DB — secrets are never persisted)
    const credRes = hosted.config.credential_resolution;
    const freshOverlay = resolveCredentialOverlay(
      this.config.credentials,
      credRes?.hive,
    );

    const config: SwarmProvisionConfig = {
      ...hosted.config,
      assigned_port: port,
      resolved_credentials: Object.keys(freshOverlay).length > 0 ? freshOverlay : undefined,
      inherit_env: credRes?.inherit_env ?? (this.config.credentials?.inherit_env !== false),
    };
    const result = await provider.provision(config);

    // Track new instance mapping
    this.instanceToHostedId.set(result.instance_id, hostedId);
    this.hostedToInstanceId.set(hostedId, result.instance_id);

    dal.updateHostedSwarm(hostedId, {
      pid: result.pid ?? null,
      assigned_port: port,
      endpoint: result.endpoint ?? null,
    });

    // Wait for health
    const healthy = await this.waitForHealth(port, 30000);
    if (!healthy) {
      dal.updateHostedSwarm(hostedId, {
        state: 'unhealthy',
        error: 'Health check timed out after restart',
      });
      return;
    }

    dal.updateHostedSwarm(hostedId, { state: 'running', error: null });
    this.restartCounts.delete(hostedId);

    // Send heartbeat if registered in MAP hub
    if (hosted.swarm_id) {
      try {
        mapDal.heartbeatSwarm(hosted.swarm_id);
      } catch { /* swarm may not exist */ }
    }

    broadcastToChannel('map:discovery', {
      type: 'swarm_restarted',
      data: {
        hosted_swarm_id: hostedId,
        name: hosted.config?.name,
        new_port: port,
      },
    });
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Resolve the sandbox policy for a swarm, merging default + hive overrides.
   */
  private resolveSandboxPolicy(hive?: string): SwarmSandboxPolicy | undefined {
    const sandboxConfig = this.config.sandbox;
    if (!sandboxConfig?.enabled) return undefined;

    const defaultPolicy = sandboxConfig.default_policy ?? {};

    if (!hive || !sandboxConfig.hive_overrides?.[hive]) {
      return defaultPolicy;
    }

    // Merge: hive override fields take precedence over defaults
    const hiveOverride = sandboxConfig.hive_overrides[hive];
    return {
      allowed_domains: hiveOverride.allowed_domains ?? defaultPolicy.allowed_domains,
      denied_domains: hiveOverride.denied_domains ?? defaultPolicy.denied_domains,
      allow_local_binding: hiveOverride.allow_local_binding ?? defaultPolicy.allow_local_binding,
      allow_write: hiveOverride.allow_write ?? defaultPolicy.allow_write,
      deny_write: hiveOverride.deny_write ?? defaultPolicy.deny_write,
      deny_read: hiveOverride.deny_read ?? defaultPolicy.deny_read,
      allow_pty: hiveOverride.allow_pty ?? defaultPolicy.allow_pty,
    };
  }

  private allocatePort(): number | null {
    const [min, max] = this.config.port_range;
    for (let port = min; port <= max; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    return null;
  }

  private releasePort(port: number): void {
    this.usedPorts.delete(port);
  }

  private getInstanceId(hosted: HostedSwarm): string | null {
    // Use the tracked mapping instead of reconstructing from timestamps
    // (SQLite datetime truncates milliseconds, causing ID mismatches)
    return this.hostedToInstanceId.get(hosted.id) ?? null;
  }

  private async waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
    const httpPort = port + 1; // OpenSwarm gateway HTTP is on port+1
    const start = Date.now();
    const interval = 1000;

    while (Date.now() - start < timeoutMs) {
      if (await this.checkHttpHealth(httpPort)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    return false;
  }

  private async checkHttpHealth(httpPort: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(`http://127.0.0.1:${httpPort}/health`, {
        signal: controller.signal,
      });

      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Error Type
// ============================================================================

export type SwarmHostingErrorCode =
  | 'MAX_SWARMS_REACHED'
  | 'PROVIDER_NOT_AVAILABLE'
  | 'NO_PORTS_AVAILABLE'
  | 'HIVE_NOT_FOUND'
  | 'PREAUTH_KEY_FAILED'
  | 'WORKSPACE_SETUP_FAILED'
  | 'SPAWN_FAILED'
  | 'NOT_FOUND'
  | 'NOT_OWNER'
  | 'RESTART_NOT_SUPPORTED'
  | 'RESTART_FAILED';

export class SwarmHostingError extends Error {
  code: SwarmHostingErrorCode;

  constructor(code: SwarmHostingErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'SwarmHostingError';
  }
}
