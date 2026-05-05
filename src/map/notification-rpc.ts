/**
 * Notification-pair RPC — OpenHive-bound singleton over the
 * swarm-dispatch generic registry.
 *
 * The library-level helper lives in `swarm-dispatch/client/notification-rpc.ts`
 * (transport-agnostic). This module wires a process-singleton registry
 * to OpenHive's `sendToSwarm` so existing callers don't need to thread
 * a registry through and so legacy free-function signatures
 * (`callViaNotificationPair(swarmId, method, params)`) keep working.
 *
 * Errors and types are re-exported directly from swarm-dispatch — same
 * classes, no fork. Imports of `NotificationPairTransportLost` /
 * `NotificationPairRemoteError` continue to work unchanged.
 *
 * Used today for `dispatch/spawn-agent` (legacy) and
 * `x-dispatch/spawn-agent` (canonical) — see openhive-runtime's
 * resolveTarget.
 */

import {
  createNotificationPairRegistry,
  type NotificationPairRegistry,
} from 'swarm-dispatch/client';
import { sendToSwarm } from './sync-listener.js';

export {
  NotificationPairTransportLost,
  NotificationPairRemoteError,
} from 'swarm-dispatch/client';

/**
 * Process-singleton registry used by the wrapper helpers below. Exposed
 * (via `getOpenHiveNotificationPairRegistry`) so callers wanting the
 * library-shaped API directly (e.g., `callSpawnAgent(registry, ...)`)
 * can reach the OpenHive-bound instance.
 */
const registry: NotificationPairRegistry = createNotificationPairRegistry({
  sendNotification(target, method, params) {
    return sendToSwarm(target, {
      jsonrpc: '2.0',
      method,
      params,
    });
  },
});

/**
 * Get the OpenHive-bound notification-pair registry singleton.
 * Most callers should use the legacy free-function exports below; this
 * is for code paths that prefer the library's typed API directly
 * (e.g., `callSpawnAgent(registry, swarmId, req)`).
 */
export function getOpenHiveNotificationPairRegistry(): NotificationPairRegistry {
  return registry;
}

/**
 * Send a request notification to a swarm and wait for the matching
 * response notification. Resolves with `result`, rejects with `error`
 * or timeout. Wraps the swarm-dispatch registry's `call()` with the
 * existing OpenHive signature.
 */
export async function callViaNotificationPair<TParams, TResult>(
  swarmId: string,
  method: string,
  params: TParams,
  opts: { timeoutMs?: number } = {},
): Promise<TResult> {
  return registry.call<TParams, TResult>(swarmId, method, params, opts);
}

/**
 * Resolve a pending notification-pair call when the swarm sends back
 * `<method>.response`. Called by ws-map's notification dispatcher.
 */
export function handleNotificationPairResponse(params: unknown): void {
  registry.handleResponse(params);
}

/**
 * Reject all pending notification-pair calls targeting a specific swarm.
 * Called when the swarm's WebSocket disconnects so callers fail fast.
 */
export function rejectPendingForSwarm(
  swarmId: string,
  reason = 'swarm disconnected',
): void {
  registry.rejectPendingForTarget(swarmId, reason);
}

/**
 * Test helper — clear all pending calls. Used by test fixtures to avoid
 * cross-test bleed.
 */
export function _clearPendingNotificationPairCallsForTest(): void {
  registry._clearForTest();
}
