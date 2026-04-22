/**
 * MAP Cascade Request Handler
 *
 * Handles `x-cascade/*` JSON-RPC requests emitted by git-cascade-backed
 * runtimes (macro-agent, future cc-swarm). Flow mirrors trajectory-handler:
 *
 *   1. Runtime emits `x-cascade/stream.*` via its MAP connection
 *   2. MAPServer routes to this handler (registered as additionalHandler)
 *   3. Handler upserts the stream projection row (idempotent), records the
 *      specific event (commit / merge / conflict / abandon) against it
 *   4. Emits via mapHubEvents for other hub consumers
 *   5. Broadcasts to WebSocket channels for the UI
 *   6. Returns an acknowledgement to the agent
 *
 * The hub is NOT authoritative for cascade state — runtimes own their local
 * `.git-cascade/tracker.db`. These projections are read-only lenses for
 * cross-swarm observability.
 */

import { CASCADE_METHODS, matchCascadeSuffix } from './cascade-types.js';
import type {
  CascadeEventAck,
  CascadeRequestContext,
  StreamOpenedParams,
  StreamCommittedParams,
  StreamMergedParams,
  StreamConflictedParams,
  StreamConflictResolvedParams,
  StreamAbandonedParams,
  StreamPausedParams,
  StreamResumedParams,
  StreamRolledBackParams,
  StreamPushedParams,
  CascadeRebasedParams,
  CascadeCompletedParams,
  QueueAddedParams,
  QueueReadyParams,
  QueueCancelledParams,
  QueueRemovedParams,
  TaskRef,
  EventMetadata,
} from './cascade-types.js';
import { CascadeRequestError } from './cascade-types.js';
import {
  upsertStream,
  ensureStreamRow,
  updateStreamStatus,
  recordCommit,
  recordMerge,
  recordConflict,
  recordCascadeOperation,
  markConflictResolved,
  recordPush,
  upsertQueueEntry,
  getStreamBySwarmAndId,
  type CascadeStream,
} from '../db/dal/cascade-streams.js';
import { broadcastToChannel } from '../realtime/index.js';
import { mapHubEvents } from './service.js';

// ============================================================================
// Entry point
// ============================================================================

/**
 * Dispatch an `x-cascade/*` method to its specific handler.
 */
export function handleCascadeRequest(
  method: string,
  params: unknown,
  context: CascadeRequestContext
): CascadeEventAck {
  const suffix = matchCascadeSuffix(method);
  switch (suffix) {
    case 'stream.opened':
      return handleStreamOpened(params as StreamOpenedParams, context);
    case 'stream.committed':
      return handleStreamCommitted(params as StreamCommittedParams, context);
    case 'stream.merged':
      return handleStreamMerged(params as StreamMergedParams, context);
    case 'stream.conflicted':
      return handleStreamConflicted(params as StreamConflictedParams, context);
    case 'stream.conflict_resolved':
      return handleStreamConflictResolved(
        params as StreamConflictResolvedParams,
        context
      );
    case 'stream.abandoned':
      return handleStreamAbandoned(params as StreamAbandonedParams, context);
    case 'stream.paused':
      return handleStreamPaused(params as StreamPausedParams, context);
    case 'stream.resumed':
      return handleStreamResumed(params as StreamResumedParams, context);
    case 'stream.rolled_back':
      return handleStreamRolledBack(params as StreamRolledBackParams, context);
    case 'stream.pushed':
      return handleStreamPushed(params as StreamPushedParams, context);
    case 'cascade.rebased':
      return handleCascadeRebased(params as CascadeRebasedParams, context);
    case 'cascade.completed':
      return handleCascadeCompleted(params as CascadeCompletedParams, context);
    case 'queue.added':
      return handleQueueEvent('queued', params as QueueAddedParams, context);
    case 'queue.ready':
      return handleQueueEvent('ready', params as QueueReadyParams, context);
    case 'queue.cancelled':
      return handleQueueEvent('cancelled', params as QueueCancelledParams, context);
    case 'queue.removed':
      return handleQueueEvent('removed', params as QueueRemovedParams, context);
    default:
      throw new CascadeRequestError(-32601, `Unknown cascade method: ${method}`);
  }
}

// ============================================================================
// stream.opened
// ============================================================================

function handleStreamOpened(
  params: StreamOpenedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.stream_id || typeof params.stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing stream_id');
  }
  if (!params.name || typeof params.name !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing name');
  }
  if (!params.agent_id || typeof params.agent_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing agent_id');
  }

  const taskRef = extractTaskRef(params.metadata);

  const { stream, created } = upsertStream({
    stream_id: params.stream_id,
    source_swarm_id: context.swarmId,
    source_agent_id: params.agent_id,
    name: params.name,
    branch_name: params.branch_name,
    base_commit: params.base_commit,
    parent_stream_id: params.parent_stream,
    is_local_mode: params.is_local_mode,
    task_resource_id: taskRef?.resource_id,
    task_node_id: taskRef?.node_id,
    metadata: params.metadata,
  });

  emitHubEvent('cascade_stream_opened', {
    source_swarm_id: context.swarmId,
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    name: stream.name,
    agent_id: stream.source_agent_id,
    parent_stream: stream.parent_stream_id,
    task_ref: taskRefFromStream(stream),
    created,
  });

  broadcast(stream, 'cascade:stream_opened', {
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    name: stream.name,
    agent_id: stream.source_agent_id,
    source_swarm_id: stream.source_swarm_id,
  });

  return { ok: true, stream_row_id: stream.id, created };
}

// ============================================================================
// stream.committed
// ============================================================================

function handleStreamCommitted(
  params: StreamCommittedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.stream_id || typeof params.stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing stream_id');
  }
  if (!params.commit_hash || typeof params.commit_hash !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing commit_hash');
  }

  const stream = ensureStreamRow(
    context.swarmId,
    params.stream_id,
    params.agent_id ?? context.agentId ?? 'unknown'
  );

  const taskRef = extractTaskRef(params.metadata);

  // Back-fill stream-level task_ref from the first committed event that
  // carries one — supports late binding when stream.opened didn't include it.
  if (taskRef && (!stream.task_resource_id || !stream.task_node_id)) {
    upsertStream({
      stream_id: stream.stream_id,
      source_swarm_id: stream.source_swarm_id,
      source_agent_id: stream.source_agent_id,
      name: stream.name,
      task_resource_id: taskRef.resource_id,
      task_node_id: taskRef.node_id,
    });
  }

  const { change, created } = recordCommit({
    stream_row_id: stream.id,
    commit_hash: params.commit_hash,
    change_id: params.change_id,
    parent_commit: params.parent_commit,
    author_agent_id: params.agent_id,
    message_summary: params.message_summary,
    files_touched: params.files_touched,
    task_resource_id: taskRef?.resource_id,
    task_node_id: taskRef?.node_id,
    metadata: params.metadata,
  });

  emitHubEvent('cascade_stream_committed', {
    source_swarm_id: context.swarmId,
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    change_row_id: change.id,
    commit_hash: change.commit_hash,
    change_id: change.change_id,
    agent_id: change.author_agent_id,
    files_touched: change.files_touched,
    task_ref: taskRef,
    created,
  });

  broadcast(stream, 'cascade:stream_committed', {
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    commit_hash: change.commit_hash,
    change_id: change.change_id,
    agent_id: change.author_agent_id,
    files_touched: change.files_touched,
    source_swarm_id: stream.source_swarm_id,
  });

  return { ok: true, stream_row_id: stream.id, created };
}

// ============================================================================
// stream.merged
// ============================================================================

function handleStreamMerged(
  params: StreamMergedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.source_stream_id || typeof params.source_stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing source_stream_id');
  }
  if (!params.target_stream_id || typeof params.target_stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing target_stream_id');
  }
  if (!params.merge_commit || typeof params.merge_commit !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing merge_commit');
  }

  // Source may be a stream or a worker branch. Detect via the explicit
  // strategy field set by tracker.completeTask ('task-merge'); fall back to
  // the legacy `worker/` / `worker:` prefix heuristic for callers that
  // don't populate strategy (older runtimes, manual mergeStream emissions).
  const isWorkerSource = params.strategy === 'task-merge' ||
    params.source_stream_id.startsWith('worker/') ||
    params.source_stream_id.startsWith('worker:');

  const sourceStream = isWorkerSource
    ? null
    : ensureStreamRow(
        context.swarmId,
        params.source_stream_id,
        params.agent_id ?? context.agentId ?? 'unknown'
      );

  const targetStream = ensureStreamRow(
    context.swarmId,
    params.target_stream_id,
    params.agent_id ?? context.agentId ?? 'unknown'
  );

  const { merge, created } = recordMerge({
    source_swarm_id: context.swarmId,
    source_stream_id: params.source_stream_id,
    target_stream_id: params.target_stream_id,
    source_stream_row_id: sourceStream?.id,
    target_stream_row_id: targetStream.id,
    merge_commit: params.merge_commit,
    agent_id: params.agent_id,
    strategy: params.strategy,
    source_commit: params.source_commit,
    metadata: params.metadata,
  });

  // Mark the source stream as merged (if we have one).
  if (sourceStream) {
    updateStreamStatus(sourceStream.id, 'merged', { closed: true });
  }

  // Resolve task_ref: prefer explicit metadata on the merge event; fall back
  // to source stream's persisted task_ref, then target stream's. This lets
  // the task-binder act on the event without re-querying the DB for the
  // common case, and matches the propagation contract the cascade-streams
  // schema already upholds.
  const taskRef =
    extractTaskRef(params.metadata) ??
    taskRefFromStream(sourceStream) ??
    taskRefFromStream(targetStream);

  emitHubEvent('cascade_stream_merged', {
    source_swarm_id: context.swarmId,
    merge_row_id: merge.id,
    source_stream_row_id: sourceStream?.id ?? null,
    target_stream_row_id: targetStream.id,
    source_stream_id: merge.source_stream_id,
    target_stream_id: merge.target_stream_id,
    merge_commit: merge.merge_commit,
    strategy: merge.strategy,
    agent_id: merge.agent_id,
    task_ref: taskRef,
    created,
  });

  broadcast(targetStream, 'cascade:stream_merged', {
    target_stream_row_id: targetStream.id,
    source_stream_id: merge.source_stream_id,
    target_stream_id: merge.target_stream_id,
    merge_commit: merge.merge_commit,
    strategy: merge.strategy,
    agent_id: merge.agent_id,
    source_swarm_id: targetStream.source_swarm_id,
  });

  return { ok: true, stream_row_id: targetStream.id, created };
}

// ============================================================================
// stream.conflicted
// ============================================================================

function handleStreamConflicted(
  params: StreamConflictedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.stream_id || typeof params.stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing stream_id');
  }
  if (!Array.isArray(params.conflicted_files)) {
    throw new CascadeRequestError(-32602, 'Invalid params: missing conflicted_files');
  }

  const stream = ensureStreamRow(
    context.swarmId,
    params.stream_id,
    params.agent_id ?? context.agentId ?? 'unknown'
  );

  const { conflict, created } = recordConflict({
    stream_row_id: stream.id,
    conflict_id: params.conflict_id,
    conflicted_files: params.conflicted_files,
    agent_id: params.agent_id,
    conflicting_commit: params.conflicting_commit,
    target_commit: params.target_commit,
    source: params.source,
    metadata: params.metadata,
  });

  updateStreamStatus(stream.id, 'conflicted');

  emitHubEvent('cascade_stream_conflicted', {
    source_swarm_id: context.swarmId,
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    conflict_row_id: conflict.id,
    conflict_id: conflict.conflict_id,
    conflicted_files: conflict.conflicted_files,
    source: conflict.source,
    agent_id: conflict.agent_id,
    created,
  });

  broadcast(stream, 'cascade:stream_conflicted', {
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    conflict_row_id: conflict.id,
    conflicted_files: conflict.conflicted_files,
    source: conflict.source,
    agent_id: conflict.agent_id,
    source_swarm_id: stream.source_swarm_id,
  });

  return { ok: true, stream_row_id: stream.id, created };
}

// ============================================================================
// stream.conflict_resolved
// ============================================================================
//
// Closes the loop opened by stream.conflicted: a recovery strategy or human
// resolved the conflict, so cascade_conflicts.status should move from
// pending → resolved. Also revives the stream's status if it was marked
// 'conflicted' (and isn't already terminal like merged/abandoned).

function handleStreamConflictResolved(
  params: StreamConflictResolvedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.stream_id || typeof params.stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing stream_id');
  }
  if (!params.conflict_id || typeof params.conflict_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing conflict_id');
  }
  if (!params.resolution_method || typeof params.resolution_method !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing resolution_method');
  }

  const updated = markConflictResolved({
    source_swarm_id: context.swarmId,
    stream_id: params.stream_id,
    conflict_id: params.conflict_id,
    resolution_method: params.resolution_method,
    resolved_by: params.resolved_by,
    resolution_summary: params.resolution_summary,
  });

  // Revive stream status if conflicted and no other open conflicts remain.
  const stream = getStreamBySwarmAndId(context.swarmId, params.stream_id);
  if (stream?.status === 'conflicted') {
    updateStreamStatus(stream.id, 'active');
  }

  emitHubEvent('cascade_stream_conflict_resolved', {
    source_swarm_id: context.swarmId,
    stream_row_id: stream?.id ?? null,
    stream_id: params.stream_id,
    conflict_id: params.conflict_id,
    resolution_method: params.resolution_method,
    resolved_by: params.resolved_by,
    resolution_summary: params.resolution_summary,
    matched_conflict: updated,
  });

  if (stream) {
    broadcast(stream, 'cascade:stream_conflict_resolved', {
      stream_row_id: stream.id,
      stream_id: params.stream_id,
      conflict_id: params.conflict_id,
      resolution_method: params.resolution_method,
      resolved_by: params.resolved_by,
      source_swarm_id: stream.source_swarm_id,
    });
  }

  return { ok: true, stream_row_id: stream?.id };
}

// ============================================================================
// stream.abandoned
// ============================================================================

function handleStreamAbandoned(
  params: StreamAbandonedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.stream_id || typeof params.stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing stream_id');
  }

  const existing = getStreamBySwarmAndId(context.swarmId, params.stream_id);
  // Auto-create a placeholder if the hub never saw stream.opened. Unusual
  // but not an error — surface it in the projection so operators can notice.
  const stream =
    existing ??
    ensureStreamRow(context.swarmId, params.stream_id, context.agentId ?? 'unknown');

  updateStreamStatus(stream.id, 'abandoned', { closed: true });

  emitHubEvent('cascade_stream_abandoned', {
    source_swarm_id: context.swarmId,
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    reason: params.reason,
    cascade: params.cascade,
  });

  broadcast(stream, 'cascade:stream_abandoned', {
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    reason: params.reason,
    source_swarm_id: stream.source_swarm_id,
  });

  return { ok: true, stream_row_id: stream.id, created: existing === null };
}

// ============================================================================
// cascade.rebased
// ============================================================================
//
// A dependent stream was successfully rebased during cascadeRebase. Each
// commit in new_commits is persisted via the same DAL path as a regular
// stream.committed event (idempotent on commit_hash), preserving the Phase 0
// commit-level projection invariants. A summary hub event + broadcast
// carries rebase attribution (triggered_by) so consumers can distinguish
// original commits from rebase-derived ones.

function handleCascadeRebased(
  params: CascadeRebasedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.stream_id || typeof params.stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing stream_id');
  }
  if (!Array.isArray(params.new_commits)) {
    throw new CascadeRequestError(-32602, 'Invalid params: missing new_commits');
  }

  const stream = ensureStreamRow(
    context.swarmId,
    params.stream_id,
    params.agent_id ?? context.agentId ?? 'unknown'
  );
  const taskRef = extractTaskRef(params.metadata);

  const recorded: Array<{ commit_hash: string; created: boolean }> = [];
  for (const c of params.new_commits) {
    if (!c || typeof c.commit_hash !== 'string') continue;
    const { change, created } = recordCommit({
      stream_row_id: stream.id,
      commit_hash: c.commit_hash,
      change_id: c.change_id,
      parent_commit: c.parent_commit,
      author_agent_id: params.agent_id,
      message_summary: c.message_summary,
      files_touched: c.files_touched ?? [],
      task_resource_id: taskRef?.resource_id,
      task_node_id: taskRef?.node_id,
      metadata: {
        cascade_rebased_from: params.triggered_by_stream_id,
        cascade_triggered_by_agent: params.triggered_by_agent_id,
      },
    });
    recorded.push({ commit_hash: change.commit_hash, created });
  }

  emitHubEvent('cascade_stream_rebased', {
    source_swarm_id: context.swarmId,
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    triggered_by_stream_id: params.triggered_by_stream_id,
    triggered_by_agent_id: params.triggered_by_agent_id,
    new_base_commit: params.new_base_commit,
    new_head: params.new_head,
    recorded_count: recorded.filter((r) => r.created).length,
    total_commits: recorded.length,
  });

  broadcast(stream, 'cascade:stream_rebased', {
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    triggered_by_stream_id: params.triggered_by_stream_id,
    new_head: params.new_head,
    recorded_count: recorded.filter((r) => r.created).length,
    total_commits: recorded.length,
    source_swarm_id: stream.source_swarm_id,
  });

  return { ok: true, stream_row_id: stream.id, created: false };
}

// ============================================================================
// cascade.completed
// ============================================================================
//
// Summary event for a cascadeRebase walk. Not persisted in Phase 1 — the
// per-stream projections already capture the durable state (updated streams
// have new commits; failed/conflicted streams have conflict rows). This
// handler's job is purely observability: notify hub consumers + broadcast
// to WS subscribers.

function handleCascadeCompleted(
  params: CascadeCompletedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.root_stream_id || typeof params.root_stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing root_stream_id');
  }
  if (!Array.isArray(params.updated_streams)) {
    throw new CascadeRequestError(-32602, 'Invalid params: missing updated_streams');
  }

  // Look up the root stream row if it exists (may not if the hub hasn't
  // seen stream.opened yet for some reason). Missing root is non-fatal —
  // we still record the audit row and broadcast the event.
  const rootStream = getStreamBySwarmAndId(context.swarmId, params.root_stream_id);

  // Persist to the cascade_operations audit log. Best-effort: if the write
  // fails (e.g., schema migration not applied), still emit + broadcast so
  // live consumers don't lose visibility.
  let operationId: string | undefined;
  try {
    const op = recordCascadeOperation({
      source_swarm_id: context.swarmId,
      root_stream_id: params.root_stream_id,
      root_stream_row_id: rootStream?.id,
      agent_id: params.agent_id,
      strategy: params.strategy,
      updated_streams: params.updated_streams,
      failed_streams: params.failed_streams ?? [],
      skipped_streams: params.skipped_streams ?? [],
      deferred_streams: params.deferred_streams,
      metadata: params.metadata,
    });
    operationId = op.id;
  } catch {
    // Non-critical for live observability.
  }

  const summary = {
    source_swarm_id: context.swarmId,
    operation_id: operationId,
    root_stream_id: params.root_stream_id,
    root_stream_row_id: rootStream?.id ?? null,
    agent_id: params.agent_id,
    strategy: params.strategy,
    updated_streams: params.updated_streams,
    failed_streams: params.failed_streams,
    skipped_streams: params.skipped_streams,
    deferred_streams: params.deferred_streams,
  };

  emitHubEvent('cascade_completed', summary);

  // Broadcast to the root stream's channel (when we know it), the swarm
  // channel, and global. No task_resource_id binding here since the event
  // is about a whole cascade walk, not a single task.
  try {
    const wsMessage = { type: 'cascade:completed' as const, data: summary };
    if (rootStream) {
      broadcastToChannel(`cascade:stream:${rootStream.id}`, wsMessage);
    }
    broadcastToChannel(`cascade:swarm:${context.swarmId}`, wsMessage);
    broadcastToChannel('global', wsMessage);
  } catch {
    // Non-critical
  }

  return { ok: true, stream_row_id: rootStream?.id };
}

// ============================================================================
// stream.paused
// ============================================================================

function handleStreamPaused(
  params: StreamPausedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.stream_id || typeof params.stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing stream_id');
  }

  const stream = ensureStreamRow(
    context.swarmId,
    params.stream_id,
    context.agentId ?? 'unknown'
  );

  updateStreamStatus(stream.id, 'paused');

  emitHubEvent('cascade_stream_paused', {
    source_swarm_id: context.swarmId,
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    reason: params.reason,
  });

  broadcast(stream, 'cascade:stream_paused', {
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    reason: params.reason,
    source_swarm_id: stream.source_swarm_id,
  });

  return { ok: true, stream_row_id: stream.id };
}

// ============================================================================
// stream.resumed
// ============================================================================

function handleStreamResumed(
  params: StreamResumedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.stream_id || typeof params.stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing stream_id');
  }

  const stream = ensureStreamRow(
    context.swarmId,
    params.stream_id,
    context.agentId ?? 'unknown'
  );

  updateStreamStatus(stream.id, 'active');

  emitHubEvent('cascade_stream_resumed', {
    source_swarm_id: context.swarmId,
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
  });

  broadcast(stream, 'cascade:stream_resumed', {
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    source_swarm_id: stream.source_swarm_id,
  });

  return { ok: true, stream_row_id: stream.id };
}

// ============================================================================
// stream.rolled_back
// ============================================================================
//
// Observability-only: no DB mutation beyond the broadcast. The tracker's
// operation log is authoritative for rollback state; the hub records the
// event for dashboards + realtime notification.

function handleStreamRolledBack(
  params: StreamRolledBackParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.stream_id || typeof params.stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing stream_id');
  }

  const stream = ensureStreamRow(
    context.swarmId,
    params.stream_id,
    context.agentId ?? 'unknown'
  );

  emitHubEvent('cascade_stream_rolled_back', {
    source_swarm_id: context.swarmId,
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    strategy: params.strategy,
    target: params.target,
    new_head: params.new_head,
  });

  broadcast(stream, 'cascade:stream_rolled_back', {
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    strategy: params.strategy,
    target: params.target,
    new_head: params.new_head,
    source_swarm_id: stream.source_swarm_id,
  });

  return { ok: true, stream_row_id: stream.id };
}

// ============================================================================
// stream.pushed (trunk-style push to a remote)
// ============================================================================

function handleStreamPushed(
  params: StreamPushedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.stream_id || typeof params.stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing stream_id');
  }
  if (!params.pushed_commit || typeof params.pushed_commit !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing pushed_commit');
  }
  if (!params.remote_ref || typeof params.remote_ref !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing remote_ref');
  }

  const stream = ensureStreamRow(
    context.swarmId,
    params.stream_id,
    params.agent_id ?? context.agentId ?? 'unknown'
  );

  const push = recordPush({
    source_swarm_id: context.swarmId,
    stream_row_id: stream.id,
    stream_id: params.stream_id,
    agent_id: params.agent_id,
    pushed_commit: params.pushed_commit,
    remote: params.remote ?? 'origin',
    remote_ref: params.remote_ref,
    strategy: params.strategy,
    metadata: params.metadata,
  });

  emitHubEvent('cascade_stream_pushed', {
    source_swarm_id: context.swarmId,
    push_row_id: push.id,
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    pushed_commit: push.pushed_commit,
    remote: push.remote,
    remote_ref: push.remote_ref,
    strategy: push.strategy,
    agent_id: push.agent_id,
  });

  broadcast(stream, 'cascade:stream_pushed', {
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    pushed_commit: push.pushed_commit,
    remote: push.remote,
    remote_ref: push.remote_ref,
    strategy: push.strategy,
    source_swarm_id: stream.source_swarm_id,
  });

  return { ok: true, stream_row_id: stream.id };
}

// ============================================================================
// queue.added / queue.ready / queue.cancelled / queue.removed
// ============================================================================

function handleQueueEvent(
  status: 'queued' | 'ready' | 'cancelled' | 'removed',
  params: QueueAddedParams | QueueReadyParams | QueueCancelledParams | QueueRemovedParams,
  context: CascadeRequestContext
): CascadeEventAck {
  if (!params?.entry_id || typeof params.entry_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing entry_id');
  }
  if (!params.stream_id || typeof params.stream_id !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing stream_id');
  }
  if (!params.target_branch || typeof params.target_branch !== 'string') {
    throw new CascadeRequestError(-32602, 'Invalid params: missing target_branch');
  }

  const stream = ensureStreamRow(
    context.swarmId,
    params.stream_id,
    context.agentId ?? 'unknown'
  );

  const entry = upsertQueueEntry({
    source_swarm_id: context.swarmId,
    entry_id: params.entry_id,
    stream_id: params.stream_id,
    stream_row_id: stream.id,
    target_branch: params.target_branch,
    status,
    reason: (params as QueueCancelledParams).reason,
    outcome: (params as QueueRemovedParams).outcome,
    metadata: params.metadata,
  });

  const eventName = `cascade_queue_${status}`;
  emitHubEvent(eventName, {
    source_swarm_id: context.swarmId,
    entry_row_id: entry.id,
    entry_id: entry.entry_id,
    stream_row_id: stream.id,
    stream_id: stream.stream_id,
    target_branch: entry.target_branch,
    status: entry.status,
  });

  const wsType = (`cascade:queue_${status}` as CascadeWSEventType);
  try {
    const wsMessage = {
      type: wsType,
      data: {
        entry_row_id: entry.id,
        entry_id: entry.entry_id,
        stream_row_id: stream.id,
        stream_id: stream.stream_id,
        target_branch: entry.target_branch,
        status: entry.status,
        source_swarm_id: stream.source_swarm_id,
      },
    } as const;
    broadcastToChannel(`cascade:swarm:${context.swarmId}`, wsMessage);
    broadcastToChannel('global', wsMessage);
  } catch {
    // Non-critical
  }

  return { ok: true, stream_row_id: stream.id };
}

// ============================================================================
// Helpers
// ============================================================================

function extractTaskRef(metadata: EventMetadata | undefined): TaskRef | undefined {
  if (!metadata) return undefined;
  const tr = metadata.task_ref as { resource_id?: unknown; node_id?: unknown } | undefined;
  if (!tr || typeof tr !== 'object') return undefined;
  if (typeof tr.resource_id !== 'string' || typeof tr.node_id !== 'string') return undefined;
  return { resource_id: tr.resource_id, node_id: tr.node_id };
}

function taskRefFromStream(stream: CascadeStream | null | undefined): TaskRef | undefined {
  if (!stream || !stream.task_resource_id || !stream.task_node_id) return undefined;
  return {
    resource_id: stream.task_resource_id,
    node_id: stream.task_node_id,
  };
}

function emitHubEvent(eventName: string, data: Record<string, unknown>): void {
  try {
    mapHubEvents.emit(eventName, data);
  } catch {
    // Non-critical — downstream listener failures shouldn't break projection.
  }
}

type CascadeWSEventType =
  | 'cascade:stream_opened'
  | 'cascade:stream_committed'
  | 'cascade:stream_merged'
  | 'cascade:stream_conflicted'
  | 'cascade:stream_conflict_resolved'
  | 'cascade:stream_abandoned'
  | 'cascade:stream_paused'
  | 'cascade:stream_resumed'
  | 'cascade:stream_rolled_back'
  | 'cascade:stream_rebased'
  | 'cascade:stream_pushed'
  | 'cascade:completed'
  | 'cascade:queue_queued'
  | 'cascade:queue_ready'
  | 'cascade:queue_cancelled'
  | 'cascade:queue_removed';

function broadcast(
  stream: CascadeStream,
  eventType: CascadeWSEventType,
  data: Record<string, unknown>
): void {
  try {
    const message = { type: eventType, data } as const;
    broadcastToChannel(`cascade:stream:${stream.id}`, message);
    broadcastToChannel(`cascade:swarm:${stream.source_swarm_id}`, message);
    broadcastToChannel('global', message);

    // If the stream is linked to a task, broadcast to the task's channel too
    // so task-detail views update in real time.
    if (stream.task_resource_id) {
      broadcastToChannel(`resource:task:${stream.task_resource_id}`, message);
    }
  } catch {
    // Non-critical — UI just won't update in realtime
  }
}

// Re-export method constants from the types layer so callers that need them
// (e.g., map-server-setup) don't have to import from both places.
export { CASCADE_METHODS };
