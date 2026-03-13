/**
 * Inbox Bridge — Agent-Inbox integration for OpenHive
 *
 * Initializes agent-inbox components in "router mode": co-located in OpenHive's
 * SQLite database with prefixed tables (inbox_*). No IPC socket, no MAP connection
 * (the hub IS the MAP server). Messages arrive via ws-map.ts and are dispatched
 * to the inbox router and JSON-RPC handler directly.
 *
 * Optionally initializes federation for cross-hive messaging when configured.
 */

import { EventEmitter } from 'node:events';
import {
  SqliteStorage,
  MessageRouter,
  MailJsonRpcServer,
  TraceabilityLayer,
  ConnectionManager,
} from 'agent-inbox';
import type { Storage } from 'agent-inbox';
import { getDatabase } from '../db/index.js';
import { notifySubscribers } from './event-subscriptions.js';

let storage: Storage | null = null;
let router: MessageRouter | null = null;
let jsonRpc: MailJsonRpcServer | null = null;
let events: EventEmitter | null = null;
let federation: ConnectionManager | null = null;

// TraceabilityLayer auto-subscribes to events on construction.
// We hold a reference to keep it alive for the bridge's lifetime.
const traceabilityRef: { current: TraceabilityLayer | null } = { current: null };

type FederationAuthMethod = 'bearer' | 'api-key' | 'none';

export interface InboxBridgeOptions {
  federation?: {
    enabled: boolean;
    systemId?: string;
    peers?: Array<{
      systemId: string;
      url: string;
      auth?: { method: FederationAuthMethod; token?: string };
    }>;
  };
}

/**
 * Initialize agent-inbox components using OpenHive's database.
 * Creates inbox_* tables via SqliteStorage with prefix.
 * Optionally sets up federation for cross-hive messaging.
 */
export async function initInboxBridge(opts?: InboxBridgeOptions): Promise<void> {
  if (router) return; // Already initialized

  const db = getDatabase();

  storage = new SqliteStorage({ db, prefix: 'inbox_' });
  events = new EventEmitter();
  router = new MessageRouter(storage, events, 'default');
  traceabilityRef.current = new TraceabilityLayer(storage, events);
  jsonRpc = new MailJsonRpcServer(storage, router, events);

  // Wire inbox events to MAP subscription system
  events.on('message.created', (msg: unknown) => {
    notifySubscribers('message.created', msg);
  });
  events.on('mail.created', (conv: unknown) => {
    const c = conv as Record<string, unknown>;
    notifySubscribers('mail.created', conv, c.id ? { conversationId: c.id as string } : undefined);
  });
  events.on('mail.turn.added', (turn: unknown) => {
    const t = turn as Record<string, unknown>;
    notifySubscribers('mail.turn.added', turn, t.conversation_id ? { conversationId: t.conversation_id as string } : undefined);
  });
  events.on('mail.participant.joined', (data: unknown) => {
    const d = data as Record<string, unknown>;
    notifySubscribers('mail.participant.joined', data, d.conversation_id ? { conversationId: d.conversation_id as string } : undefined);
  });
  events.on('mail.closed', (data: unknown) => {
    const d = data as Record<string, unknown>;
    notifySubscribers('mail.closed', data, d.conversation_id ? { conversationId: d.conversation_id as string } : undefined);
  });

  // Initialize federation if configured
  if (opts?.federation?.enabled) {
    federation = new ConnectionManager(events, {
      systemId: opts.federation.systemId,
      peers: opts.federation.peers,
    }, {
      onIncomingMessage: ({ from, peerId, payload, meta }) => {
        // Delegate incoming federation messages to the local router
        router!.routeMessage({
          from: `${from}@${peerId}`,
          to: (meta?.targetAgent as string) ?? 'broadcast',
          payload,
          subject: meta?.subject as string,
          scope: meta?.scope as string,
        }).catch(err => {
          console.error('[inbox-bridge] Federation message routing failed:', err);
        });
      },
    });

    // Wire federation into router for outbound routing
    router.setFederation(federation);

    // Establish connections with configured peers
    for (const peer of opts.federation.peers ?? []) {
      try {
        await federation.federate(peer);
        console.log(`[inbox-bridge] Federated with peer: ${peer.systemId}`);
      } catch (err) {
        console.warn(`[inbox-bridge] Failed to federate with ${peer.systemId}:`, err);
      }
    }

    // Start delivery queue ticking for offline peers
    federation.queue.startTicking();

    console.log('[openhive] Inbox bridge initialized with federation (inbox_* tables in shared DB)');
  } else {
    console.log('[openhive] Inbox bridge initialized (inbox_* tables in shared DB)');
  }
}

/**
 * Stop inbox bridge. Does NOT close the database (owned by OpenHive).
 */
export async function stopInboxBridge(): Promise<void> {
  if (federation) {
    await federation.destroy();
    federation = null;
  }
  if (storage && 'close' in storage) {
    (storage as SqliteStorage).close(); // No-op for external DB handle
  }
  storage = null;
  router = null;
  jsonRpc = null;
  traceabilityRef.current = null;
  events = null;
}

/**
 * Get the inbox message router (for routing messages and broadcasts).
 */
export function getInboxRouter(): MessageRouter {
  if (!router) throw new Error('Inbox bridge not initialized. Call initInboxBridge() first.');
  return router;
}

/**
 * Get the inbox JSON-RPC server (for handling mail/* methods).
 */
export function getInboxJsonRpc(): MailJsonRpcServer {
  if (!jsonRpc) throw new Error('Inbox bridge not initialized. Call initInboxBridge() first.');
  return jsonRpc;
}

/**
 * Get the inbox storage (for querying agents, messages, conversations).
 */
export function getInboxStorage(): Storage {
  if (!storage) throw new Error('Inbox bridge not initialized. Call initInboxBridge() first.');
  return storage;
}

/**
 * Get the inbox event emitter.
 */
export function getInboxEvents(): EventEmitter {
  if (!events) throw new Error('Inbox bridge not initialized. Call initInboxBridge() first.');
  return events;
}

/**
 * Get the federation connection manager (if federation is enabled).
 */
export function getFederation(): ConnectionManager | null {
  return federation;
}
