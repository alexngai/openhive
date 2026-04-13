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
import { getAllInbound, hasCapability } from '../map/connection-registry.js';
import { sendToSwarm } from '../map/sync-listener.js';

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
 * Forward a mail turn to connected swarms that declare mail capability.
 * Sends a JSON-RPC notification so the sidecar's mail handler can process it.
 *
 * This bridges the gap between OpenHive's mail module (hub-side) and
 * agent sidecars (connected via MAP WebSocket). Without this, turns
 * stored in the hub's agent-inbox are only visible via REST/WebSocket
 * polling — sidecars never receive them proactively.
 */
function forwardTurnToSwarms(turn: any): void {
  try {
    const inbound = getAllInbound();
    for (const [swarmId] of inbound) {
      // Only forward to swarms that declared mail capabilities
      if (!hasCapability(swarmId, 'mail.canJoin')) continue;

      // Don't echo turns back to the sender's swarm
      // (participant_id is the agent who sent the turn)
      const conn = inbound.get(swarmId);
      if (conn) {
        const senderIsOnThisSwarm = conn.registeredAgents.has(turn.participant_id);
        if (senderIsOnThisSwarm) continue;
      }

      sendToSwarm(swarmId, {
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
      });
    }
  } catch {
    // Non-critical — don't crash on forwarding failures
  }
}
