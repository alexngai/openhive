/**
 * Spec Conversation Factory
 *
 * Lazily creates an agent-inbox mail conversation bound to a spec so the
 * spec page can host a discussion. Mirrors `ensureDispatchConversation`
 * (`src/dispatch/dispatch-conversation.ts`) but keyed on the spec's
 * `(resourceId, specId)` identity instead of a dispatch row.
 *
 * Specs are OpenTasks graph nodes, not hub rows, so there is nowhere
 * hub-side to persist a `conversation_id`. Instead the conversation id is
 * **deterministic** — derived from `(resourceId, specId)` — so create is
 * idempotent and resolution needs no persistence or daemon round-trip.
 *
 * @see docs/design/north-star-flows-p3-plan.md (P3.1)
 */

import type { MailJsonRpcServer, Storage } from 'agent-inbox';

/** Scope constant for spec discussion threads. */
export const SPEC_THREAD_SCOPE = 'spec-thread';

/**
 * Deterministic conversation id for a spec's discussion thread. agent-inbox
 * accepts arbitrary id strings and storage is parameterized SQL, so the
 * `:`-delimited shape is safe.
 */
export function specThreadConversationId(resourceId: string, specId: string): string {
  return `spec-thread:${resourceId}:${specId}`;
}

export interface SpecConversationOpts {
  resourceId: string;
  specId: string;
  specTitle: string;
  /** Agent to add as the initiating participant (the creator). Optional. */
  initiatorAgentId?: string;
}

export interface SpecConversationDeps {
  getMailJsonRpc: () => MailJsonRpcServer;
  getMailStorage: () => Storage;
}

/**
 * In-flight creation mutex keyed by conversation id. Prevents concurrent
 * callers from racing the create. Belt-and-suspenders alongside agent-inbox
 * 0.2.5's create-or-get semantics (`mail/create` returns the existing
 * conversation when the id already exists rather than overwriting it).
 */
const inFlightCreations = new Map<string, Promise<string>>();

/**
 * Ensure a spec discussion thread exists, creating it lazily if needed.
 * Returns the deterministic conversation id.
 */
export async function ensureSpecConversation(
  opts: SpecConversationOpts,
  deps: SpecConversationDeps,
): Promise<string> {
  const conversationId = specThreadConversationId(opts.resourceId, opts.specId);

  // Fast path: already created.
  if (deps.getMailStorage().getConversation(conversationId)) {
    return conversationId;
  }

  // Dedup concurrent callers.
  const pending = inFlightCreations.get(conversationId);
  if (pending) return pending;

  const creation = createConversation(conversationId, opts, deps);
  inFlightCreations.set(conversationId, creation);
  try {
    return await creation;
  } finally {
    inFlightCreations.delete(conversationId);
  }
}

async function createConversation(
  conversationId: string,
  opts: SpecConversationOpts,
  deps: SpecConversationDeps,
): Promise<string> {
  const jsonRpc = deps.getMailJsonRpc();

  // Create-or-get (idempotent in agent-inbox >=0.2.5).
  await invokeMailMethod(jsonRpc, 'mail/create', {
    id: conversationId,
    scope: SPEC_THREAD_SCOPE,
    subject: `Spec: ${opts.specTitle || 'Untitled spec'}`,
    metadata: {
      source: SPEC_THREAD_SCOPE,
      spec_id: opts.specId,
      spec_resource_id: opts.resourceId,
      spec_title: opts.specTitle,
    },
  });

  // Add the creator as a participant so they show in the roster immediately.
  // `mail/invite` is a silent no-op when already a member.
  if (opts.initiatorAgentId) {
    await invokeMailMethod(jsonRpc, 'mail/invite', {
      conversationId,
      agentId: opts.initiatorAgentId,
      role: 'owner',
    });
  }

  return conversationId;
}

/** Author id for hub-posted system turns (matches the dispatch retry turn). */
export const SPEC_THREAD_SYSTEM_AUTHOR = 'system:dispatch-orchestrator';

export interface SpecOutcomeTurnOpts {
  resourceId: string;
  specId: string;
  dispatchId: string;
  /** Terminal outcome to narrate. */
  outcome: 'complete' | 'failed' | 'dead';
  /** Human-readable swarm name (falls back to the swarm id). */
  swarmName?: string;
  /** One-line summary (on complete) or error (on failure). */
  detail?: string;
  /**
   * Narrative flavor (P5.4). `validation` reads the turn as a reviewer verdict
   * ("Validation by <swarm> …") rather than a generic dispatch outcome, so a
   * reviewer-role re-dispatch (P5.3) narrates as a review in the spec thread.
   */
  kind?: 'dispatch' | 'validation';
}

/**
 * Post a `system:dispatch-orchestrator` outcome turn into a spec's discussion
 * thread — **only if that thread already exists** (never creates one). Returns
 * true if a turn was posted, false if there was no thread to post to.
 *
 * This makes the spec page accumulate the work narrative automatically without
 * the hub authoring anything into a silent (never-opened) discussion.
 */
export async function postSpecThreadOutcome(
  opts: SpecOutcomeTurnOpts,
  deps: SpecConversationDeps,
): Promise<boolean> {
  const conversationId = specThreadConversationId(opts.resourceId, opts.specId);
  const conv = deps.getMailStorage().getConversation(conversationId);
  if (!conv) return false; // no discussion opened → stay silent

  const swarm = opts.swarmName || 'swarm';
  const isValidation = opts.kind === 'validation';
  const verb =
    opts.outcome === 'complete' ? 'completed' : opts.outcome === 'dead' ? 'died' : 'failed';
  const lead = isValidation ? `Validation by ${swarm} ${verb}.` : `Dispatch to ${swarm} ${verb}.`;
  const parts = [lead];
  if (opts.detail && opts.detail.trim()) parts.push(opts.detail.trim());
  parts.push(`See /dispatch/${opts.dispatchId}`);
  const content = parts.join(' ');

  try {
    await invokeMailMethod(deps.getMailJsonRpc(), 'mail/turn', {
      conversationId,
      participantId: SPEC_THREAD_SYSTEM_AUTHOR,
      content,
      contentType: 'text',
      importance: 'normal',
      metadata: {
        system: true,
        dispatch_id: opts.dispatchId,
        outcome: opts.outcome,
        kind: opts.kind ?? 'dispatch',
      },
    });
    return true;
  } catch {
    // best effort — a failed narrative turn must never break dispatch finalize
    return false;
  }
}

async function invokeMailMethod(
  jsonRpc: MailJsonRpcServer,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const id = `spec-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
