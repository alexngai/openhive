/**
 * Dispatch Thread Nudge — advisory push to the sidecar
 *
 * When a dispatch thread turn arrives, the hub sends an `x-dispatch/nudge`
 * MAP notification to the target swarm's sidecar. The sidecar sets a flag
 * that the `UserPromptSubmit` hook checks on each turn — injecting a hint
 * about pending dispatch thread messages if the flag is set.
 *
 * This is **advisory only** (see design spec D8). The primary wake
 * mechanism is `continuationPolicy`'s inbox check. The nudge reduces
 * latency in the happy path but is not a delivery guarantee.
 *
 * @see docs/design/dispatch-inbox-threads.md (Phase 7)
 */

import * as dispatchesDAL from '../db/dal/dispatches.js';
import { sendToSwarm } from '../map/sync-listener.js';

/**
 * Send an `x-dispatch/nudge` notification to the swarm currently
 * executing a dispatch. Best-effort — failures are silently ignored.
 *
 * @param dispatchId - The dispatch whose thread received a new turn
 * @param conversationId - The conversation that was posted to
 */
export function sendDispatchNudge(
  dispatchId: string,
  conversationId: string,
): void {
  try {
    const dispatch = dispatchesDAL.findDispatchById(dispatchId);
    if (!dispatch) return;

    const swarmId = dispatch.target_swarm_id;
    if (!swarmId) return;

    sendToSwarm(swarmId, {
      jsonrpc: '2.0',
      method: 'x-dispatch/nudge',
      params: {
        dispatch_id: dispatchId,
        conversation_id: conversationId,
      },
    });
  } catch {
    // Best effort — nudge is advisory
  }
}
