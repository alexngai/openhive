/**
 * Cascade Actions — hub→runtime command channel.
 *
 * Sends `x-cascade/request.*` JSON-RPC notifications to the connected
 * sidecar that owns a stream. The runtime receives these, executes the
 * corresponding git-cascade operation, and the resulting `x-cascade/stream.*`
 * event flows back through the normal projection pipeline.
 *
 * This is a fire-and-forget intent channel, not an RPC — the hub doesn't
 * wait for a response. The UI updates reactively via WS broadcast when
 * the runtime's event arrives.
 *
 * Supported actions:
 * - merge:   request mergeStream(source → parent or explicit target)
 * - abandon: request abandonStream
 * - pause:   request pauseStream
 * - resume:  request resumeStream
 * - resolve: request conflict resolution (strategy hint)
 */

import { getInbound } from './connection-registry.js';

export type CascadeAction = 'merge' | 'abandon' | 'pause' | 'resume' | 'resolve' | 'push' | 'commit';

export interface CascadeActionParams {
  /** The cascade stream_id (not the hub row id) */
  stream_id: string;
  /** Action-specific parameters */
  target_stream_id?: string;
  reason?: string;
  conflict_id?: string;
  strategy?: string;
  /** Push: remote name (default: origin) */
  remote?: string;
  /** Push: target ref (default: stream/<id>) */
  target_ref?: string;
  /** Commit: message */
  message?: string;
  /** Commit: metadata */
  metadata?: Record<string, unknown>;
}

export interface CascadeActionResult {
  sent: boolean;
  error?: string;
}

const ACTION_METHODS: Record<CascadeAction, string> = {
  merge: 'x-cascade/request.merge',
  abandon: 'x-cascade/request.abandon',
  pause: 'x-cascade/request.pause',
  resume: 'x-cascade/request.resume',
  resolve: 'x-cascade/request.resolve',
  push: 'x-cascade/request.push',
  commit: 'x-cascade/request.commit',
};

/**
 * Send a cascade action request to the runtime that owns the stream.
 *
 * @param swarmId - The source_swarm_id from the cascade_streams row
 * @param action - Which action to request
 * @param params - Action-specific parameters (stream_id is required)
 * @returns Whether the notification was sent successfully
 */
export function sendCascadeAction(
  swarmId: string,
  action: CascadeAction,
  params: CascadeActionParams,
): CascadeActionResult {
  const conn = getInbound(swarmId);
  if (!conn || conn.ws.readyState !== 1) {
    return {
      sent: false,
      error: `Swarm ${swarmId} is not connected`,
    };
  }

  const method = ACTION_METHODS[action];
  if (!method) {
    return { sent: false, error: `Unknown action: ${action}` };
  }

  const notification = {
    jsonrpc: '2.0',
    method,
    params,
  };

  try {
    conn.ws.send(JSON.stringify(notification));
    return { sent: true };
  } catch (err) {
    return {
      sent: false,
      error: `Failed to send: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
