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
import { broadcastToChannel } from '../realtime/index.js';
import { getAllInboundIncludingStale, hasCapability } from '../map/connection-registry.js';
import { sendToSwarm } from '../map/sync-listener.js';
import { mapHubEvents } from '../map/service.js';

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

    // Forward turn to connected swarms that have mail capability.
    // This bridges the hub's mail system to agent sidecars so they can
    // receive conversation turns via their MAP WebSocket connection.
    forwardTurnToSwarms(turn);
  });

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

    // Give the sidecar a brief moment to complete its MAP handshake
    // (register + capability publishing) before we attempt delivery.
    // 2 s is enough for connect+register round-trips on a local hub.
    setTimeout(() => {
      for (const { payload } of live) {
        try {
          sendToSwarm(swarmId, payload);
        } catch {
          // best effort
        }
      }
    }, 2_000);
  });
}

/**
 * Forward a mail turn to connected swarms that declare mail capability.
 * Sends a JSON-RPC notification so the sidecar's mail handler can process it.
 *
 * This bridges the gap between OpenHive's mail module (hub-side) and
 * agent sidecars (connected via MAP WebSocket). Without this, turns
 * stored in the hub's agent-inbox are only visible via REST/WebSocket
 * polling — sidecars never receive them proactively.
 *
 * When the sidecar's WS is transiently stale (reconnecting after a heartbeat
 * timeout), the notification is queued and re-delivered once the sidecar
 * reconnects and swarm_online fires. The queue expires after 5 minutes.
 */
function forwardTurnToSwarms(turn: any): void {
  ensurePendingRetryListener();

  try {
    // Iterate ALL connections — active and stale — so that swarms whose WS
    // is transiently closed (heartbeat timeout, brief disconnect) still get
    // the notification queued for re-delivery on reconnect.
    for (const [swarmId, conn] of getAllInboundIncludingStale()) {
      // Capability check: use conn.capabilities (connection-level, always set
      // after first register) because hasCapability() skips stale entries.
      const hasMail =
        !conn.isStale
          ? hasCapability(swarmId, 'mail.canJoin')
          : (conn.capabilities as any)?.mail?.canJoin === true ||
            Array.from(conn.registeredAgents.values()).some(
              (a: any) => a.capabilities?.mail?.canJoin === true,
            );
      if (!hasMail) continue;

      // Don't echo turns back to the sender's swarm
      if (conn.registeredAgents.has(turn.participant_id)) continue;

      const payload = {
        jsonrpc: '2.0',
        method: 'mail/turn.received',
        params: {
          conversation_id: turn.conversation_id,
          turn_id: turn.id,
          participant_id: turn.participant_id,
          content_type: turn.content_type,
          content: turn.content,
          thread_id: turn.thread_id,
          created_at: turn.created_at,
        },
      };

      if (conn.isStale) {
        // Connection is reconnecting — queue for re-delivery when swarm comes back online.
        if (!isTurnAlreadyQueued(swarmId, turn.id)) {
          console.log(
            `[mail-forward] Swarm ${swarmId} is stale (reconnecting); ` +
            `queuing mail/turn.received turn=${turn.id ?? '?'} for retry`,
          );
          const existing = pendingNotifications.get(swarmId) ?? [];
          existing.push({ payload, turnId: turn.id, expiresAt: Date.now() + PENDING_TURN_TTL_MS });
          pendingNotifications.set(swarmId, existing);
        }
      } else {
        // Always queue alongside the send. The WS write can succeed yet the
        // sidecar's stream may close before it reads the message (hub heartbeat
        // termination races the notification delivery). On reconnect the hub
        // re-delivers from the queue. Hub-side dedup (isTurnAlreadyQueued) prevents
        // double-queueing the same turn if forwardTurnToSwarms is called twice.
        if (!isTurnAlreadyQueued(swarmId, turn.id)) {
          const existing = pendingNotifications.get(swarmId) ?? [];
          existing.push({ payload, turnId: turn.id, expiresAt: Date.now() + PENDING_TURN_TTL_MS });
          pendingNotifications.set(swarmId, existing);
        }

        const sent = sendToSwarm(swarmId, payload);
        if (!sent) {
          console.log(
            `[mail-forward] sendToSwarm returned false for ${swarmId}; ` +
            `turn=${turn.id ?? '?'} queued for retry on reconnect`,
          );
        }
      }
    }
  } catch {
    // Non-critical — don't crash on forwarding failures
  }
}
