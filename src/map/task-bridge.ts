/**
 * Task Event Bridge
 *
 * Initializes the opentasks MAPEventBridge for structured task event
 * notifications to connected agents and the frontend. Listens to
 * MAPTaskStore events (emitted by the unified handler after daemon writes)
 * and forwards them as MAP notifications.
 */

// opentasks is ESM-only — use dynamic import to avoid CJS resolution failure
type MAPEventBridge = import('opentasks').MAPEventBridge;
import type { MAPTaskStore } from './task-store.js';
import { sendToSwarm } from './sync-listener.js';
import { getAllInbound } from './connection-registry.js';
import { broadcastToChannel } from '../realtime/index.js';
import type { WSEventType } from '../types.js';

// ============================================================================
// Bridge State
// ============================================================================

export interface TaskBridgeConfig {
  store: MAPTaskStore;
}

let eventBridge: MAPEventBridge | null = null;

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Initialize the task event bridge.
 *
 * - Creates an opentasks MAPEventBridge for structured notifications to agents
 * - Subscribes to MAPTaskStore events for frontend broadcasting
 */
export async function initTaskBridge(_config: TaskBridgeConfig): Promise<void> {
  if (eventBridge) return; // Already initialized

  // Dynamic import — opentasks is ESM-only
  const { createMAPEventBridge } = await import('opentasks');

  // Create the event bridge for structured agent notifications
  eventBridge = createMAPEventBridge({
    send: (eventType: string, data: Record<string, unknown>) => {
      const notification = {
        jsonrpc: '2.0' as const,
        method: 'map/event',
        params: {
          type: eventType,
          data,
          _source: 'opentasks-bridge',
        },
      };

      // Send to all connected MAP agents (skip origin swarm)
      for (const [swarmId] of getAllInbound()) {
        if (data._origin && data._origin === swarmId) continue;
        sendToSwarm(swarmId, notification);
      }

      // Also broadcast to frontend
      broadcastToChannel('map:tasks', {
        type: eventType as WSEventType,
        data,
      });
    },
    agentId: 'openhive-bridge',
  });

  console.log('[task-bridge] Task event bridge initialized');
}

export function stopTaskBridge(): void {
  if (eventBridge) {
    eventBridge.stop();
    eventBridge = null;
  }
  console.log('[task-bridge] Task bridge stopped');
}
