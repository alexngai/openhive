/**
 * Dispatch Conversation Factory
 *
 * Lazily creates agent-inbox conversations for dispatch coordination threads.
 * Silent dispatches (no interaction needed) never create a conversation —
 * `ensureDispatchConversation` is only called on first message.
 *
 * Uses the `invokeMailMethod` pattern from mail-transport.ts and the
 * race-handling pattern from session-chat.ts.
 *
 * @see docs/design/dispatch-inbox-threads.md (Part 2–3)
 */

import type { MailJsonRpcServer } from 'agent-inbox';
import * as dispatchesDAL from '../db/dal/dispatches.js';
import { findResourceById, updateResource } from '../db/dal/syncable-resources.js';

/** Scope constant for dispatch coordination threads. */
export const DISPATCH_THREAD_SCOPE = 'dispatch-thread';

/** Scope constant for shared coordinated-team threads (P4.2). */
export const DISPATCH_TEAM_THREAD_SCOPE = 'dispatch-team-thread';

export interface DispatchConversationOpts {
  dispatchId: string;
  specId: string;
  specResourceId: string;
  specTitle: string;
  targetSwarmId: string;
  swarmName: string;
  linkedTasks: Array<{ resource_id: string; node_id: string }>;
  initiator: { type: 'user' | 'agent'; id: string };
  executorAgentId: string;
}

export interface DispatchConversationDeps {
  getMailJsonRpc: () => MailJsonRpcServer;
}

/**
 * In-flight creation mutex keyed by dispatchId. Prevents concurrent callers
 * (agent + user posting at the same instant) from creating duplicate
 * conversations. The first caller runs the create; others await the same
 * promise. Entries are cleaned up on settle.
 */
const inFlightCreations = new Map<string, Promise<string>>();

/**
 * Ensure a dispatch coordination thread exists, creating it lazily if needed.
 *
 * Idempotent:
 * 1. If `dispatches.conversation_id` is already set, returns it immediately.
 * 2. Concurrent calls for the same dispatchId share a single creation promise.
 * 3. `setDispatchConversationId` uses `WHERE conversation_id IS NULL` so
 *    first-writer wins in a race.
 *
 * Returns the conversation_id (deterministic: `dispatch-conv-${dispatchId}`).
 */
export async function ensureDispatchConversation(
  opts: DispatchConversationOpts,
  deps: DispatchConversationDeps,
): Promise<string> {
  // Fast path: already created
  const dispatch = dispatchesDAL.findDispatchById(opts.dispatchId);
  if (dispatch?.conversation_id) return dispatch.conversation_id;

  // Dedup concurrent callers
  const pending = inFlightCreations.get(opts.dispatchId);
  if (pending) return pending;

  const creation = createConversation(opts, deps);
  inFlightCreations.set(opts.dispatchId, creation);

  try {
    return await creation;
  } finally {
    inFlightCreations.delete(opts.dispatchId);
  }
}

async function createConversation(
  opts: DispatchConversationOpts,
  deps: DispatchConversationDeps,
): Promise<string> {
  const conversationId = `dispatch-conv-${opts.dispatchId}`;
  const jsonRpc = deps.getMailJsonRpc();

  // 1. Create the conversation
  await invokeMailMethod(jsonRpc, 'mail/create', {
    id: conversationId,
    scope: DISPATCH_THREAD_SCOPE,
    subject: `Dispatch: ${opts.specTitle} → ${opts.swarmName}`,
    metadata: {
      source: DISPATCH_THREAD_SCOPE,
      dispatch_id: opts.dispatchId,
      spec_id: opts.specId,
      spec_resource_id: opts.specResourceId,
      target_swarm_id: opts.targetSwarmId,
      linked_tasks: opts.linkedTasks,
      initiator: opts.initiator,
    },
  });

  // 2. Add participants
  await invokeMailMethod(jsonRpc, 'mail/invite', {
    conversationId,
    agentId: opts.initiator.id,
    role: 'initiator',
  });
  await invokeMailMethod(jsonRpc, 'mail/invite', {
    conversationId,
    agentId: opts.executorAgentId,
    role: 'executor',
  });

  // 3. Write back to dispatch row (first-writer wins)
  dispatchesDAL.setDispatchConversationId(opts.dispatchId, conversationId);

  // 4. Back-reference: append thread ref to each linked task resource so
  //    task consumers can discover associated dispatch threads.
  appendDispatchThreadRefs(opts.linkedTasks, opts.dispatchId, conversationId);

  // 5. Re-read to handle race: another caller may have written a different
  //    conversation_id between our check and our write (extremely unlikely
  //    with the in-flight mutex, but defensive).
  const updated = dispatchesDAL.findDispatchById(opts.dispatchId);
  return updated?.conversation_id ?? conversationId;
}

// ---------------------------------------------------------------------------
// Coordinated-team shared thread (P4.2)
// ---------------------------------------------------------------------------

export interface TeamConversationPeer {
  dispatch_id: string;
  target_swarm_id: string;
  swarm_name: string;
  role?: string | null;
}

export interface TeamConversationOpts {
  /** Deterministic shared id, generated once per fan-out batch. */
  teamConversationId: string;
  specId: string;
  specResourceId: string;
  specTitle: string;
  initiator: { type: 'user' | 'agent'; id: string };
  peers: TeamConversationPeer[];
}

/**
 * Eagerly create the shared coordination thread for a coordinated-team
 * dispatch batch. Unlike `ensureDispatchConversation` (lazy, per-dispatch),
 * this is created up front in the fan-out loop when the user opts into
 * coordinated mode, so every executor's prompt can advertise a real,
 * already-existing shared thread.
 *
 * Only the initiator is invited at creation — executor agent ids aren't
 * resolved until claim/delivery time. Executors join by posting (agent-inbox
 * auto-adds the sender), guided by the peer roster in their prompt. Idempotent
 * via agent-inbox's create-or-get semantics (0.2.5).
 */
export async function ensureTeamConversation(
  opts: TeamConversationOpts,
  deps: DispatchConversationDeps,
): Promise<string> {
  const jsonRpc = deps.getMailJsonRpc();
  const { teamConversationId } = opts;

  await invokeMailMethod(jsonRpc, 'mail/create', {
    id: teamConversationId,
    scope: DISPATCH_TEAM_THREAD_SCOPE,
    subject: `Team dispatch: ${opts.specTitle}`,
    metadata: {
      source: DISPATCH_TEAM_THREAD_SCOPE,
      spec_id: opts.specId,
      spec_resource_id: opts.specResourceId,
      initiator: opts.initiator,
      dispatch_ids: opts.peers.map((p) => p.dispatch_id),
      peers: opts.peers,
    },
  });

  await invokeMailMethod(jsonRpc, 'mail/invite', {
    conversationId: teamConversationId,
    agentId: opts.initiator.id,
    role: 'initiator',
  });

  return teamConversationId;
}

// ---------------------------------------------------------------------------
// Task back-reference writer
// ---------------------------------------------------------------------------

/**
 * Append a `{dispatch_id, conversation_id}` entry to each linked task
 * resource's `metadata.dispatch_threads[]`. Idempotent — skips entries
 * where the dispatch_id is already present.
 *
 * Best-effort: failures are logged but don't block conversation creation.
 */
function appendDispatchThreadRefs(
  linkedTasks: Array<{ resource_id: string; node_id: string }>,
  dispatchId: string,
  conversationId: string,
): void {
  for (const ref of linkedTasks) {
    try {
      const resource = findResourceById(ref.resource_id);
      if (!resource) continue;

      const meta = (resource.metadata ?? {}) as Record<string, unknown>;
      const existing = Array.isArray(meta.dispatch_threads)
        ? (meta.dispatch_threads as Array<{ dispatch_id: string; conversation_id: string }>)
        : [];

      // Idempotent: skip if already recorded
      if (existing.some((e) => e.dispatch_id === dispatchId)) continue;

      updateResource(ref.resource_id, {
        metadata: {
          ...meta,
          dispatch_threads: [
            ...existing,
            { dispatch_id: dispatchId, conversation_id: conversationId },
          ],
        },
      });
    } catch (err) {
      console.warn(
        `[dispatch-conversation] Failed to append thread ref to resource ${ref.resource_id}:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Mail RPC helper (same pattern as mail-transport.ts)
// ---------------------------------------------------------------------------

async function invokeMailMethod(
  jsonRpc: MailJsonRpcServer,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const id = `dispatch-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await jsonRpc.handleRequest({
    jsonrpc: '2.0',
    id,
    method,
    params,
  } as Parameters<MailJsonRpcServer['handleRequest']>[0]);
  if (response && typeof response === 'object' && 'error' in response && response.error) {
    const err = response.error as { message?: string; code?: number };
    throw new Error(err.message ?? `mail method ${method} failed (code ${err.code ?? -32000})`);
  }
  return (response as { result?: unknown })?.result;
}
