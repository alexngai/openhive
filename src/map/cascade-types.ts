/**
 * MAP Cascade Protocol Types
 *
 * Server-side types for handling `x-cascade/*` JSON-RPC requests from agents.
 * Follows the MAP vendor-extension convention — runtimes embedding git-cascade
 * alongside a MAP connection forward emitted events verbatim; the hub
 * registers handlers under the same method names.
 *
 * This file is a thin re-export layer over `git-cascade/events` so the hub
 * and the runtime share one source of truth for method names and payload
 * shapes. Do not define duplicate types here.
 */

export {
  CASCADE_METHODS,
  CASCADE_METHOD_SET,
  CASCADE_METHOD_SUFFIXES,
  CASCADE_METHOD_SUFFIX_SET,
  DEFAULT_CASCADE_PREFIX,
  buildCascadeMethods,
  matchCascadeSuffix,
  type CascadeMethod,
  type CascadeMethodSuffix,
  type CascadeMethodMap,
  type CascadeSuffixMap,
  type CascadeEmitter,
  type StreamOpenedParams,
  type StreamCommittedParams,
  type StreamMergedParams,
  type StreamConflictedParams,
  type StreamAbandonedParams,
  type TaskRef,
  type EventMetadata,
} from 'git-cascade/events';

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
