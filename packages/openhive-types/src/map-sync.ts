/**
 * MAP Sync Notifications (JSON-RPC 2.0)
 *
 * Wire format types for OpenHive sync notifications between swarms.
 * Uses JSON-RPC 2.0 notification semantics with x-openhive/ vendor prefix
 * per the MAP spec extension mechanism.
 *
 * These types define the contract between:
 *   - Swarm runtimes (emit sync after git push)
 *   - OpenHive hub (receives, bookkeeps, relays)
 *   - Subscribing swarms (receive relay, trigger git pull)
 */

/** JSON-RPC 2.0 method names for OpenHive sync notifications (x- vendor prefix per MAP spec) */
export type MapSyncMethod = 'x-openhive/memory.sync' | 'x-openhive/skill.sync';

/** Set of valid sync method names for fast validation */
export const SYNC_METHODS: Set<string> = new Set<string>([
  'x-openhive/memory.sync',
  'x-openhive/skill.sync',
]);

/** Parameters carried in an OpenHive sync notification */
export interface MapSyncParams {
  /** The syncable_resources ID identifying which memory bank or skill repo changed */
  resource_id: string;
  /** The agent who pushed the change */
  agent_id: string;
  /** The git commit hash that was pushed */
  commit_hash: string;
  /** ISO 8601 timestamp of when the push occurred */
  timestamp: string;
}

/**
 * MAP sync notification emitted by swarms when memory or skill resources are pushed to git.
 * Structurally compatible with MAP's MAPNotificationBase<MapSyncParams>.
 * No `id` field = fire-and-forget notification (JSON-RPC 2.0 semantics).
 * Missed messages are recovered via polling.
 */
export interface MapSyncMessage {
  jsonrpc: '2.0';
  method: MapSyncMethod;
  params: MapSyncParams;
}

/** Maps sync method names to their corresponding resource types */
export const SYNC_MESSAGE_RESOURCE_TYPE: Record<MapSyncMethod, 'memory_bank' | 'skill'> = {
  'x-openhive/memory.sync': 'memory_bank',
  'x-openhive/skill.sync': 'skill',
};

/** Create a well-formed sync notification */
export function createSyncNotification(
  method: MapSyncMethod,
  params: MapSyncParams,
): MapSyncMessage {
  return { jsonrpc: '2.0', method, params };
}
