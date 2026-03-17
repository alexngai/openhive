/**
 * Mesh Channels — Hub-level MessageChannel abstraction
 *
 * Provides named protocol channels with per-channel stats, offline queueing,
 * and request/response RPC. Since the hub uses MeshPeer (MapServer) rather
 * than NebulaMesh directly, this module implements the MessageChannel semantics
 * at the hub coordination layer.
 *
 * Channel naming convention: `proto:<protocol>` (e.g. proto:resource-sync,
 * proto:coordination, proto:mail, proto:federation).
 */

import { nanoid } from 'nanoid';
import { sendToSwarm } from './sync-listener.js';

// ============================================================================
// Types
// ============================================================================

export interface HubChannelConfig {
  /** Queue messages when target swarm is offline */
  enableOfflineQueue?: boolean;
  /** TTL for queued messages in milliseconds */
  offlineQueueTTL?: number;
  /** Maximum queued messages per target */
  maxQueueSize?: number;
  /** Timeout for request/response RPC in milliseconds */
  rpcTimeout?: number;
}

export interface ChannelStats {
  messagesSent: number;
  messagesReceived: number;
  queuedMessages: number;
  failedDeliveries: number;
  rpcRequestsSent: number;
  rpcResponsesReceived: number;
  rpcTimeouts: number;
}

interface QueuedMessage {
  id: string;
  targetSwarmId: string;
  payload: object;
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ============================================================================
// HubChannel
// ============================================================================

export class HubChannel {
  readonly name: string;
  private readonly config: Required<HubChannelConfig>;
  private stats: ChannelStats;
  /** Per-swarm offline queues */
  private queues: Map<string, QueuedMessage[]> = new Map();
  /** Pending RPC requests keyed by request ID */
  private pendingRpcs: Map<string, PendingRpc> = new Map();
  /** Optional request handler for incoming RPCs */
  private requestHandler: ((payload: unknown, fromSwarmId: string) => Promise<unknown>) | null = null;

  constructor(name: string, config?: HubChannelConfig) {
    this.name = name;
    this.config = {
      enableOfflineQueue: config?.enableOfflineQueue ?? false,
      offlineQueueTTL: config?.offlineQueueTTL ?? 3_600_000, // 1h default
      maxQueueSize: config?.maxQueueSize ?? 1000,
      rpcTimeout: config?.rpcTimeout ?? 30_000,
    };
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      queuedMessages: 0,
      failedDeliveries: 0,
      rpcRequestsSent: 0,
      rpcResponsesReceived: 0,
      rpcTimeouts: 0,
    };
  }

  /**
   * Send a message on this channel to a specific swarm.
   * If sending fails and offline queueing is enabled, the message is queued.
   */
  send(targetSwarmId: string, payload: object): boolean {
    const envelope = this.wrapEnvelope(payload);
    let sent = sendToSwarm(targetSwarmId, envelope);

    if (sent) {
      this.stats.messagesSent++;
      return true;
    }

    // Queue if enabled
    if (this.config.enableOfflineQueue) {
      this.enqueue(targetSwarmId, envelope);
      return false; // Not delivered, but queued
    }

    this.stats.failedDeliveries++;
    return false;
  }

  /**
   * Broadcast a message on this channel to multiple swarms.
   */
  broadcast(targetSwarmIds: string[], payload: object): Map<string, boolean> {
    const results = new Map<string, boolean>();
    for (const swarmId of targetSwarmIds) {
      results.set(swarmId, this.send(swarmId, payload));
    }
    return results;
  }

  /**
   * Send an RPC request and await the response.
   */
  async request<R = unknown>(targetSwarmId: string, payload: object, timeout?: number): Promise<R> {
    const requestId = nanoid();
    const rpcTimeout = timeout ?? this.config.rpcTimeout;

    const envelope = this.wrapEnvelope(payload, 'request', requestId);
    const sent = sendToSwarm(targetSwarmId, envelope);

    if (!sent) {
      this.stats.failedDeliveries++;
      throw new Error(`Failed to send RPC request on channel ${this.name} to ${targetSwarmId}`);
    }

    this.stats.rpcRequestsSent++;
    this.stats.messagesSent++;

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(requestId);
        this.stats.rpcTimeouts++;
        reject(new Error(`RPC timeout on channel ${this.name} (${rpcTimeout}ms)`));
      }, rpcTimeout);

      this.pendingRpcs.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
    });
  }

  /**
   * Register a handler for incoming RPC requests on this channel.
   */
  onRequest(handler: (payload: unknown, fromSwarmId: string) => Promise<unknown>): void {
    this.requestHandler = handler;
  }

  /**
   * Remove the RPC request handler.
   */
  offRequest(): void {
    this.requestHandler = null;
  }

  /**
   * Record an outbound message sent on this channel (bypassing channel.send()).
   * Used by federation bridge which routes via gateway directly.
   */
  recordSent(): void {
    this.stats.messagesSent++;
  }

  /**
   * Record an incoming message received on this channel.
   * Called by dispatch to track stats. If it's an RPC response, resolves the pending request.
   */
  recordReceived(payload: unknown, fromSwarmId: string): void {
    this.stats.messagesReceived++;

    // Check if this is an RPC response
    const msg = payload as Record<string, unknown>;
    if (msg._channel_type === 'response' && msg._channel_request_id) {
      const pending = this.pendingRpcs.get(msg._channel_request_id as string);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRpcs.delete(msg._channel_request_id as string);
        this.stats.rpcResponsesReceived++;
        pending.resolve(msg.payload ?? msg);
        return;
      }
    }

    // Check if this is an RPC request needing a response
    if (msg._channel_type === 'request' && msg._channel_request_id && this.requestHandler) {
      this.requestHandler(msg, fromSwarmId).then((result) => {
        const response = this.wrapEnvelope(
          { result } as object,
          'response',
          msg._channel_request_id as string,
        );
        sendToSwarm(fromSwarmId, response);
        this.stats.messagesSent++;
      }).catch(() => {
        // Handler error — send error response
        const response = this.wrapEnvelope(
          { error: 'Request handler failed' } as object,
          'response',
          msg._channel_request_id as string,
        );
        sendToSwarm(fromSwarmId, response);
        this.stats.messagesSent++;
      });
    }
  }

  /**
   * Flush offline queue for a swarm (call when swarm reconnects).
   */
  flushQueue(swarmId: string): number {
    const queue = this.queues.get(swarmId);
    if (!queue || queue.length === 0) return 0;

    const now = Date.now();
    let flushed = 0;
    const remaining: QueuedMessage[] = [];

    for (const msg of queue) {
      if (msg.expiresAt < now) {
        this.stats.failedDeliveries++;
        this.stats.queuedMessages--;
        continue; // Expired
      }
      if (sendToSwarm(swarmId, msg.payload)) {
        this.stats.messagesSent++;
        this.stats.queuedMessages--;
        flushed++;
      } else {
        remaining.push(msg);
      }
    }

    if (remaining.length > 0) {
      this.queues.set(swarmId, remaining);
    } else {
      this.queues.delete(swarmId);
    }

    return flushed;
  }

  /**
   * Get channel statistics.
   */
  getStats(): ChannelStats {
    return { ...this.stats };
  }

  /**
   * Reset channel statistics.
   */
  resetStats(): void {
    this.stats = {
      messagesSent: 0,
      messagesReceived: 0,
      queuedMessages: 0,
      failedDeliveries: 0,
      rpcRequestsSent: 0,
      rpcResponsesReceived: 0,
      rpcTimeouts: 0,
    };
  }

  /**
   * Clean up: clear queues, reject pending RPCs.
   */
  close(): void {
    for (const [, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Channel closed'));
    }
    this.pendingRpcs.clear();
    this.queues.clear();
    this.stats.queuedMessages = 0;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private wrapEnvelope(
    payload: object,
    type: 'message' | 'request' | 'response' = 'message',
    requestId?: string,
  ): object {
    return {
      ...payload,
      _channel: this.name,
      _channel_type: type,
      ...(requestId ? { _channel_request_id: requestId } : {}),
    };
  }

  private enqueue(targetSwarmId: string, payload: object): void {
    let queue = this.queues.get(targetSwarmId);
    if (!queue) {
      queue = [];
      this.queues.set(targetSwarmId, queue);
    }

    // Enforce max queue size (drop oldest)
    while (queue.length >= this.config.maxQueueSize) {
      queue.shift();
      this.stats.queuedMessages--;
      this.stats.failedDeliveries++;
    }

    queue.push({
      id: nanoid(),
      targetSwarmId,
      payload,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.offlineQueueTTL,
      attempts: 0,
    });
    this.stats.queuedMessages++;
  }
}

// ============================================================================
// Channel Registry (singleton)
// ============================================================================

const channels: Map<string, HubChannel> = new Map();

/**
 * Create or get a named channel. Cached — same name returns existing channel.
 */
export function createChannel(name: string, config?: HubChannelConfig): HubChannel {
  const existing = channels.get(name);
  if (existing) return existing;

  const channel = new HubChannel(name, config);
  channels.set(name, channel);
  return channel;
}

/**
 * Get a channel by name, or undefined if not created.
 */
export function getChannel(name: string): HubChannel | undefined {
  return channels.get(name);
}

/**
 * List all registered channels.
 */
export function listChannels(): HubChannel[] {
  return Array.from(channels.values());
}

/**
 * Get stats for all channels.
 */
export function getAllChannelStats(): Record<string, ChannelStats> {
  const result: Record<string, ChannelStats> = {};
  for (const [name, ch] of channels) {
    result[name] = ch.getStats();
  }
  return result;
}

/**
 * Flush offline queues for a reconnecting swarm across all channels.
 */
export function flushAllQueues(swarmId: string): number {
  let total = 0;
  for (const ch of channels.values()) {
    total += ch.flushQueue(swarmId);
  }
  return total;
}

/**
 * Close all channels and clear the registry.
 */
export function closeAllChannels(): void {
  for (const ch of channels.values()) {
    ch.close();
  }
  channels.clear();
}

// ============================================================================
// Default Channel Definitions
// ============================================================================

/**
 * Initialize the standard protocol channels.
 * Call at server startup after mesh peer is initialized.
 */
export function initDefaultChannels(): void {
  createChannel('proto:resource-sync', {
    enableOfflineQueue: true,
    offlineQueueTTL: 86_400_000, // 24 hours
  });

  createChannel('proto:coordination', {
    enableOfflineQueue: false,
    rpcTimeout: 30_000,
  });

  createChannel('proto:mail', {
    enableOfflineQueue: true,
    offlineQueueTTL: 172_800_000, // 48 hours
    maxQueueSize: 5000,
  });

  createChannel('proto:federation', {
    enableOfflineQueue: true,
    offlineQueueTTL: 43_200_000, // 12 hours
  });

  console.log(`[mesh-channels] Initialized ${channels.size} protocol channels`);
}

// ============================================================================
// Message Classification
// ============================================================================

/**
 * Classify a JSON-RPC method to its protocol channel.
 * Returns the channel name or null for unclassified methods.
 */
export function classifyMethod(method: string): string | null {
  // Resource sync
  if (method.startsWith('x-openhive/memory.') ||
      method.startsWith('x-openhive/skill.') ||
      method.startsWith('x-openhive/trajectory.')) {
    return 'proto:resource-sync';
  }

  // Coordination
  if (method.startsWith('x-openhive/task.') ||
      method.startsWith('x-openhive/context.') ||
      method.startsWith('x-openhive/message.')) {
    return 'proto:coordination';
  }

  // Mail
  if (method.startsWith('mail/')) {
    return 'proto:mail';
  }

  // Federation
  if (method.startsWith('map/federation/')) {
    return 'proto:federation';
  }

  return null;
}
