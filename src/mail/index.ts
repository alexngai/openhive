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
import {
  InMemoryStorage,
  MailJsonRpcServer,
  MessageRouter,
  TraceabilityLayer,
} from 'agent-inbox';
import type { Storage } from 'agent-inbox';
import { broadcastToChannel } from '../realtime/index.js';

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

  // Storage — co-locate in SQLite if available, otherwise in-memory
  if (opts?.sqliteDb) {
    const { SqliteStorage } = await import('agent-inbox');
    mailStorage = new SqliteStorage({
      db: opts.sqliteDb,
      prefix: opts.sqlitePrefix ?? 'mail_',
    });
  } else {
    mailStorage = new InMemoryStorage();
  }

  // Event bus
  mailEvents = new EventEmitter();

  // Message router (for traceability auto-conversation creation)
  const router = new MessageRouter(mailStorage, mailEvents, 'default');

  // Traceability layer — auto-creates conversations/threads from message events
  new TraceabilityLayer(mailStorage, mailEvents);

  // JSON-RPC server — handles all mail/* methods
  mailJsonRpc = new MailJsonRpcServer(mailStorage, router, mailEvents);

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
