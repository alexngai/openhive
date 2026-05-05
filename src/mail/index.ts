/**
 * MAP Mail Integration
 *
 * Embeds agent-inbox into the OpenHive server for MAP mail protocol support.
 * Provides structured conversations, turns, and threads for agent-to-agent
 * messaging, with a human-facing observability layer.
 *
 * Uses agent-inbox's own storage (co-located SQLite or in-memory) — no
 * changes to OpenHive's database schema.
 */

import { EventEmitter } from 'node:events';
import type { Storage, MailJsonRpcServer } from 'agent-inbox';
import {
  createMailPushBridge,
  MAIL_TURN_RECEIVED_METHOD,
  type MailPushBridge,
  type MailPushSubscriber,
} from 'agent-inbox';
import { broadcastToChannel } from '../realtime/index.js';
import { getAllInboundIncludingStale, hasCapability } from '../map/connection-registry.js';
import { sendToSwarm } from '../map/sync-listener.js';
import { mapHubEvents } from '../map/service.js';

/**
 * OpenHive-specific subscriber shape passed through the mail-push
 * bridge. The base library expects only `{ id: string }`; we attach
 * the swarmId + isStale flag so the consumer's sendNotification
 * callback can branch on connection state (active → queue + send;
 * stale → queue only) without re-walking the registry.
 */
interface OpenHiveMailSubscriber extends MailPushSubscriber {
  swarmId: string;
  isStale: boolean;
}

let mailStorage: Storage | null = null;
let mailJsonRpc: MailJsonRpcServer | null = null;
let mailEvents: EventEmitter | null = null;

export interface MailModule {
  storage: Storage;
  jsonRpc: MailJsonRpcServer;
  events: EventEmitter;
}

/**
 * Initialize the mail module. Called once during server startup.
 *
 * Uses in-memory storage by default. To co-locate in OpenHive's SQLite DB,
 * pass a better-sqlite3 Database handle via opts.sqliteDb.
 */
export async function initMail(opts?: {
  sqliteDb?: import('better-sqlite3').Database;
  sqlitePrefix?: string;
}): Promise<MailModule> {
  if (mailStorage) {
    return { storage: mailStorage, jsonRpc: mailJsonRpc!, events: mailEvents! };
  }

  const inbox = await import('agent-inbox');

  // Storage — co-locate in SQLite if available, otherwise in-memory
  if (opts?.sqliteDb) {
    mailStorage = new inbox.SqliteStorage({
      db: opts.sqliteDb,
      prefix: opts.sqlitePrefix ?? 'mail_',
    });
  } else {
    mailStorage = new inbox.InMemoryStorage();
  }

  // Event bus
  mailEvents = new EventEmitter();

  // Message router (for traceability auto-conversation creation)
  const router = new inbox.MessageRouter(mailStorage, mailEvents, 'default');

  // Traceability layer — auto-creates conversations/threads from message events
  new inbox.TraceabilityLayer(mailStorage, mailEvents);

  // JSON-RPC server — handles all mail/* methods
  mailJsonRpc = new inbox.MailJsonRpcServer(mailStorage, router, mailEvents);

  // Forward mail events to OpenHive's WebSocket system
  setupEventForwarding(mailEvents);

  console.log('[openhive] Mail module initialized');

  return { storage: mailStorage, jsonRpc: mailJsonRpc, events: mailEvents };
}

/**
 * Get the mail JSON-RPC server (for handling mail/* WebSocket requests).
 * Throws if mail module hasn't been initialized.
 */
export function getMailJsonRpc(): MailJsonRpcServer {
  if (!mailJsonRpc) {
    throw new Error('Mail module not initialized. Call initMail() first.');
  }
  return mailJsonRpc;
}

/**
 * Get the mail storage (for REST API route queries).
 */
export function getMailStorage(): Storage {
  if (!mailStorage) {
    throw new Error('Mail module not initialized. Call initMail() first.');
  }
  return mailStorage;
}

/**
 * Get the mail event emitter (fires `mail.created`, `mail.turn.added`,
 * `mail.participant.joined`, `mail.closed`). Used by dispatch mail-transport
 * to demux replies.
 */
export function getMailEvents(): EventEmitter {
  if (!mailEvents) {
    throw new Error('Mail module not initialized. Call initMail() first.');
  }
  return mailEvents;
}

/**
 * Forward agent-inbox events to OpenHive's WebSocket broadcast system.
 */
function setupEventForwarding(events: EventEmitter): void {
  events.on('mail.created', (conv) => {
    broadcastToChannel('mail:conversations', {
      type: 'mail.created',
      data: conv,
    });
  });

  events.on('mail.turn.added', (turn) => {
    broadcastToChannel('mail:conversations', {
      type: 'mail.turn.added',
      data: turn,
    });
    // Also broadcast to the specific conversation channel
    if (turn.conversation_id) {
      broadcastToChannel(`mail:conversation:${turn.conversation_id}`, {
        type: 'mail.turn.added',
        data: turn,
      });
    }

    // Mail-push bridge (started below) handles fan-out to swarms with
    // mail.canJoin via agent-inbox's createMailPushBridge. The bridge
    // subscribes to mail.turn.added itself, so no per-event call here.
  });
  // One-time wire of the mail-push bridge.
  startMailPushBridge(events);

  events.on('mail.participant.joined', (data) => {
    broadcastToChannel('mail:conversations', {
      type: 'mail.participant.joined',
      data,
    });
  });

  events.on('mail.closed', (data) => {
    broadcastToChannel('mail:conversations', {
      type: 'mail.closed',
      data,
    });
  });
}

/**
 * Pending notifications for swarms that were stale (reconnecting) when a
 * mail turn arrived. Keyed by swarmId → array of notification payloads.
 * Drained when swarm_online fires for that swarm (i.e. the sidecar reconnects).
 * Entries expire after PENDING_TURN_TTL_MS to prevent unbounded growth.
 */
const PENDING_TURN_TTL_MS = 5 * 60 * 1000; // 5 minutes
interface PendingNotification {
  payload: object;
  turnId: string | undefined;
  expiresAt: number;
}
const pendingNotifications = new Map<string, PendingNotification[]>();

/**
 * Returns true if turn_id is already queued for swarmId (hub-side dedup).
 * Prevents always-queue from enqueuing the same turn twice when forwardTurnToSwarms
 * is called multiple times (e.g., on retransmit or duplicate mail.turn.added events).
 */
function isTurnAlreadyQueued(swarmId: string, turnId: string | undefined): boolean {
  if (!turnId) return false;
  const existing = pendingNotifications.get(swarmId);
  if (!existing) return false;
  return existing.some((n) => n.turnId === turnId && n.expiresAt > Date.now());
}

/**
 * Register the swarm_online listener once on first use so it fires for every
 * reconnect and drains any pending notifications for that swarm.
 */
let _pendingRetryListenerInstalled = false;
function ensurePendingRetryListener(): void {
  if (_pendingRetryListenerInstalled) return;
  _pendingRetryListenerInstalled = true;

  mapHubEvents.on('swarm_online', (e: { swarm_id: string }) => {
    const swarmId = e.swarm_id;
    const pending = pendingNotifications.get(swarmId);
    if (!pending || pending.length === 0) return;

    // Drain expired entries first
    const now = Date.now();
    const live = pending.filter((n) => n.expiresAt > now);
    pendingNotifications.delete(swarmId);

    if (live.length === 0) return;

    // Wait for the sidecar to register an agent (signal that it has
    // completed its MAP handshake + capability publish) before delivering
    // the queued notifications. A bare 2s wall-clock sleep is racy on slow
    // boots; a 2s timeout fallback bounds the worst case so a buggy sidecar
    // that never registers can't pin pending notifications indefinitely.
    let drained = false;
    const drain = (): void => {
      if (drained) return;
      drained = true;
      mapHubEvents.off('node_registered', onRegistered);
      clearTimeout(fallbackTimer);
      for (const { payload } of live) {
        try {
          sendToSwarm(swarmId, payload);
        } catch {
          // best effort
        }
      }
    };
    const onRegistered = (ev: { swarm_id?: string }): void => {
      if (ev?.swarm_id === swarmId) drain();
    };
    mapHubEvents.on('node_registered', onRegistered);
    const fallbackTimer = setTimeout(drain, 2_000);
  });
}

/**
 * Forward mail turns to connected swarms that declare mail capability,
 * via agent-inbox's `createMailPushBridge`. The library factory owns
 * the event subscription, payload-shape construction (using the
 * canonical `MAIL_TURN_RECEIVED_METHOD` constant), and per-subscriber
 * fan-out loop. OpenHive supplies:
 *
 *   - `getSubscribers(turn)` — walks `getAllInboundIncludingStale()`,
 *     filters by `mail.canJoin` (handling the stale-grace path
 *     specially because `hasCapability` skips stale entries), and
 *     skips swarms where the turn's sender is registered (no echo).
 *
 *   - `sendNotification(sub, method, params)` — queues the payload for
 *     the swarm AND sends synchronously when active. Stale connections
 *     get queue-only; the queue is drained on `swarm_online`.
 *
 * The OpenHive-specific stale-grace queue logic stays in this module
 * because it depends on `conn.isStale` from OpenHive's connection
 * registry. The bridge is the single fan-out site; queue policy is the
 * consumer's responsibility.
 */
let mailPushBridge: MailPushBridge | null = null;

function startMailPushBridge(events: EventEmitter): void {
  if (mailPushBridge) return;
  ensurePendingRetryListener();

  mailPushBridge = createMailPushBridge<OpenHiveMailSubscriber>({
    mailEvents: events,
    getSubscribers: (turn) => {
      const subs: OpenHiveMailSubscriber[] = [];
      for (const [swarmId, conn] of getAllInboundIncludingStale()) {
        // Capability check: hasCapability() skips stale entries so we
        // walk per-agent / connection-level caps directly when isStale.
        const hasMail =
          !conn.isStale
            ? hasCapability(swarmId, 'mail.canJoin')
            : (conn.capabilities as any)?.mail?.canJoin === true ||
              Array.from(conn.registeredAgents.values()).some(
                (a: any) => a.capabilities?.mail?.canJoin === true,
              );
        if (!hasMail) continue;
        // Don't echo turns back to the sender's own swarm.
        if (conn.registeredAgents.has(turn.participant_id)) continue;
        subs.push({
          id: swarmId,
          swarmId,
          isStale: !!conn.isStale,
        });
      }
      return subs;
    },
    sendNotification: (sub, method, params) => {
      const payload = { jsonrpc: '2.0', method, params };
      const turnId = (params as { turn_id?: string }).turn_id;

      if (sub.isStale) {
        // Reconnecting — queue for delivery when swarm_online fires.
        if (!isTurnAlreadyQueued(sub.swarmId, turnId)) {
          console.log(
            `[mail-forward] Swarm ${sub.swarmId} is stale (reconnecting); ` +
              `queuing ${method} turn=${turnId ?? '?'} for retry`,
          );
          const existing = pendingNotifications.get(sub.swarmId) ?? [];
          existing.push({
            payload,
            turnId,
            expiresAt: Date.now() + PENDING_TURN_TTL_MS,
          });
          pendingNotifications.set(sub.swarmId, existing);
        }
        return;
      }

      // Active connection: always queue alongside the send. The WS
      // write can succeed yet the sidecar's stream may close before it
      // reads the message; on reconnect the hub re-delivers from the
      // queue. Hub-side dedup (isTurnAlreadyQueued) prevents double-
      // queueing if the bridge fires twice for the same turn.
      if (!isTurnAlreadyQueued(sub.swarmId, turnId)) {
        const existing = pendingNotifications.get(sub.swarmId) ?? [];
        existing.push({
          payload,
          turnId,
          expiresAt: Date.now() + PENDING_TURN_TTL_MS,
        });
        pendingNotifications.set(sub.swarmId, existing);
      }

      const sent = sendToSwarm(sub.swarmId, payload);
      if (!sent) {
        console.log(
          `[mail-forward] sendToSwarm returned false for ${sub.swarmId}; ` +
            `turn=${turnId ?? '?'} queued for retry on reconnect`,
        );
      }
    },
    log: (msg) => console.log(msg),
  });
}

// Re-export for any existing consumers / tests that reference the
// canonical method name. New code should import directly from
// 'agent-inbox' (`MAIL_TURN_RECEIVED_METHOD`).
export { MAIL_TURN_RECEIVED_METHOD };
