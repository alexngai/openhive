/**
 * OpenHive Session Sync Notification (JSON-RPC 2.0)
 *
 * Defines how OpenHive wraps sessionlog checkpoint data in a MAP
 * trajectory/checkpoint notification for hub-to-swarm sync.
 *
 * Checkpoint metadata types (SessionSyncCheckpoint, etc.) are defined in
 * the sessionlog package. Trajectory content wire types are defined in
 * @multi-agent-protocol/sdk.
 */

import type { MapSyncParams } from './map-sync.js';

// ============================================================================
// Session Sync Notification (swarm → hub)
// ============================================================================

/**
 * Extended sync params for session notifications.
 * Carries the base sync fields (resource_id, agent_id, commit_hash, timestamp)
 * plus inline checkpoint metadata.
 *
 * The `checkpoint` value should conform to sessionlog's `SessionSyncCheckpoint`
 * type. Import it from the `sessionlog` package for full typing.
 */
export interface SessionSyncParams extends MapSyncParams {
  /** Inline checkpoint metadata (see sessionlog's SessionSyncCheckpoint) */
  checkpoint: Record<string, unknown>;
}

/** Session sync notification message (swarm → hub) — uses MAP trajectory/checkpoint method */
export interface SessionSyncMessage {
  jsonrpc: '2.0';
  method: 'trajectory/checkpoint';
  params: SessionSyncParams;
}

/** Create a well-formed session sync notification */
export function createSessionSyncNotification(
  params: SessionSyncParams,
): SessionSyncMessage {
  return { jsonrpc: '2.0', method: 'trajectory/checkpoint', params };
}

// ============================================================================
// Constants
// ============================================================================

/** Method name for session sync notifications (MAP: trajectory/checkpoint) */
export const SESSION_SYNC_METHOD = 'trajectory/checkpoint' as const;
