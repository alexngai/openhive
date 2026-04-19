/**
 * MAP Cascade Protocol Types
 *
 * Server-side types for handling `x-cascade/*` JSON-RPC requests from agents.
 * Follows the MAP vendor-extension convention — runtimes embedding git-cascade
 * alongside a MAP connection forward emitted events verbatim; the hub
 * registers handlers under the same method names.
 *
 * Most types re-export from `git-cascade` so the hub and the runtime share
 * one source of truth. The `STREAM_PAUSED`, `STREAM_RESUMED`, and
 * `STREAM_ROLLED_BACK` event names + payload types are defined locally
 * because they're hub-side extensions not yet shipped in the published
 * git-cascade package — replace these with re-exports once a future
 * git-cascade version exposes them upstream.
 */

import {
  CASCADE_METHODS as UPSTREAM_CASCADE_METHODS,
  CASCADE_METHOD_SUFFIXES as UPSTREAM_CASCADE_METHOD_SUFFIXES,
  CASCADE_METHOD_SET as UPSTREAM_CASCADE_METHOD_SET,
  CASCADE_METHOD_SUFFIX_SET as UPSTREAM_CASCADE_METHOD_SUFFIX_SET,
  DEFAULT_CASCADE_PREFIX,
} from 'git-cascade';

import { matchCascadeSuffix as upstreamMatchCascadeSuffix } from 'git-cascade';

export {
  DEFAULT_CASCADE_PREFIX,
  buildCascadeMethods,
  type CascadeMethodMap,
  type CascadeSuffixMap,
  type CascadeEmitter,
  type StreamOpenedParams,
  type StreamCommittedParams,
  type StreamMergedParams,
  type StreamConflictedParams,
  type StreamConflictResolvedParams,
  type StreamAbandonedParams,
  type StreamPushedParams,
  type CascadeRebasedParams,
  type CascadeRebasedCommit,
  type CascadeCompletedParams,
  type QueueAddedParams,
  type QueueReadyParams,
  type QueueCancelledParams,
  type QueueRemovedParams,
  type TaskRef,
  type EventMetadata,
} from 'git-cascade';

import type { EventMetadata } from 'git-cascade';

// ============================================================================
// Hub-side extensions to git-cascade events
//
// These method names + payload types haven't shipped in the published
// git-cascade package yet but are used by the hub's cascade handlers and
// tests. Defined locally so the hub typechecks without waiting for a new
// git-cascade release. When git-cascade ships them, replace these blocks
// with re-exports and delete this section.
// ============================================================================

export const STREAM_PAUSED_SUFFIX = 'stream.paused' as const;
export const STREAM_RESUMED_SUFFIX = 'stream.resumed' as const;
export const STREAM_ROLLED_BACK_SUFFIX = 'stream.rolled_back' as const;

/**
 * CASCADE_METHODS extended with hub-only suffixes. Use this in place of
 * the upstream `CASCADE_METHODS` for any code path that needs to handle
 * paused / resumed / rolled-back events.
 */
export const CASCADE_METHODS = {
  ...UPSTREAM_CASCADE_METHODS,
  STREAM_PAUSED: `${DEFAULT_CASCADE_PREFIX}/${STREAM_PAUSED_SUFFIX}` as const,
  STREAM_RESUMED: `${DEFAULT_CASCADE_PREFIX}/${STREAM_RESUMED_SUFFIX}` as const,
  STREAM_ROLLED_BACK: `${DEFAULT_CASCADE_PREFIX}/${STREAM_ROLLED_BACK_SUFFIX}` as const,
} as const;
export type CascadeMethod = (typeof CASCADE_METHODS)[keyof typeof CASCADE_METHODS];

export const CASCADE_METHOD_SUFFIXES = {
  ...UPSTREAM_CASCADE_METHOD_SUFFIXES,
  STREAM_PAUSED: STREAM_PAUSED_SUFFIX,
  STREAM_RESUMED: STREAM_RESUMED_SUFFIX,
  STREAM_ROLLED_BACK: STREAM_ROLLED_BACK_SUFFIX,
} as const;
export type CascadeMethodSuffix = (typeof CASCADE_METHOD_SUFFIXES)[keyof typeof CASCADE_METHOD_SUFFIXES];

export const CASCADE_METHOD_SET: ReadonlySet<string> = new Set([
  ...UPSTREAM_CASCADE_METHOD_SET,
  CASCADE_METHODS.STREAM_PAUSED,
  CASCADE_METHODS.STREAM_RESUMED,
  CASCADE_METHODS.STREAM_ROLLED_BACK,
]);

export const CASCADE_METHOD_SUFFIX_SET: ReadonlySet<string> = new Set([
  ...UPSTREAM_CASCADE_METHOD_SUFFIX_SET,
  STREAM_PAUSED_SUFFIX,
  STREAM_RESUMED_SUFFIX,
  STREAM_ROLLED_BACK_SUFFIX,
]);

/**
 * Fired when a stream is paused (operator decision or hub-driven hold).
 * Pause halts merge-queue progression and queue scheduling for the stream
 * but preserves all commits/state.
 */
export interface StreamPausedParams {
  stream_id: string;
  agent_id?: string;
  /** Free-text rationale supplied by the caller. */
  reason?: string;
  /** Caller metadata */
  metadata?: EventMetadata;
}

/** Fired when a paused stream is resumed and becomes mergeable again. */
export interface StreamResumedParams {
  stream_id: string;
  agent_id?: string;
  /** Caller metadata */
  metadata?: EventMetadata;
}

/**
 * Fired when a stream is rolled back to an earlier commit (drops one or
 * more commits from the head). Used for recovering from bad merges or
 * surgical revert flows.
 *
 * Field names match what the hub's cascade-handler emits / broadcasts:
 *   - `target`    — commit the stream was rolled back to (the rollback target)
 *   - `new_head`  — commit at HEAD after the rollback completes (may differ
 *                   from `target` if a revert commit was created on top)
 *   - `strategy`  — how the rollback was performed (`revert` | `reset` | etc.)
 */
export interface StreamRolledBackParams {
  stream_id: string;
  agent_id?: string;
  /** Commit the stream was rolled back to (the rollback target). */
  target: string;
  /** Commit at HEAD after the rollback (may equal target or be a revert). */
  new_head: string;
  /** Commit the stream was at before the rollback (old head). */
  previous_head?: string;
  /** Commits dropped by the rollback, in order from oldest to newest. */
  dropped_commits?: string[];
  /** Strategy used to perform the rollback (`revert`, `reset`, etc.). */
  strategy?: string;
  /** Free-text rationale supplied by the caller. */
  reason?: string;
  /** Caller metadata */
  metadata?: EventMetadata;
}

/**
 * Extended `matchCascadeSuffix` that also recognizes the hub-only
 * suffixes (`stream.paused`, `stream.resumed`, `stream.rolled_back`).
 * Use this in place of the upstream import so the dispatch switch in
 * `cascade-handler.ts` can narrow on the full extended union.
 */
export function matchCascadeSuffix(method: string): CascadeMethodSuffix | null {
  // Try upstream first — covers the standard suffixes.
  const upstream = upstreamMatchCascadeSuffix(method);
  if (upstream !== null) return upstream;
  // Fall through to the locally-defined extension suffixes.
  if (method.endsWith(`/${STREAM_PAUSED_SUFFIX}`)) return STREAM_PAUSED_SUFFIX;
  if (method.endsWith(`/${STREAM_RESUMED_SUFFIX}`)) return STREAM_RESUMED_SUFFIX;
  if (method.endsWith(`/${STREAM_ROLLED_BACK_SUFFIX}`)) return STREAM_ROLLED_BACK_SUFFIX;
  return null;
}

/** Context passed to cascade request handlers — identifies the source swarm. */
export interface CascadeRequestContext {
  /** Swarm that sent the event (resolved from MAP session metadata) */
  swarmId: string;
  /** Agent within the swarm that emitted the event */
  agentId: string;
}

/** Error raised by a cascade handler; transported as a JSON-RPC error to the caller. */
export class CascadeRequestError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
    this.name = 'CascadeRequestError';
  }
}

/** Standard response when a handler projects an event successfully. */
export interface CascadeEventAck {
  ok: true;
  /** The hub-local projection row id that was upserted */
  stream_row_id?: string;
  /** Whether the projection row was newly created on this event */
  created?: boolean;
}
