/**
 * Mesh Delivery Bridge — MAP→Inbox message bridge for mesh-connected agents
 *
 * Bridges agentic-mesh's MapServer message routing with OpenHive's inbox storage.
 * When the hub MapServer routes a message natively (via server.send()), the bridge
 * intercepts 'message:sent' events and stores them in inbox storage for
 * discoverability and offline replay.
 *
 * This complements mesh-handler.ts which handles JSON-RPC messages from mesh peers.
 * The delivery bridge catches messages routed through MapServer's native routing
 * (e.g., agent-to-agent via MeshPeer.send() or AgentConnection.send()).
 */

import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import { isMeshEnabled, getHubMeshPeer } from './mesh-peer.js';

let bridgeActive = false;
let messageHandler: ((...args: unknown[]) => void) | null = null;

export interface MeshDeliveryBridgeOptions {
  /** The inbox storage instance for persisting messages */
  storage: {
    putMessage(msg: Record<string, unknown>): void;
  };
  /** Event emitter for inbox events (message.created, etc.) */
  events: EventEmitter;
  /** Scope for inbox messages */
  scope?: string;
}

/**
 * Initialize the mesh delivery bridge.
 * Subscribes to the hub MapServer's 'message:sent' events and stores
 * messages in inbox storage for offline access and delivery tracking.
 */
export function initMeshDeliveryBridge(opts: MeshDeliveryBridgeOptions): void {
  if (bridgeActive) return;
  if (!isMeshEnabled()) return;

  const peer = getHubMeshPeer();
  const server = peer.server;
  const scope = opts.scope ?? 'default';

  // Listen for native MapServer message routing events.
  // 'message:sent' fires when server.send() completes routing.
  messageHandler = (messageId: unknown, from: unknown, to: unknown) => {
    try {
      const fromStr = String(from);
      const toStr = resolveAddressToString(to);

      // Skip hub-internal messages (hub relay agents)
      if (fromStr.startsWith('hub-relay-') || toStr.startsWith('hub-relay-')) return;

      const now = new Date().toISOString();
      const inboxMsg = {
        id: String(messageId) || nanoid(),
        scope,
        sender_id: fromStr,
        recipients: [{
          agent_id: toStr,
          kind: 'to',
          delivered_at: now,
        }],
        // message:sent event doesn't include payload — store as delivery trace
        content: { type: 'delivery-trace', mesh_message_id: String(messageId) },
        importance: 'normal',
        metadata: { source: 'mesh-server', mesh_message_id: messageId, delivery_trace: true },
        created_at: now,
      };

      opts.storage.putMessage(inboxMsg);
      // Emit on the inbox events bus — inbox-bridge already forwards
      // message.created events to notifySubscribers, so we don't call it here.
      opts.events.emit('message.created', inboxMsg);
    } catch {
      // Non-fatal — don't break MapServer routing
    }
  };

  // MapServer extends EventEmitter but our type stub doesn't include on/off.
  // Cast to access event emitter methods.
  (server as unknown as EventEmitter).on('message:sent', messageHandler);
  bridgeActive = true;
  console.log('[mesh-delivery-bridge] Delivery bridge active for MapServer routing');
}

/**
 * Stop the mesh delivery bridge.
 */
export function stopMeshDeliveryBridge(): void {
  if (!bridgeActive) return;

  if (messageHandler) {
    try {
      const peer = getHubMeshPeer();
      (peer.server as unknown as EventEmitter).off('message:sent', messageHandler);
    } catch { /* peer may already be stopped */ }
    messageHandler = null;
  }

  bridgeActive = false;
  console.log('[mesh-delivery-bridge] Delivery bridge stopped');
}

/**
 * Check if the delivery bridge is active.
 */
export function isDeliveryBridgeActive(): boolean {
  return bridgeActive;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve a MAP Address to a string for inbox storage.
 * Handles the various address formats from agentic-mesh.
 */
function resolveAddressToString(addr: unknown): string {
  if (typeof addr === 'string') return addr;
  if (!addr || typeof addr !== 'object') return 'unknown';

  const a = addr as Record<string, unknown>;

  // { agent: "id" }
  if (typeof a.agent === 'string') {
    // { system: "x", agent: "y" } → "y@x"
    if (typeof a.system === 'string') return `${a.agent}@${a.system}`;
    return a.agent;
  }

  // { agents: ["a", "b"] }
  if (Array.isArray(a.agents)) return a.agents.join(',');

  // { scope: "name" }
  if (typeof a.scope === 'string') return `scope:${a.scope}`;

  // { broadcast: true }
  if (a.broadcast) return '*';

  return 'unknown';
}
