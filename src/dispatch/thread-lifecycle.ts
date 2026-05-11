/**
 * Dispatch thread lifecycle binder.
 *
 * Subscribes to `mapHubEvents.task_status_changed` and manages the
 * lifecycle of dispatch coordination threads linked to tasks:
 *
 *   - Task reaches terminal status (completed/closed/done/failed/cancelled)
 *     → close linked dispatch threads via `mail/close`
 *   - Task reopened (terminal → open/in_progress)
 *     → reopen linked threads via `mail/reopen`
 *
 * Sits alongside the cascade task-binder on the same event surface.
 * The cascade binder decides whether to auto-close the *task*; this
 * binder manages the *conversation* lifecycle that follows.
 *
 * Also provides a TTL-based sweep for orphaned threads (conversations
 * whose last update is older than a configurable threshold and whose
 * linked dispatches are no longer running).
 */

import { mapHubEvents } from '../map/service.js';
import { findResourceById } from '../db/dal/syncable-resources.js';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import { getMailJsonRpc, getMailStorage } from '../mail/index.js';
import type { MailJsonRpcServer } from 'agent-inbox';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskStatusChangedEvent {
  task_id: string;
  status: string;
  previous?: string;
  resource_id?: string;
  node_id?: string;
  cascade?: unknown;
}

interface DispatchThreadRef {
  dispatch_id: string;
  conversation_id: string;
}

export interface ThreadLifecycleDeps {
  /**
   * TTL in milliseconds for orphaned thread sweep. Conversations with no
   * activity past this threshold and no running dispatches are archived.
   * Default: 30 days.
   */
  orphanTtlMs?: number;
  /**
   * Sweep interval in milliseconds. Default: 6 hours.
   */
  sweepIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set([
  'completed',
  'closed',
  'done',
  'failed',
  'cancelled',
]);

const REOPEN_STATUSES = new Set([
  'open',
  'in_progress',
]);

const DEFAULT_ORPHAN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;    // 6 hours
const DISPATCH_THREAD_SCOPE = 'dispatch-thread';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let activeHandler: ((event: TaskStatusChangedEvent) => void) | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Begin listening for task status changes that affect dispatch threads.
 * Idempotent — calling twice replaces the first listener.
 */
export function startThreadLifecycle(deps: ThreadLifecycleDeps = {}): void {
  stopThreadLifecycle();

  const handler = (eventData: unknown) => {
    void handleTaskStatusChanged(eventData as TaskStatusChangedEvent).catch(() => {
      // Best-effort — never throw into mapHubEvents.
    });
  };
  activeHandler = handler;
  mapHubEvents.on('task_status_changed', handler);

  // Start orphaned thread sweep
  const sweepInterval = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const orphanTtl = deps.orphanTtlMs ?? DEFAULT_ORPHAN_TTL_MS;
  sweepTimer = setInterval(() => {
    void sweepOrphanedThreads(orphanTtl).catch(() => {});
  }, sweepInterval);
}

/** Stop listening and cancel sweep timer. Safe to call when not started. */
export function stopThreadLifecycle(): void {
  if (activeHandler) {
    mapHubEvents.off('task_status_changed', activeHandler);
    activeHandler = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

/** Exported for tests. */
export async function handleTaskStatusChanged(
  event: TaskStatusChangedEvent,
): Promise<void> {
  if (!event.resource_id) return;

  const resource = findResourceById(event.resource_id);
  if (!resource) return;

  const meta = (resource.metadata ?? {}) as Record<string, unknown>;
  const threadRefs = Array.isArray(meta.dispatch_threads)
    ? (meta.dispatch_threads as DispatchThreadRef[])
    : [];
  if (threadRefs.length === 0) return;

  // Determine action based on status transition
  if (TERMINAL_STATUSES.has(event.status)) {
    // Close all linked dispatch threads
    for (const ref of threadRefs) {
      await closeThread(ref.conversation_id);
    }
  } else if (
    REOPEN_STATUSES.has(event.status) &&
    event.previous &&
    TERMINAL_STATUSES.has(event.previous)
  ) {
    // Reopen threads when task moves from terminal → active
    for (const ref of threadRefs) {
      await reopenThread(ref.conversation_id);
    }
  }
}

// ---------------------------------------------------------------------------
// Thread operations
// ---------------------------------------------------------------------------

async function closeThread(conversationId: string): Promise<void> {
  try {
    const mailRpc = getMailJsonRpc();
    await invokeMailMethod(mailRpc, 'mail/close', { id: conversationId });
  } catch {
    // Best effort — conversation may already be closed or not exist.
  }
}

async function reopenThread(conversationId: string): Promise<void> {
  try {
    const mailRpc = getMailJsonRpc();
    await invokeMailMethod(mailRpc, 'mail/reopen', { id: conversationId });
  } catch {
    // Best effort — conversation may already be active or not exist.
  }
}

// ---------------------------------------------------------------------------
// Orphaned thread sweep
// ---------------------------------------------------------------------------

/**
 * Sweep dispatch-thread conversations that are stale and have no running
 * dispatches. Closes them to prevent indefinite accumulation.
 *
 * Exported for tests.
 */
export async function sweepOrphanedThreads(ttlMs: number): Promise<number> {
  let closed = 0;
  try {
    const storage = getMailStorage();
    const conversations = storage.listConversations(DISPATCH_THREAD_SCOPE);
    const now = Date.now();

    for (const conv of conversations) {
      if (conv.status !== 'active') continue;

      const lastActivity = new Date(conv.updated_at).getTime();
      if (now - lastActivity < ttlMs) continue;

      // Check if any linked dispatch is still running
      const meta = (conv.metadata ?? {}) as Record<string, unknown>;
      const dispatchId = meta.dispatch_id as string | undefined;
      if (dispatchId) {
        const dispatch = dispatchesDAL.findDispatchById(dispatchId);
        if (dispatch && dispatch.status === 'running') continue;
      }

      await closeThread(conv.id);
      closed++;
    }
  } catch {
    // Sweep is best-effort.
  }
  return closed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function invokeMailMethod(
  mailRpc: MailJsonRpcServer,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return mailRpc.handleRequest({
    jsonrpc: '2.0',
    id: `thread-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    method,
    params,
  } as Parameters<MailJsonRpcServer['handleRequest']>[0]);
}
