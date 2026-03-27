/**
 * Bidirectional Task Bridge
 *
 * Bridges OpenHive's two task subsystems so that task state flows both ways:
 *
 * 1. MAPTaskStore → OpenTasks graph (inbound)
 *    When cc-swarm (or any MAP agent) creates/updates tasks via map/tasks/*,
 *    the bridge writes corresponding entries into the swarm's OpenTasks graph.
 *
 * 2. OpenTasks graph → MAPTaskStore (outbound)
 *    When tasks are created/updated via map/opentasks/* or the REST API,
 *    the bridge pushes them into MAPTaskStore so the task-broadcaster
 *    notifies all connected agents.
 *
 * Additionally, the bridge uses opentasks' createMAPEventBridge to emit
 * structured MAP task events (task.created, task.status, task.completed)
 * to the frontend and agents when graph mutations happen.
 */

// opentasks is ESM-only — use dynamic import to avoid CJS resolution failure
type MAPEventBridge = import('opentasks').MAPEventBridge;
import type { MAPTaskStore } from './task-store.js';
import type { MAPTaskEvent, MAPTaskStatus } from './task-types.js';
import { sendToSwarm } from './sync-listener.js';
import { getAllInbound } from './connection-registry.js';
import { broadcastToChannel } from '../realtime/index.js';
import type { WSEventType } from '../types.js';

// ============================================================================
// Types
// ============================================================================

export interface TaskBridgeConfig {
  /** The MAPTaskStore singleton */
  store: MAPTaskStore;
}

/**
 * Represents a task mutation that originated from the OpenTasks handler.
 * Used to push into MAPTaskStore for broadcast.
 */
export interface OpenTasksMutation {
  type: 'create' | 'update-status';
  nodeId: string;
  title?: string;
  description?: string;
  status: string;
  previousStatus?: string | null;
  metadata?: Record<string, unknown>;
  /** The swarmId that performed the mutation (for _origin tracking) */
  sourceSwarmId: string;
}

// ============================================================================
// Status mapping
// ============================================================================

/** Map OpenTasks status strings to MAP task status */
function toMAPStatus(status?: string): MAPTaskStatus {
  switch (status?.toLowerCase()) {
    case 'open': return 'open';
    case 'in_progress': return 'in_progress';
    case 'blocked': return 'blocked';
    case 'closed': return 'completed';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    default: return 'open';
  }
}

// ============================================================================
// Bridge State
// ============================================================================

let eventBridge: MAPEventBridge | null = null;
let unsubscribeStore: (() => void) | null = null;

/**
 * Set of task IDs currently being bridged (inbound → OpenTasks).
 * Prevents echo loops when a MAPTaskStore event triggers a graph write,
 * which in turn triggers an outbound bridge event.
 */
const bridgingTaskIds = new Set<string>();

// ============================================================================
// Outbound: OpenTasks mutations → MAPTaskStore + broadcast
// ============================================================================

/**
 * Called by the OpenTasks handler after a successful create-task or update-status.
 * Pushes the mutation into MAPTaskStore so the task-broadcaster sends MAP event
 * notifications to all connected agents and the frontend.
 */
export function bridgeOpenTasksMutation(store: MAPTaskStore, mutation: OpenTasksMutation): void {
  const taskId = mutation.nodeId;

  // Mark as bridging to prevent echo loop
  bridgingTaskIds.add(taskId);

  try {
    if (mutation.type === 'create') {
      // Check if task already exists in store (idempotent)
      if (!store.get(taskId)) {
        store.create(
          {
            task: {
              id: taskId,
              title: mutation.title,
              description: mutation.description,
              status: toMAPStatus(mutation.status),
              meta: {
                ...mutation.metadata,
                _source: 'opentasks',
              },
            },
          },
          mutation.sourceSwarmId,
        );
      }
    } else if (mutation.type === 'update-status') {
      const existing = store.get(taskId);
      if (existing) {
        store.update(
          {
            taskId,
            status: toMAPStatus(mutation.status),
            meta: {
              ...mutation.metadata,
              _source: 'opentasks',
            },
          },
          mutation.sourceSwarmId,
        );
      } else {
        // Task not in ephemeral store — create it with the new status
        store.create(
          {
            task: {
              id: taskId,
              title: mutation.title ?? taskId,
              status: toMAPStatus(mutation.status),
              meta: {
                ...mutation.metadata,
                _source: 'opentasks',
                _previousStatus: mutation.previousStatus,
              },
            },
          },
          mutation.sourceSwarmId,
        );
      }
    }
  } finally {
    // Clear bridging flag after a tick to let event propagation complete
    setTimeout(() => bridgingTaskIds.delete(taskId), 0);
  }

  // Also emit via the opentasks event bridge (structured MAP events)
  if (eventBridge) {
    if (mutation.type === 'create') {
      eventBridge.emitTaskCreated({
        id: taskId,
        title: mutation.title,
        status: mutation.status,
        description: mutation.description,
      });
    } else if (mutation.type === 'update-status' && mutation.previousStatus) {
      eventBridge.emitTaskStatus(taskId, mutation.previousStatus, mutation.status);
    }
  }
}

// ============================================================================
// Inbound: MAPTaskStore events → OpenTasks graph notification
//
// When agents update tasks via map/tasks/*, the MAPTaskStore emits events.
// We broadcast these as opentasks-compatible notifications so that any
// OpenTasks daemon watching for MAP events can ingest them.
// ============================================================================

function handleStoreEvent(event: MAPTaskEvent, sourceSwarmId: string): void {
  const taskId = (event.data as Record<string, unknown>).taskId as string
    ?? ((event.data as Record<string, unknown>).task as Record<string, unknown>)?.id as string;

  if (!taskId) return;

  // Skip events that originated from the bridge itself (echo prevention)
  if (bridgingTaskIds.has(taskId)) return;

  // Broadcast an opentasks-flavored notification to a dedicated channel
  // so the frontend and any listening services can react
  broadcastToChannel('map:opentasks', {
    type: event.type as WSEventType,
    data: {
      ...event.data,
      _sourceSwarm: sourceSwarmId,
      _bridged: true,
    },
  });
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Initialize the bidirectional task bridge.
 *
 * - Creates an opentasks MAPEventBridge for structured outbound events
 * - Subscribes to MAPTaskStore events for inbound bridging
 */
export async function initTaskBridge(config: TaskBridgeConfig): Promise<void> {
  if (unsubscribeStore) return; // Already initialized

  const { store } = config;

  // Dynamic import — opentasks is ESM-only and cannot be require()'d
  const { createMAPEventBridge } = await import('opentasks');

  // Create the opentasks event bridge for outbound events.
  // We use the `send` function pattern — the bridge emits events which
  // we forward to all connected agents and the frontend.
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

      // Broadcast to all connected MAP agents
      for (const [swarmId] of getAllInbound()) {
        // Skip if this event's origin is the same swarm
        if (data._origin && data._origin === swarmId) continue;
        sendToSwarm(swarmId, notification);
      }

      // Broadcast to frontend (cast eventType — MAP task event types
      // like 'task.created' are valid WSEventType values)
      broadcastToChannel('map:opentasks', {
        type: eventType as WSEventType,
        data,
      });
    },
    agentId: 'openhive-bridge',
  });

  // Subscribe to MAPTaskStore events for inbound bridging
  unsubscribeStore = store.onTaskEvent(handleStoreEvent);

  console.log('[task-bridge] Bidirectional task bridge initialized');
}

/**
 * Stop the task bridge and clean up subscriptions.
 */
export function stopTaskBridge(): void {
  if (eventBridge) {
    eventBridge.stop();
    eventBridge = null;
  }

  if (unsubscribeStore) {
    unsubscribeStore();
    unsubscribeStore = null;
  }

  bridgingTaskIds.clear();

  console.log('[task-bridge] Task bridge stopped');
}
