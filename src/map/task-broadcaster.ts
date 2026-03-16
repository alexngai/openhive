/**
 * MAP Task Event Broadcaster
 *
 * Listens to MAPTaskStore events and broadcasts them to:
 * 1. All connected MAP agents (except originator) via sendToSwarm()
 * 2. The frontend via broadcastToChannel('map:tasks', ...)
 */

import { sendToSwarm } from './sync-listener.js';
import { getAllInbound } from './connection-registry.js';
import { broadcastToChannel } from '../realtime/index.js';
import type { MAPTaskStore } from './task-store.js';
import type { MAPTaskEvent } from './task-types.js';

let unsubscribe: (() => void) | null = null;

/**
 * Start broadcasting task events from the store to connected agents and frontend.
 */
export function initTaskBroadcaster(store: MAPTaskStore): void {
  if (unsubscribe) return;

  unsubscribe = store.onTaskEvent((event: MAPTaskEvent, sourceSwarmId: string) => {
    // Build the MAP event notification (JSON-RPC 2.0 notification)
    const notification = {
      jsonrpc: '2.0' as const,
      method: 'map/event',
      params: {
        type: event.type,
        data: event.data,
        _origin: sourceSwarmId,
      },
    };

    // Send to all connected MAP agents except the originator
    for (const [swarmId] of getAllInbound()) {
      if (swarmId === sourceSwarmId) continue;
      sendToSwarm(swarmId, notification);
    }

    // Broadcast to frontend WebSocket subscribers
    broadcastToChannel('map:tasks', {
      type: event.type,
      data: {
        ...event.data,
        _sourceSwarm: sourceSwarmId,
      },
    });
  });
}

/**
 * Stop broadcasting task events.
 */
export function stopTaskBroadcaster(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
