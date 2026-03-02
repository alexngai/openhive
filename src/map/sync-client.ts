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

import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import type { MapSyncMessage, MapSyncMethod } from './types.js';
import { SYNC_METHODS, createSyncNotification } from './types.js';
import type {
  MapCoordinationMessage,
  TaskStatusParams,
  ContextShareParams,
  MessageSendParams,
  SessionSyncParams,
  SessionContentRequest,
  SessionContentChunkParams,
} from '../shared/types/index.js';
import {
  COORDINATION_METHODS,
  createCoordinationNotification,
  createSessionSyncNotification,
  SESSION_CONTENT_METHOD,
  SESSION_CONTENT_CHUNK_METHOD,
  INLINE_TRANSCRIPT_THRESHOLD,
  STREAM_CHUNK_SIZE,
} from '../shared/types/index.js';

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

/** Callback that provides checkpoint content for serving content requests from the hub. */
export type SessionContentProvider = (checkpointId: string) => Promise<{
  metadata: Record<string, unknown>;
  transcript: string;
  prompts: string;
  context: string;
} | null>;

/** Handler for incoming session sync notifications (from other swarms via relay). */
export type SessionSyncHandler = (msg: MapSyncMessage) => void;

// ============================================================================
// Client
// ============================================================================

export class MapSyncClient {
  private config: MapSyncClientConfig;
  private hubWs: WebSocket | null = null;
  private memoryHandlers: SyncMessageHandler[] = [];
  private skillHandlers: SyncMessageHandler[] = [];
  private sessionHandlers: SessionSyncHandler[] = [];
  private taskAssignHandlers: CoordinationMessageHandler[] = [];
  private taskStatusHandlers: CoordinationMessageHandler[] = [];
  private contextShareHandlers: CoordinationMessageHandler[] = [];
  private messageHandlers: CoordinationMessageHandler[] = [];
  private contentProvider: SessionContentProvider | null = null;
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

  /**
   * Emit a trajectory/checkpoint notification after a sessionlog checkpoint is committed.
   * Carries richer metadata than memory/skill syncs — includes inline checkpoint summary.
   */
  emitSessionSync(params: {
    resource_id: string;
    commit_hash: string;
    checkpoint: SessionSyncParams['checkpoint'];
  }): void {
    const msg = createSessionSyncNotification({
      resource_id: params.resource_id,
      agent_id: this.config.agent_id,
      commit_hash: params.commit_hash,
      timestamp: new Date().toISOString(),
      checkpoint: params.checkpoint,
    });
    this.broadcastAny(msg);
  }

  /**
   * Set the content provider for serving checkpoint content requests from the hub.
   * The provider reads from the sessionlog checkpoint store.
   */
  setSessionContentProvider(provider: SessionContentProvider): void {
    this.contentProvider = provider;
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

  /**
   * Register a handler for incoming trajectory/checkpoint notifications (relayed).
   */
  onSessionSync(handler: SessionSyncHandler): void {
    this.sessionHandlers.push(handler);
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
   * OpenHive's sync listener will connect here to listen for sync notifications
   * and to send content requests.
   */
  handleIncomingConnection(ws: WebSocket): void {
    this.wsClients.add(ws);

    // Listen for incoming messages (e.g., content requests from hub)
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed?.jsonrpc !== '2.0') return;

        // Content request (JSON-RPC request with `id`)
        if (parsed.method === SESSION_CONTENT_METHOD && parsed.id) {
          this.handleContentRequest(parsed as SessionContentRequest, ws);
        }
      } catch {
        // Ignore non-JSON or unrecognized messages
      }
    });

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

  /**
   * Broadcast any JSON-RPC message to all connected clients.
   */
  private broadcastAny(msg: { jsonrpc: '2.0'; method: string; params: unknown }): void {
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
    if (msg.method === 'trajectory/checkpoint') {
      for (const handler of this.sessionHandlers) {
        try {
          handler(msg);
        } catch (err) {
          console.error(`[map-sync-client] Session sync handler error:`, err);
        }
      }
      return;
    }

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
  // Content Request Handling (hub requests checkpoint content)
  // --------------------------------------------------------------------------

  /**
   * Handle a trajectory/content request from the hub.
   * Reads checkpoint data via the content provider and responds inline or streams.
   */
  private async handleContentRequest(req: SessionContentRequest, ws: WebSocket): Promise<void> {
    const { checkpoint_id } = req.params;

    if (!this.contentProvider) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: 'No content provider configured' },
      }));
      return;
    }

    let content: Awaited<ReturnType<SessionContentProvider>>;
    try {
      content = await this.contentProvider(checkpoint_id);
    } catch (err) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: `Failed to read checkpoint: ${(err as Error).message}` },
      }));
      return;
    }

    if (!content) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32602, message: `Checkpoint not found: ${checkpoint_id}` },
      }));
      return;
    }

    const include = new Set(req.params.include ?? ['metadata', 'transcript', 'prompts', 'context']);
    const transcriptBytes = include.has('transcript') ? Buffer.from(content.transcript, 'utf-8') : null;

    // Build inline artifacts (small payloads)
    const artifacts: Record<string, unknown> = {};
    if (include.has('metadata')) artifacts.metadata = content.metadata;
    if (include.has('prompts')) artifacts.prompts = content.prompts;
    if (include.has('context')) artifacts.context = content.context;

    // Decide inline vs streaming based on transcript size
    if (!transcriptBytes || transcriptBytes.length < INLINE_TRANSCRIPT_THRESHOLD) {
      // Inline response — all artifacts fit in one message
      if (transcriptBytes) artifacts.transcript = content.transcript;
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          checkpoint_id,
          streaming: false,
          artifacts,
        },
      }));
      return;
    }

    // Streaming response — transcript artifact will arrive as chunks
    const chunks = chunkBuffer(transcriptBytes, STREAM_CHUNK_SIZE);
    const streamId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Send initial response with small artifacts inline + stream info
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        checkpoint_id,
        streaming: true,
        stream_id: streamId,
        artifacts,
        stream_artifact: 'transcript',
        stream_info: {
          total_bytes: transcriptBytes.length,
          total_chunks: chunks.length,
          encoding: 'base64',
        },
      },
    }));

    // Compute full checksum
    const checksum = createHash('sha256').update(transcriptBytes).digest('hex');

    // Send chunks
    for (let i = 0; i < chunks.length; i++) {
      const isFinal = i === chunks.length - 1;
      const chunk: { jsonrpc: '2.0'; method: typeof SESSION_CONTENT_CHUNK_METHOD; params: SessionContentChunkParams } = {
        jsonrpc: '2.0',
        method: SESSION_CONTENT_CHUNK_METHOD,
        params: {
          stream_id: streamId,
          index: i,
          data: chunks[i].toString('base64'),
          ...(isFinal ? { final: true, checksum: `sha256:${checksum}` } : {}),
        },
      };

      if (ws.readyState !== WebSocket.OPEN) break;
      ws.send(JSON.stringify(chunk));
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

// ============================================================================
// Helpers
// ============================================================================

/** Split a buffer into chunks of at most `maxSize` bytes, splitting on newline boundaries. */
function chunkBuffer(buf: Buffer, maxSize: number): Buffer[] {
  if (buf.length <= maxSize) return [buf];

  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < buf.length) {
    let end = Math.min(offset + maxSize, buf.length);

    // If we're not at the end of the buffer, find the last newline within this chunk
    if (end < buf.length) {
      const lastNewline = buf.lastIndexOf(0x0a, end - 1);
      if (lastNewline > offset) {
        end = lastNewline + 1; // Include the newline
      }
    }

    chunks.push(buf.subarray(offset, end));
    offset = end;
  }

  return chunks;
}
