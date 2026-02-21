/**
 * Bridge Manager
 *
 * Server-level service that manages bridge adapter lifecycles,
 * wires adapters to the inbound/outbound pipelines, and handles
 * reconnection with exponential backoff.
 */

import * as bridgeDAL from '../db/dal/bridge.js';
import { decryptCredentials } from './credentials.js';
import { processInboundMessage } from './inbound.js';
import { processOutboundEvent, type HiveEvent } from './outbound.js';
import type {
  BridgeConfig,
  BridgeAdapter,
  ChannelMapping,
  RunningBridgeStatus,
  AdapterConfig,
} from './types.js';

// ============================================================================
// Types
// ============================================================================

type AdapterFactory = () => BridgeAdapter;

interface ManagedBridge {
  config: BridgeConfig;
  adapter: BridgeAdapter;
  mappings: ChannelMapping[];
  status: RunningBridgeStatus;
  error?: string;
  abortController: AbortController;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempts: number;
}

export interface BridgeStatus {
  id: string;
  name: string;
  platform: string;
  status: RunningBridgeStatus;
  error?: string;
  channelCount: number;
}

interface BridgeManagerConfig {
  maxBridges: number;
  credentialEncryptionKey?: string;
  webhookBaseUrl?: string;
}

// ============================================================================
// Constants
// ============================================================================

const MAX_RECONNECT_DELAY = 60_000; // 1 minute
const BASE_RECONNECT_DELAY = 1_000; // 1 second

// ============================================================================
// BridgeManager
// ============================================================================

export class BridgeManager {
  private bridges = new Map<string, ManagedBridge>();
  private adapterRegistry = new Map<string, AdapterFactory>();
  private config: BridgeManagerConfig;

  constructor(config: BridgeManagerConfig) {
    this.config = config;
  }

  /**
   * Register an adapter factory for a platform.
   * Takes priority over built-in adapters. Useful for tests
   * or custom/third-party adapters.
   */
  registerAdapter(platform: string, factory: AdapterFactory): void {
    this.adapterRegistry.set(platform, factory);
  }

  /**
   * Start all active bridges from the database.
   * Called during server startup.
   */
  async startAll(): Promise<void> {
    const configs = bridgeDAL.listBridges();
    const active = configs.filter(c => c.status === 'active');

    for (const config of active) {
      try {
        await this.startBridge(config.id);
      } catch (err) {
        console.error(`Failed to start bridge ${config.name}:`, err);
      }
    }
  }

  /**
   * Start a specific bridge by ID.
   */
  async startBridge(id: string): Promise<void> {
    // Check if already running
    if (this.bridges.has(id)) {
      throw new Error(`Bridge ${id} is already running`);
    }

    // Check max bridges limit
    if (this.bridges.size >= this.config.maxBridges) {
      throw new Error(`Maximum bridge limit (${this.config.maxBridges}) reached`);
    }

    // Load bridge config
    const config = bridgeDAL.getBridge(id);
    if (!config) {
      throw new Error(`Bridge ${id} not found`);
    }

    // Resolve adapter factory: prefer registered factory, fall back to dynamic import
    const factory = this.adapterRegistry.get(config.platform)
      ?? await this.loadBuiltinAdapter(config.platform);

    // Decrypt credentials
    const encryptionKey = this.config.credentialEncryptionKey;
    if (!encryptionKey) {
      throw new Error('Bridge credential encryption key not configured');
    }

    let credentials: Record<string, string>;
    try {
      credentials = decryptCredentials(config.credentials_encrypted, encryptionKey);
    } catch (err) {
      bridgeDAL.updateBridge(id, {
        status: 'error',
        error_message: 'Failed to decrypt credentials',
      });
      throw new Error(`Failed to decrypt credentials for bridge ${config.name}`);
    }

    // Load channel mappings
    const mappings = bridgeDAL.getChannelMappings(id);

    // Create adapter instance
    const adapter = factory();
    const abortController = new AbortController();

    const managed: ManagedBridge = {
      config,
      adapter,
      mappings,
      status: 'connecting',
      abortController,
      reconnectAttempts: 0,
    };

    this.bridges.set(id, managed);

    // Connect adapter
    try {
      const adapterConfig: AdapterConfig = {
        mode: config.transport_mode,
        credentials,
        channelMappings: mappings,
        webhookBaseUrl: this.config.webhookBaseUrl,
        bridgeId: id,
      };

      await adapter.connect(adapterConfig);
      managed.status = 'connected';
      managed.reconnectAttempts = 0;

      // Update DB status
      bridgeDAL.updateBridge(id, { status: 'active', error_message: null });

      // Start message loop
      this.runMessageLoop(id, abortController.signal);
    } catch (err) {
      managed.status = 'error';
      managed.error = err instanceof Error ? err.message : String(err);

      bridgeDAL.updateBridge(id, {
        status: 'error',
        error_message: managed.error,
      });

      // Schedule reconnection
      this.scheduleReconnect(id);
    }
  }

  /**
   * Stop a specific bridge.
   */
  async stopBridge(id: string): Promise<void> {
    const managed = this.bridges.get(id);
    if (!managed) return;

    // Cancel reconnect timer
    if (managed.reconnectTimer) {
      clearTimeout(managed.reconnectTimer);
    }

    // Abort message loop
    managed.abortController.abort();

    // Disconnect adapter
    try {
      await managed.adapter.disconnect();
    } catch (err) {
      console.error(`Error disconnecting bridge ${managed.config.name}:`, err);
    }

    managed.status = 'disconnected';
    this.bridges.delete(id);

    // Update DB status
    bridgeDAL.updateBridge(id, { status: 'inactive', error_message: null });
  }

  /**
   * Stop all running bridges. Called during graceful shutdown.
   */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.bridges.keys());
    await Promise.allSettled(ids.map(id => this.stopBridge(id)));
  }

  /**
   * Get status of a specific bridge.
   */
  getBridgeStatus(id: string): BridgeStatus | null {
    const managed = this.bridges.get(id);
    if (!managed) {
      // Check if it exists in DB but not running
      const config = bridgeDAL.getBridge(id);
      if (!config) return null;
      return {
        id: config.id,
        name: config.name,
        platform: config.platform,
        status: 'disconnected',
        channelCount: bridgeDAL.getChannelMappings(id).length,
      };
    }

    return {
      id: managed.config.id,
      name: managed.config.name,
      platform: managed.config.platform,
      status: managed.status,
      error: managed.error,
      channelCount: managed.mappings.length,
    };
  }

  /**
   * Get status of all bridges (both running and stopped).
   */
  getAllStatuses(): BridgeStatus[] {
    const allConfigs = bridgeDAL.listBridges();
    return allConfigs.map(config => this.getBridgeStatus(config.id)!);
  }

  /**
   * Notify the bridge manager of a hive event (new post or comment).
   * Called by API routes after post/comment creation to trigger
   * outbound relay to all bridges that map to the affected hive.
   */
  notifyHiveEvent(event: HiveEvent): void {
    for (const [, managed] of this.bridges) {
      if (managed.status !== 'connected') continue;

      const actions = processOutboundEvent(
        managed.config,
        managed.mappings,
        event,
      );

      for (const action of actions) {
        managed.adapter.send(action.destination, action.message).catch(err => {
          console.error(
            `Failed to send outbound message to ${managed.config.name}:`,
            err,
          );
        });
      }
    }
  }

  /**
   * Reload channel mappings for a running bridge.
   * Call after adding/removing channel mappings.
   */
  reloadMappings(bridgeId: string): void {
    const managed = this.bridges.get(bridgeId);
    if (!managed) return;
    managed.mappings = bridgeDAL.getChannelMappings(bridgeId);
  }

  /**
   * Check if any bridges are currently running.
   */
  get isRunning(): boolean {
    return this.bridges.size > 0;
  }

  /**
   * Get the count of running bridges.
   */
  get runningCount(): number {
    return this.bridges.size;
  }

  // ── Internal ──

  /** Known built-in adapter modules, keyed by platform name. */
  private static readonly BUILTIN_ADAPTERS: Record<string, string> = {
    slack: './adapters/slack.js',
  };

  /**
   * Dynamically import a built-in adapter module for the given platform.
   * Caches the factory in the adapter registry so subsequent starts
   * don't re-import.
   */
  private async loadBuiltinAdapter(platform: string): Promise<AdapterFactory> {
    const modulePath = BridgeManager.BUILTIN_ADAPTERS[platform];
    if (!modulePath) {
      throw new Error(`No adapter registered for platform: ${platform}`);
    }

    try {
      const mod = await import(modulePath);
      // Convention: module exports a class named <Platform>Adapter (e.g. SlackAdapter)
      const className = platform.charAt(0).toUpperCase() + platform.slice(1) + 'Adapter';
      const AdapterClass = mod[className];
      if (!AdapterClass) {
        throw new Error(`Module ${modulePath} does not export ${className}`);
      }
      const factory: AdapterFactory = () => new AdapterClass();
      // Cache for future startBridge calls
      this.adapterRegistry.set(platform, factory);
      return factory;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('No adapter registered')) {
        throw err;
      }
      throw new Error(
        `Failed to load adapter for platform "${platform}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Run the inbound message loop for a bridge.
   * Iterates over the adapter's message stream and processes each.
   */
  private async runMessageLoop(bridgeId: string, signal: AbortSignal): Promise<void> {
    const managed = this.bridges.get(bridgeId);
    if (!managed) return;

    try {
      for await (const message of managed.adapter.messages()) {
        if (signal.aborted) break;

        try {
          processInboundMessage(bridgeId, message);
        } catch (err) {
          console.error(
            `Error processing inbound message for bridge ${managed.config.name}:`,
            err,
          );
        }
      }

      // Stream ended normally — adapter disconnected
      if (!signal.aborted) {
        managed.status = 'disconnected';
        this.scheduleReconnect(bridgeId);
      }
    } catch (err) {
      if (signal.aborted) return;

      managed.status = 'error';
      managed.error = err instanceof Error ? err.message : String(err);

      bridgeDAL.updateBridge(bridgeId, {
        status: 'error',
        error_message: managed.error,
      });

      this.scheduleReconnect(bridgeId);
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   */
  private scheduleReconnect(bridgeId: string): void {
    const managed = this.bridges.get(bridgeId);
    if (!managed || managed.abortController.signal.aborted) return;

    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(2, managed.reconnectAttempts),
      MAX_RECONNECT_DELAY,
    );
    managed.reconnectAttempts++;

    managed.reconnectTimer = setTimeout(async () => {
      if (managed.abortController.signal.aborted) return;

      // Remove the old managed bridge so startBridge can re-create it
      this.bridges.delete(bridgeId);

      try {
        await this.startBridge(bridgeId);
      } catch (err) {
        console.error(
          `Reconnection failed for bridge ${managed.config.name} (attempt ${managed.reconnectAttempts}):`,
          err,
        );
      }
    }, delay);
  }
}
