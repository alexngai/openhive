/**
 * MAP Sync Client
 *
 * Client-side module for swarm runtimes to participate in MAP sync.
 * Handles emitting JSON-RPC 2.0 sync notifications after tool operations
 * and reacting to received sync notifications by triggering tool pulls.
 *
 * Swarm runtimes import this module and wire it into their tool lifecycle.
 *
 * Usage:
 *   const client = new MapSyncClient(config);
 *   await client.start();
 *
 *   // After minimem push:
 *   client.emitMemorySync({ resource_id: 'res_abc', commit_hash: 'abc123' });
 *
 *   // Handle incoming sync from other swarms:
 *   client.onMemorySync((msg) => { minimem.pull(msg.params.resource_id); });
 *   client.onSkillSync((msg) => { skillTree.refreshRemote(msg.params.resource_id); });
 *
 *   await client.stop();
 */

import WebSocket from 'ws';
import type { MapSyncMessage, MapSyncMethod } from './types.js';
import { SYNC_METHODS, createSyncNotification } from './types.js';
import type {
  MapCoordinationMessage,
  TaskStatusParams,
  ContextShareParams,
  MessageSendParams,
} from 'openhive-types';
import { COORDINATION_METHODS, createCoordinationNotification } from 'openhive-types';

// ============================================================================
// Types
// ============================================================================

export interface SyncResource {
  /** The syncable_resources ID from OpenHive */
  resource_id: string;
  /** The git remote URL for pulling content */
  git_remote_url: string;
  /** Local directory path for this resource */
  local_dir: string;
  /** Resource type for routing */
  type: 'memory_bank' | 'skill';
}

/**
 * Result of checking a resource for updates.
 * The poll checker returns this for each resource that has changes.
 */
export interface PollCheckResult {
  resource_id: string;
  /** The new commit hash on the remote */
  commit_hash: string;
}

/**
 * A function that checks subscribed resources for updates.
 * Receives the list of subscribed resources and returns those that have changed.
 * Implementation is up to the consumer — can use git ls-remote, OpenHive API, etc.
 */
export type PollChecker = (resources: SyncResource[]) => Promise<PollCheckResult[]>;

export interface MapSyncClientConfig {
  /** The agent ID of this swarm's owner */
  agent_id: string;
  /** WebSocket URL of the OpenHive hub (for receiving relayed messages) */
  hub_ws_url?: string;
  /** Resources this swarm owns (for emitting sync messages) */
  owned_resources?: SyncResource[];
  /** Resources this swarm subscribes to (for receiving sync messages) */
  subscribed_resources?: SyncResource[];
  /** Polling interval in ms for catching up on missed messages (0 = disabled) */
  poll_interval_ms?: number;
  /**
   * Function to check subscribed resources for updates during polling.
   * If not provided, polling is disabled even if poll_interval_ms is set.
   */
  poll_checker?: PollChecker;
}

export type SyncMessageHandler = (msg: MapSyncMessage, resource: SyncResource) => void;
export type CoordinationMessageHandler = (msg: MapCoordinationMessage) => void;

// ============================================================================
// Client
// ============================================================================

export class MapSyncClient {
  private config: MapSyncClientConfig;
  private hubWs: WebSocket | null = null;
  private memoryHandlers: SyncMessageHandler[] = [];
  private skillHandlers: SyncMessageHandler[] = [];
  private taskAssignHandlers: CoordinationMessageHandler[] = [];
  private taskStatusHandlers: CoordinationMessageHandler[] = [];
  private contextShareHandlers: CoordinationMessageHandler[] = [];
  private messageHandlers: CoordinationMessageHandler[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private wsClients: Set<WebSocket> = new Set();
  private running = false;

  private static readonly RECONNECT_BASE_MS = 5_000;
  private static readonly RECONNECT_MAX_MS = 60_000;
  private static readonly MAX_RECONNECT_ATTEMPTS = 20;

  constructor(config: MapSyncClientConfig) {
    this.config = config;
  }

  // --------------------------------------------------------------------------
  // Emit sync notifications (swarm → hub)
  // --------------------------------------------------------------------------

  /**
   * Emit an x-openhive/memory.sync notification after minimem pushes to git.
   */
  emitMemorySync(params: { resource_id: string; commit_hash: string }): void {
    this.broadcast(createSyncNotification('x-openhive/memory.sync', {
      resource_id: params.resource_id,
      agent_id: this.config.agent_id,
      commit_hash: params.commit_hash,
      timestamp: new Date().toISOString(),
    }));
  }

  /**
   * Emit an x-openhive/skill.sync notification after skill-tree pushes to git.
   */
  emitSkillSync(params: { resource_id: string; commit_hash: string }): void {
    this.broadcast(createSyncNotification('x-openhive/skill.sync', {
      resource_id: params.resource_id,
      agent_id: this.config.agent_id,
      commit_hash: params.commit_hash,
      timestamp: new Date().toISOString(),
    }));
  }

  // --------------------------------------------------------------------------
  // Subscribe to incoming sync notifications (hub → swarm)
  // --------------------------------------------------------------------------

  /**
   * Register a handler for incoming x-openhive/memory.sync notifications.
   */
  onMemorySync(handler: SyncMessageHandler): void {
    this.memoryHandlers.push(handler);
  }

  /**
   * Register a handler for incoming x-openhive/skill.sync notifications.
   */
  onSkillSync(handler: SyncMessageHandler): void {
    this.skillHandlers.push(handler);
  }

  // --------------------------------------------------------------------------
  // Emit coordination notifications (swarm → hub)
  // --------------------------------------------------------------------------

  /**
   * Emit an x-openhive/task.status notification to report task progress.
   */
  emitTaskStatus(params: TaskStatusParams): void {
    this.broadcastCoordination(createCoordinationNotification('x-openhive/task.status', params));
  }

  /**
   * Emit an x-openhive/context.share notification to share context with peers.
   */
  emitContextShare(params: ContextShareParams): void {
    this.broadcastCoordination(createCoordinationNotification('x-openhive/context.share', params));
  }

  /**
   * Emit an x-openhive/message.send notification to send a message to another swarm.
   */
  emitMessage(params: MessageSendParams): void {
    this.broadcastCoordination(createCoordinationNotification('x-openhive/message.send', params));
  }

  // --------------------------------------------------------------------------
  // Subscribe to incoming coordination notifications (hub → swarm)
  // --------------------------------------------------------------------------

  /**
   * Register a handler for incoming x-openhive/task.assign notifications.
   */
  onTaskAssigned(handler: CoordinationMessageHandler): void {
    this.taskAssignHandlers.push(handler);
  }

  /**
   * Register a handler for incoming x-openhive/task.status notifications.
   */
  onTaskStatus(handler: CoordinationMessageHandler): void {
    this.taskStatusHandlers.push(handler);
  }

  /**
   * Register a handler for incoming x-openhive/context.share notifications.
   */
  onContextShared(handler: CoordinationMessageHandler): void {
    this.contextShareHandlers.push(handler);
  }

  /**
   * Register a handler for incoming x-openhive/message.send notifications.
   */
  onMessage(handler: CoordinationMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  // --------------------------------------------------------------------------
  // WebSocket Server (swarm's own MAP endpoint)
  // --------------------------------------------------------------------------

  /**
   * Handle an incoming WebSocket connection to this swarm's MAP endpoint.
   * Call this from the swarm's WebSocket server when a new connection arrives.
   * OpenHive's sync listener will connect here to listen for sync notifications.
   */
  handleIncomingConnection(ws: WebSocket): void {
    this.wsClients.add(ws);
    ws.on('close', () => this.wsClients.delete(ws));
    ws.on('error', () => this.wsClients.delete(ws));
  }

  /**
   * Broadcast a sync notification to all connected clients (including OpenHive).
   */
  private broadcast(msg: MapSyncMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /**
   * Broadcast a coordination notification to all connected clients.
   */
  private broadcastCoordination(msg: MapCoordinationMessage): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Hub Connection (receive relayed notifications from OpenHive)
  // --------------------------------------------------------------------------

  private connectToHub(): void {
    if (!this.config.hub_ws_url || !this.running) return;

    try {
      const ws = new WebSocket(this.config.hub_ws_url);
      this.hubWs = ws;

      ws.on('open', () => {
        this.reconnectAttempts = 0;
      });

      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          if (parsed?.jsonrpc !== '2.0' || typeof parsed?.method !== 'string') return;

          if (SYNC_METHODS.has(parsed.method)) {
            this.handleIncomingSync(parsed as MapSyncMessage);
          } else if (COORDINATION_METHODS.has(parsed.method)) {
            this.handleIncomingCoordination(parsed as MapCoordinationMessage);
          }
        } catch {
          // Ignore non-JSON or unrecognized messages
        }
      });

      ws.on('close', () => {
        this.hubWs = null;
        if (this.running) this.scheduleReconnect();
      });

      ws.on('error', () => {
        // close event will fire after error
      });
    } catch {
      if (this.running) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.running) return;
    if (this.reconnectAttempts >= MapSyncClient.MAX_RECONNECT_ATTEMPTS) return;

    const delay = Math.min(
      MapSyncClient.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      MapSyncClient.RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectToHub();
    }, delay);
  }

  private handleIncomingSync(msg: MapSyncMessage): void {
    // Ignore own messages
    if (msg.params.agent_id === this.config.agent_id) return;

    // Must be a known sync method
    if (!SYNC_METHODS.has(msg.method)) return;

    // Find matching subscribed resource
    const resource = this.config.subscribed_resources?.find(
      (r) => r.resource_id === msg.params.resource_id,
    );
    if (!resource) return;

    // Dispatch to handlers
    const handlers = msg.method === 'x-openhive/memory.sync' ? this.memoryHandlers : this.skillHandlers;
    for (const handler of handlers) {
      try {
        handler(msg, resource);
      } catch (err) {
        console.error(`[map-sync-client] Handler error for ${msg.method}:`, err);
      }
    }
  }

  private handleIncomingCoordination(msg: MapCoordinationMessage): void {
    const handlerMap: Record<string, CoordinationMessageHandler[]> = {
      'x-openhive/task.assign': this.taskAssignHandlers,
      'x-openhive/task.status': this.taskStatusHandlers,
      'x-openhive/context.share': this.contextShareHandlers,
      'x-openhive/message.send': this.messageHandlers,
    };

    const handlers = handlerMap[msg.method];
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(msg);
      } catch (err) {
        console.error(`[map-sync-client] Coordination handler error for ${msg.method}:`, err);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Polling (fallback for missed notifications)
  // --------------------------------------------------------------------------

  private polling = false;

  private startPolling(): void {
    const interval = this.config.poll_interval_ms;
    if (!interval || interval <= 0 || !this.config.poll_checker) return;

    // Run an initial poll on startup to catch up on anything missed while offline
    this.runPollCycle();

    this.pollTimer = setInterval(() => {
      this.runPollCycle();
    }, interval);
  }

  private async runPollCycle(): Promise<void> {
    if (this.polling || !this.running) return;
    const checker = this.config.poll_checker;
    const resources = this.config.subscribed_resources;
    if (!checker || !resources?.length) return;

    this.polling = true;
    try {
      const updates = await checker(resources);
      for (const update of updates) {
        const resource = resources.find((r) => r.resource_id === update.resource_id);
        if (!resource) continue;

        const method: MapSyncMethod = resource.type === 'memory_bank'
          ? 'x-openhive/memory.sync'
          : 'x-openhive/skill.sync';

        const syntheticMsg = createSyncNotification(method, {
          resource_id: update.resource_id,
          agent_id: 'poll',
          commit_hash: update.commit_hash,
          timestamp: new Date().toISOString(),
        });

        const handlers = method === 'x-openhive/memory.sync' ? this.memoryHandlers : this.skillHandlers;
        for (const handler of handlers) {
          try {
            handler(syntheticMsg, resource);
          } catch (err) {
            console.error(`[map-sync-client] Poll handler error for ${method}:`, err);
          }
        }
      }
    } catch (err) {
      console.error('[map-sync-client] Poll cycle error:', err);
    } finally {
      this.polling = false;
    }
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Start the sync client. Connects to the hub and begins polling.
   */
  start(): void {
    this.running = true;
    this.connectToHub();
    this.startPolling();
  }

  /**
   * Stop the sync client. Disconnects from the hub and stops polling.
   */
  stop(): void {
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.hubWs) {
      this.hubWs.close();
      this.hubWs = null;
    }

    // Close all inbound connections
    for (const ws of this.wsClients) {
      ws.close();
    }
    this.wsClients.clear();
  }
}
