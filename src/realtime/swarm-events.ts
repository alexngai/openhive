/**
 * Swarm Lifecycle Event Fan-Out
 *
 * Single fan-out helper for swarm-lifecycle WebSocket broadcasts. Replaces
 * the prior pattern where every emit site separately remembered to call
 * `broadcastToChannel` for both the fleet channel and the per-swarm
 * channel — a contract that produced multiple silent regressions where one
 * of the two was forgotten:
 *
 *   - `node_registered` broadcast on per-swarm only → picker missed it
 *     (frontend's `useSwarmRealtime` listens on `map:discovery`).
 *   - `node_registered` MAP-protocol path missed both channels entirely →
 *     macro-agent intra-swarm spawns invisible to the picker.
 *
 * Adding a new lifecycle event type now requires a single change here in
 * the union; every emitter automatically fans out correctly.
 *
 * Channels:
 *   - `map:discovery` — fleet-wide subscribers (chat picker, dashboard,
 *     stats summary, useSwarmRealtime invalidator).
 *   - `map:swarm:${swarmId}` — per-swarm subscribers (swarm detail page,
 *     per-swarm session list).
 *
 * Events that are intentionally per-swarm-only or carry a different shape
 * (e.g. hosted-swarm `swarm_spawned`/`swarm_stopped` from manager.ts which
 * may not have a MAP swarm_id at emit time, or `node_state_changed` which
 * fans out to per-swarm + global) continue calling `broadcastToChannel`
 * directly — those routes are correct and well-tested.
 */

import { broadcastToChannel } from './index.js';

export type SwarmLifecycleEventType =
  | 'swarm_registered'
  | 'swarm_offline'
  | 'swarm_heartbeat'
  | 'swarm.status_changed'
  | 'node_registered'
  | 'connection_degraded'
  | 'connection_recovered';

export interface SwarmLifecycleEvent {
  type: SwarmLifecycleEventType;
  data: Record<string, unknown>;
}

/**
 * Broadcast a swarm-lifecycle event to BOTH the fleet `map:discovery`
 * channel and the per-swarm `map:swarm:${swarmId}` channel. The same
 * event object is delivered to both — subscribers filter by interest.
 *
 * Callers should pass the actual MAP swarm id (the one used in
 * `map_swarms.id`), not a hosted-swarm id. The per-swarm channel
 * subscription pattern in the frontend matches against this exact id.
 */
export function broadcastSwarmLifecycleEvent(
  swarmId: string,
  event: SwarmLifecycleEvent,
): void {
  broadcastToChannel('map:discovery', event);
  broadcastToChannel(`map:swarm:${swarmId}`, event);
}
