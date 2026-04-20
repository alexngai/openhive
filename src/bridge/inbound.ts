/**
 * Inbound Message Pipeline — NEUTRALIZED
 *
 * Originally translated platform messages (Slack, Discord, etc.) into
 * posts/comments inside a hive. The social layer was removed, so this
 * pipeline has no side effects now. Kept as an import target so the
 * BridgeManager subsystem still wires without rewrites; each message
 * short-circuits to `skipped`.
 *
 * If bridges are repurposed later (e.g. route platform messages into
 * swarm chat or mail conversations), this is the natural hook point.
 */

import type { InboundMessage } from './types.js';

export interface InboundResult {
  action: 'skipped';
  reason: string;
}

export function processInboundMessage(
  _bridgeId: string,
  _message: InboundMessage,
): InboundResult {
  return {
    action: 'skipped',
    reason: 'social_layer_removed',
  };
}
